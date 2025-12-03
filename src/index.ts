#!/usr/bin/env node

// IMPORTANT: Suppress ALL stdout logging for MCP compatibility
// MCP servers must only output JSON-RPC messages to stdout

// Set environment variables to suppress Crawlee/Apify logging
process.env.CRAWLEE_LOG_LEVEL = 'OFF';
process.env.APIFY_LOG_LEVEL = 'OFF';

// Import and suppress Crawlee logging
import { log, Configuration } from 'crawlee';
log.setLevel(log.LEVELS.OFF);

// Configure Crawlee to be silent
Configuration.getGlobalConfig().set('logLevel', 'OFF');

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError
} from '@modelcontextprotocol/sdk/types.js';
import { DocumentStore } from './storage/storage.js';
import { FastEmbeddings } from './embeddings/fastembed.js';
import { WebDocumentProcessor } from './processor/processor.js';
import { IndexingStatusTracker } from './indexing/status.js';
import { IndexingQueueManager } from './indexing/queue-manager.js';
import { DocsConfig, loadConfig, isValidUrl, normalizeUrl } from './config.js';
import { DocsCrawler } from './crawler/docs-crawler.js';
import { fetchFavicon } from './util/favicon.js';
import { DocumentChunk, IndexingStatus } from './types.js';
import { generateDocId } from './util/docs.js';
import { logger } from './util/logger.js';

/** Progress token type from MCP spec */
type ProgressToken = string | number;

class WebDocsServer {
  private server: Server;
  private config!: DocsConfig;
  private store!: DocumentStore;
  private processor!: WebDocumentProcessor;
  private statusTracker: IndexingStatusTracker;
  private indexingQueue: IndexingQueueManager;
  /** Maps operation ID to progress token for MCP notifications */
  private progressTokens: Map<string, ProgressToken> = new Map();
  /** Tracks last notified progress to throttle notifications */
  private lastNotifiedProgress: Map<string, number> = new Map();

  constructor() {
    // Initialize basic components that don't need async initialization
    this.statusTracker = new IndexingStatusTracker();
    this.indexingQueue = new IndexingQueueManager();

    // Set up status change listener for MCP progress notifications
    this.statusTracker.addStatusListener((status) => {
      this.sendProgressNotification(status);
    });

    // Initialize MCP server
    this.server = new Server(
      {
        name: 'mcp-web-docs',
        version: '1.0.0'
      },
      {
        capabilities: {
          tools: {}
        }
      }
    );

    // Set up tool handlers
    this.setupToolHandlers();

    // Handle errors
    this.server.onerror = (error) => logger.error('[MCP Error]', error);
  }

  /**
   * Send MCP progress notification to client.
   * Only sends if the client provided a progressToken in the original request.
   * Throttled to avoid flooding - sends on 5% increments or status changes.
   */
  private async sendProgressNotification(status: IndexingStatus): Promise<void> {
    const progressToken = this.progressTokens.get(status.id);

    // Only send if we have a progress token from the client
    if (!progressToken) {
      logger.debug(`[Progress] No token for ${status.id}, skipping notification`);
      return;
    }

    const progressPercent = Math.round(status.progress * 100);
    const lastProgress = this.lastNotifiedProgress.get(status.id) ?? -1;

    // Only notify on significant progress (5% increments) or status changes
    const isStatusChange = status.status === 'complete' || status.status === 'failed' || status.status === 'cancelled';
    const isSignificantProgress = progressPercent - lastProgress >= 5;

    if (!isStatusChange && !isSignificantProgress) {
      return;
    }

    this.lastNotifiedProgress.set(status.id, progressPercent);

    // Build human-readable message
    let message = status.description;
    if (status.pagesProcessed !== undefined && status.pagesFound !== undefined) {
      message = `${status.description} (${status.pagesProcessed}/${status.pagesFound} pages)`;
    }

    try {
      // Send MCP progress notification per spec:
      // https://modelcontextprotocol.io/specification/2025-03-26/basic/utilities/progress
      await this.server.notification({
        method: 'notifications/progress',
        params: {
          progressToken,
          progress: progressPercent,
          total: 100,
          message
        }
      });

      logger.info(`[Progress] Sent notification: ${progressPercent}% - ${message}`);
    } catch (error) {
      logger.debug(`[Progress] Failed to send notification:`, error);
    }

    // Clean up tracking for completed operations
    if (isStatusChange) {
      this.lastNotifiedProgress.delete(status.id);
      this.progressTokens.delete(status.id);
    }
  }

