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

class WebDocsServer {
  private server: Server;
  private config!: DocsConfig;
  private store!: DocumentStore;
  private processor!: WebDocumentProcessor;
  private statusTracker: IndexingStatusTracker;
  private indexingQueue: IndexingQueueManager;
  private lastNotifiedProgress: Map<string, number> = new Map();

  constructor() {
    // Initialize basic components that don't need async initialization
    this.statusTracker = new IndexingStatusTracker();
    this.indexingQueue = new IndexingQueueManager();

    // Set up status change listener for notifications
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
   * Send progress notification to MCP client.
   * Throttled to avoid flooding - only sends when progress changes by 5% or status changes.
   */
  private sendProgressNotification(status: IndexingStatus): void {
    const progressPercent = Math.round(status.progress * 100);
    const lastProgress = this.lastNotifiedProgress.get(status.id) ?? -1;

    // Only notify on significant progress (5% increments) or status changes
    const isStatusChange = status.status === 'complete' || status.status === 'failed' || status.status === 'cancelled';
    const isSignificantProgress = progressPercent - lastProgress >= 5;

    if (!isStatusChange && !isSignificantProgress) {
      return;
    }

    this.lastNotifiedProgress.set(status.id, progressPercent);

    // Clean up tracking for completed operations
    if (isStatusChange) {
      this.lastNotifiedProgress.delete(status.id);
    }

    // Log the notification (MCP SDK will handle actual notification if supported)
    logger.info(`[Notification] ${status.status}: ${status.url} - ${progressPercent}% - ${status.description}`);
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
          description: 'Search through indexed documentation using semantic similarity',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Search query'
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
      switch (request.params.name) {
        case 'add_documentation':
          return this.handleAddDocumentation(request.params.arguments);
        case 'list_documentation':
          return this.handleListDocumentation();
        case 'search_documentation':
          return this.handleSearchDocumentation(request.params.arguments);
        case 'reindex_documentation':
          return this.handleReindexDocumentation(request.params.arguments);
        case 'get_indexing_status':
          return this.handleGetIndexingStatus();
        default:
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
      }
    });
  }

  private async handleAddDocumentation(args: any) {
    const { url, title } = args;
    if (!isValidUrl(url)) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid URL provided');
    }

    const normalizedUrl = normalizeUrl(url);
    const docTitle = title || new URL(normalizedUrl).hostname;
    const docId = generateDocId(normalizedUrl, docTitle);

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
          text: `Started indexing ${normalizedUrl} - use get_indexing_status to monitor progress`
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

  private async handleReindexDocumentation(args: any) {
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

    const message = wasCancelled
      ? `Started re-indexing ${normalizedUrl}. Previous operation was cancelled.`
      : `Started re-indexing ${normalizedUrl} - use get_indexing_status to monitor progress`;

    return {
      content: [
        {
          type: 'text',
          text: message
        }
      ]
    };
  }

  private handleGetIndexingStatus() {
    const statuses = this.statusTracker.getAllStatuses();
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(statuses, null, 2)
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