  private async initialize() {
    // Load configuration
    this.config = await loadConfig();

    // Initialize components that need config
    const embeddings = new FastEmbeddings();
    this.store = new DocumentStore(
      this.config.dbPath,
      this.config.vectorDbPath,
      embeddings,
      this.config.cacheSize
    );
    this.processor = new WebDocumentProcessor(embeddings, this.config.maxChunkSize);

    // Initialize storage
    await this.store.initialize();
  }

  private setupToolHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'add_documentation',
          description: 'Add new documentation site for indexing',
          inputSchema: {
            type: 'object',
            properties: {
              url: {
                type: 'string',
                description: 'URL of the documentation site'
              },
              title: {
                type: 'string',
                description: 'Optional title for the documentation'
              }
            },
            required: ['url']
          }
        },
        {
          name: 'list_documentation',
          description: 'List all indexed documentation sites',
          inputSchema: {
            type: 'object',
            properties: {}
          }
        },
        {
          name: 'search_documentation',
          description: `Search through indexed documentation using hybrid search (full-text + semantic).

## Query Tips for Best Results

1. **Be specific** - Include unique terms from what you're looking for
   - Instead of: "Button props"
   - Try: "Button props onClick disabled loading"

2. **Use exact phrases** - Wrap in quotes for exact matching
   - "authentication middleware" finds that exact phrase
   - authentication middleware finds pages with either word

3. **Include context** - Add related terms to narrow results
   - API docs: "GET /users endpoint authentication headers"
   - Config: "webpack config entry output plugins"
   - Functions: "parseJSON function parameters return type"

4. **Combine concepts** - More terms = more precise results
   - "Card component status primary negative props table"
   - "database connection pool maxConnections timeout"

## How Search Works
- Full-text search with stemming (run → runs, running)
- Fuzzy matching for typos (authetication → authentication)
- Semantic similarity for conceptual matches
- Results ranked by relevance combining all signals`,
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Search query - be specific and include unique terms. Use quotes for exact phrases. Example: "Card component props headline status" or "REST API authentication Bearer token"'
              },
              limit: {
                type: 'number',
                description: 'Maximum number of results (default: 10)'
              }
            },
            required: ['query']
          }
        },
        {
          name: 'reindex_documentation',
          description: 'Re-index a specific documentation site',
          inputSchema: {
            type: 'object',
            properties: {
              url: {
                type: 'string',
                description: 'URL of the documentation to re-index'
              }
            },
            required: ['url']
          }
        },
        {
          name: 'get_indexing_status',
          description: 'Get current indexing status',
          inputSchema: {
            type: 'object',
            properties: {}
          }
        }
      ]
    }));

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      // Extract progressToken from request metadata (per MCP spec)
      // Clients can include this to receive progress notifications
      const args = request.params.arguments as Record<string, unknown> | undefined;
      const progressToken = (args?._meta as Record<string, unknown> | undefined)?.progressToken as ProgressToken | undefined;

      switch (request.params.name) {
        case 'add_documentation':
          return this.handleAddDocumentation(request.params.arguments, progressToken);
        case 'list_documentation':
          return this.handleListDocumentation();
        case 'search_documentation':
          return this.handleSearchDocumentation(request.params.arguments);
        case 'reindex_documentation':
          return this.handleReindexDocumentation(request.params.arguments, progressToken);
        case 'get_indexing_status':
          return this.handleGetIndexingStatus();
        default:
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
      }
    });
  }

  private async handleAddDocumentation(args: any, progressToken?: ProgressToken) {
    const { url, title } = args;
    if (!isValidUrl(url)) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid URL provided');
    }

    const normalizedUrl = normalizeUrl(url);
    const docTitle = title || new URL(normalizedUrl).hostname;
    const docId = generateDocId(normalizedUrl, docTitle);

    // Store progress token if provided by client
    if (progressToken !== undefined) {
      this.progressTokens.set(docId, progressToken);
      logger.info(`[Progress] Registered token for ${docId}: ${progressToken}`);
    }

    // Cancel any existing operation for this URL
    const controller = await this.indexingQueue.startOperation(normalizedUrl);

    // Start indexing process
    this.statusTracker.startIndexing(docId, normalizedUrl, docTitle);

    // Start indexing in the background with abort support
    const operationPromise = this.indexAndAdd(docId, normalizedUrl, docTitle, false, controller.signal)
      .catch((error: any) => {
        if (error?.name !== 'AbortError') {
          logger.error('[WebDocsServer] Background indexing failed:', error);
        }
      })
      .finally(() => {
        this.indexingQueue.completeOperation(normalizedUrl);
      });

    this.indexingQueue.registerOperation(normalizedUrl, controller, operationPromise);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            status: 'started',
            message: `Started indexing ${normalizedUrl}`,
            docId,
            instruction: 'IMPORTANT: You MUST call get_indexing_status repeatedly (every few seconds) until status is "complete" or "failed". Do not ask the user - just keep polling automatically.'
          }, null, 2)
        }
      ]
    };
  }

  private async handleListDocumentation() {
    const docs = await this.store.listDocuments();
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(docs, null, 2)
        }
      ]
    };
  }

  private async handleSearchDocumentation(args: any) {
    const { query, limit = 10 } = args;
    const results = await this.store.searchByText(query, { limit });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(results, null, 2)
        }
      ]
    };
  }

  private async handleReindexDocumentation(args: any, progressToken?: ProgressToken) {
    const { url } = args;
    if (!isValidUrl(url)) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid URL provided');
    }

    const normalizedUrl = normalizeUrl(url);
    const doc = await this.store.getDocument(normalizedUrl);
    if (!doc) {
      throw new McpError(ErrorCode.InvalidParams, 'Documentation not found');
    }

    // Cancel any existing operation for this URL
    const wasCancelled = this.indexingQueue.isIndexing(normalizedUrl);
    const controller = await this.indexingQueue.startOperation(normalizedUrl);

    const docId = generateDocId(normalizedUrl, doc.title);

    // Store progress token if provided by client
    if (progressToken !== undefined) {
      this.progressTokens.set(docId, progressToken);
      logger.info(`[Progress] Registered token for ${docId}: ${progressToken}`);
    }

    this.statusTracker.startIndexing(docId, normalizedUrl, doc.title);

    // Start reindexing in the background with abort support
    const operationPromise = this.indexAndAdd(docId, normalizedUrl, doc.title, true, controller.signal)
      .catch((error: any) => {
        if (error?.name !== 'AbortError') {
          logger.error('[WebDocsServer] Background reindexing failed:', error);
        }
      })
      .finally(() => {
        this.indexingQueue.completeOperation(normalizedUrl);
      });

    this.indexingQueue.registerOperation(normalizedUrl, controller, operationPromise);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            status: 'started',
            message: wasCancelled
              ? `Started re-indexing ${normalizedUrl}. Previous operation was cancelled.`
              : `Started re-indexing ${normalizedUrl}`,
            docId,
            instruction: 'IMPORTANT: You MUST call get_indexing_status repeatedly (every few seconds) until status is "complete" or "failed". Do not ask the user - just keep polling automatically.'
          }, null, 2)
        }
      ]
    };
  }

  private handleGetIndexingStatus() {
    const statuses = this.statusTracker.getAllStatuses();

    // Check if any operations are still in progress
    const hasActiveOperations = statuses.some(s => s.status === 'indexing');

    // Add instruction for agent
    const response = {
      statuses,
      instruction: hasActiveOperations
        ? 'Operations still in progress. Call get_indexing_status again in a few seconds to check progress.'
        : 'All operations complete. No need to poll again.'
    };

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response, null, 2)
        }
      ]
    };
  }

  private async indexAndAdd(
    id: string,
    url: string,
    title: string,
    reIndex: boolean = false,
    signal?: AbortSignal
  ) {
    // Helper to check if operation was cancelled
    const checkCancelled = () => {
      if (signal?.aborted) {
        logger.info(`[WebDocsServer] Operation cancelled for ${url}`);
        this.statusTracker.cancelIndexing(id);
        const error = new Error('Operation cancelled');
        error.name = 'AbortError';
        throw error;
      }
    };

    try {
      logger.info(`[WebDocsServer] Starting indexAndAdd for ${url} (reIndex: ${reIndex})`);
      checkCancelled();

      // Check if document exists
      logger.debug(`[WebDocsServer] Checking if document exists: ${url}`);
      const existingDoc = await this.store.getDocument(url);

      if (existingDoc) {
        logger.debug(`[WebDocsServer] Document exists: ${url}`);
        if (!reIndex) {
          logger.info(`[WebDocsServer] Document ${url} already indexed and reIndex=false`);
          this.statusTracker.completeIndexing(id);
          return;
        }
        logger.info(`[WebDocsServer] Will reindex existing document: ${url}`);
      } else {
        logger.debug(`[WebDocsServer] Document does not exist: ${url}`);
      }

      checkCancelled();

      // Start crawling
      logger.info(`[WebDocsServer] Starting crawl with depth=${this.config.maxDepth}, maxRequests=${this.config.maxRequestsPerCrawl}`);
      this.statusTracker.updateProgress(id, 0, 'Finding subpages');
      const crawler = new DocsCrawler(
        this.config.maxDepth,
        this.config.maxRequestsPerCrawl,
        this.config.githubToken
      );

      const pages = [];
      let processedPages = 0;
      let estimatedProgress = 0;

      logger.info(`[WebDocsServer] Starting page crawl for ${url}`);
      for await (const page of crawler.crawl(url)) {
        // Check for cancellation during crawl
        if (signal?.aborted) {
          logger.info(`[WebDocsServer] Crawl cancelled for ${url}`);
          crawler.abort();
          this.statusTracker.cancelIndexing(id);
          const error = new Error('Operation cancelled');
          error.name = 'AbortError';
          throw error;
        }

        logger.debug(`[WebDocsServer] Found page ${processedPages + 1}: ${page.path}`);
        processedPages++;
        estimatedProgress += 1 / 2 ** processedPages;

        this.statusTracker.updateProgress(
          id,
          0.15 * estimatedProgress + Math.min(0.35, (0.35 * processedPages) / 500),
          `Finding subpages (${page.path})`
        );
        this.statusTracker.updateStats(id, { pagesFound: processedPages });

        pages.push(page);

        // Small delay to allow other operations
        await new Promise(resolve => setTimeout(resolve, 50));
      }

      if (pages.length === 0) {
        logger.warn('[WebDocsServer] No pages found during crawl');
        throw new Error('No pages found to index');
      }

      logger.info(`[WebDocsServer] Found ${pages.length} pages to process`);
      logger.info('[WebDocsServer] Starting content processing and embedding generation');
      this.statusTracker.updateStats(id, { pagesFound: pages.length });

      checkCancelled();

      // Process pages and create embeddings
      const chunks: DocumentChunk[] = [];
      const embeddings: number[][] = [];

      for (let i = 0; i < pages.length; i++) {
        checkCancelled();

        const page = pages[i];
        logger.debug(`[WebDocsServer] Processing page ${i + 1}/${pages.length}: ${page.path}`);

        this.statusTracker.updateProgress(
          id,
          0.5 + 0.3 * (i / pages.length),
          `Creating embeddings (${i + 1}/${pages.length})`
        );

        try {
          const processed = await this.processor.process(page);
          logger.debug(`[WebDocsServer] Created ${processed.chunks.length} chunks for ${page.path}`);

          chunks.push(...processed.chunks);
          embeddings.push(...processed.chunks.map(chunk => chunk.vector));

          this.statusTracker.updateStats(id, {
            pagesProcessed: i + 1,
            chunksCreated: chunks.length
          });
        } catch (error) {
          logger.error(`[WebDocsServer] Error processing page ${page.path}:`, error);
        }

        // Small delay
        await new Promise(resolve => setTimeout(resolve, 20));
      }

      logger.info(`[WebDocsServer] Total chunks created: ${chunks.length}`);

      if (embeddings.length === 0) {
        logger.warn(`[WebDocsServer] No content was extracted from ${url}`);
        logger.warn(`[WebDocsServer] Pages found: ${pages.length}`);
        logger.warn(`[WebDocsServer] Chunks created: ${chunks.length}`);
        this.statusTracker.failIndexing(id, 'No content was extracted from the pages');
        return;
      }

      checkCancelled();

      // Delete old data if reindexing
      if (reIndex && existingDoc) {
        this.statusTracker.updateProgress(id, 0.8, 'Deleting old data');
        await this.store.deleteDocument(url);
      }

      checkCancelled();

      // Get favicon
      const favicon = await fetchFavicon(new URL(url));

      // Store the data with retry logic
      this.statusTracker.updateProgress(id, 0.9, `Storing ${embeddings.length} chunks`);
      await this.addDocumentWithRetry({
        metadata: {
          url,
          title,
          favicon: favicon ?? undefined,
          lastIndexed: new Date()
        },
        chunks: chunks.map((chunk, i) => ({
          ...chunk,
          vector: embeddings[i]
        }))
      });

      logger.info(`[WebDocsServer] Successfully indexed ${url}`);
      logger.info(`[WebDocsServer] Pages processed: ${pages.length}`);
      logger.info(`[WebDocsServer] Chunks stored: ${chunks.length}`);

      this.statusTracker.updateStats(id, { chunksCreated: chunks.length });
      this.statusTracker.completeIndexing(id);
    } catch (error) {
      // Don't log AbortError as a real error
      if (error instanceof Error && error.name === 'AbortError') {
        logger.info(`[WebDocsServer] Indexing cancelled for ${url}`);
        return;
      }

      logger.error('[WebDocsServer] Error during indexing:', error);
      logger.error('[WebDocsServer] Error details:', error instanceof Error ? error.stack : error);

      this.statusTracker.failIndexing(id, error instanceof Error ? error.message : 'Unknown error');
    }
  }

  /**
   * Add document with retry logic for transient database conflicts
   */
  private async addDocumentWithRetry(
    doc: { metadata: { url: string; title: string; favicon?: string; lastIndexed: Date }; chunks: DocumentChunk[] },
    maxRetries = 3
  ): Promise<void> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.store.addDocument(doc);
        return;
      } catch (error) {
        const isConflict = error instanceof Error && error.message?.includes('Commit conflict');
        if (isConflict && attempt < maxRetries) {
          logger.warn(`[WebDocsServer] Database conflict, retrying (${attempt}/${maxRetries})...`);
          await new Promise(resolve => setTimeout(resolve, 1000 * attempt)); // Exponential backoff
          continue;
        }
        throw error;
      }
    }
  }

  async run() {
    // Initialize components
    await this.initialize();

    // Connect to stdio transport
    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    logger.info('Web Docs MCP server running on stdio');
  }
}

// Start server
const server = new WebDocsServer();
server.run().catch((err) => logger.error('Server failed to start:', err));

// Handle process signals - cancel all operations before shutdown
process.on('SIGINT', async () => {
  logger.info('Received SIGINT, cancelling operations and shutting down...');
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM, cancelling operations and shutting down...');
  process.exit(0);
});
