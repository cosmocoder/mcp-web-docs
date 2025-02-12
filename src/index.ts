#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError
} from '@modelcontextprotocol/sdk/types.js';
import { DocumentStore } from './storage/storage.js';
import { OpenAIEmbeddings } from './embeddings/openai.js';
import { WebDocumentProcessor } from './processor/processor.js';
import { IndexingStatusTracker } from './indexing/status.js';
import { DocsConfig, loadConfig, isValidUrl, normalizeUrl } from './config.js';
import { DocsCrawler } from './crawler/docs-crawler.js';
import { fetchFavicon } from './util/favicon.js';
import { DocumentChunk } from './types.js';

function generateDocId(url: string, title: string): string {
  const urlObj = new URL(url);
  const pathParts = urlObj.pathname.split('/').filter(Boolean);

  // For GitHub Pages (e.g., jimdo.github.io/ui/latest)
  if (urlObj.hostname.endsWith('github.io')) {
    const org = urlObj.hostname.split('.')[0];
    const repo = pathParts[0];
    return `${org}-${repo}`;
  }

  // For organization packages (e.g., @org/package)
  if (title.includes('/')) {
    return title.toLowerCase().replace(/[@/]/g, '-').replace(/\s+/g, '-');
  }

  // For regular packages, use the first part of the hostname
  const hostParts = urlObj.hostname.split('.');
  if (hostParts.length > 1) {
    const mainPart = hostParts[0] === 'www' ? hostParts[1] : hostParts[0];
    // If there's a specific product/package in the path, include it
    if (pathParts.length > 0 && pathParts[0] !== 'docs') {
      return `${mainPart}-${pathParts[0]}`;
    }
    return mainPart;
  }

  return urlObj.hostname;
}

class WebDocsServer {
  private server: Server;
  private config!: DocsConfig;
  private store!: DocumentStore;
  private processor!: WebDocumentProcessor;
  private statusTracker: IndexingStatusTracker;
  private docsIndexingQueue: Set<string>;

  constructor() {
    // Initialize basic components that don't need async initialization
    this.statusTracker = new IndexingStatusTracker();
    this.docsIndexingQueue = new Set();

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
    this.server.onerror = (error) => console.error('[MCP Error]', error);
  }

  private async initialize() {
    // Load configuration
    this.config = await loadConfig();

    // Initialize components that need config
    const embeddings = new OpenAIEmbeddings(this.config.openaiApiKey);
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
          description: 'Search through indexed documentation',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Search query'
              },
              limit: {
                type: 'number',
                description: 'Maximum number of results'
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

    // Start indexing process
    this.statusTracker.startIndexing(docId, normalizedUrl, docTitle);

    // Start indexing in the background
    void this.indexAndAdd(docId, normalizedUrl, docTitle).catch(error => {
      console.error('[WebDocsServer] Background indexing failed:', error);
    });

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
    const results = await this.store.searchDocuments(query, limit);
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

    const docId = generateDocId(normalizedUrl, doc.title);
    this.statusTracker.startIndexing(docId, normalizedUrl, doc.title);

    // Start reindexing in the background
    void this.indexAndAdd(docId, normalizedUrl, doc.title, true).catch(error => {
      console.error('[WebDocsServer] Background reindexing failed:', error);
    });

    return {
      content: [
        {
          type: 'text',
          text: `Started re-indexing ${normalizedUrl} - use get_indexing_status to monitor progress`
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

  private async indexAndAdd(id: string, url: string, title: string, reIndex: boolean = false) {
    try {
      console.debug(`[WebDocsServer] Starting indexAndAdd for ${url} (reIndex: ${reIndex})`);

      if (this.docsIndexingQueue.has(url)) {
        console.debug(`[WebDocsServer] Document ${url} is already being indexed`);
        return;
      }

      this.docsIndexingQueue.add(url);
      console.debug(`[WebDocsServer] Added ${url} to indexing queue`);

      // Check if document exists
      console.debug(`[WebDocsServer] Checking if document exists: ${url}`);
      const existingDoc = await this.store.getDocument(url);

      if (existingDoc) {
        console.debug(`[WebDocsServer] Document exists: ${url}`);
        if (!reIndex) {
          console.debug(`[WebDocsServer] Document ${url} already indexed and reIndex=false`);
          this.statusTracker.completeIndexing(id);
          this.docsIndexingQueue.delete(url);
          return;
        }
        console.debug(`[WebDocsServer] Will reindex existing document: ${url}`);
      } else {
        console.debug(`[WebDocsServer] Document does not exist: ${url}`);
      }

      // Start crawling
      console.debug(`[WebDocsServer] Starting crawl with depth=${this.config.maxDepth}, maxRequests=${this.config.maxRequestsPerCrawl}`);
      this.statusTracker.updateProgress(id, 0, 'Finding subpages');
      const crawler = new DocsCrawler(
        this.config.maxDepth,
        this.config.maxRequestsPerCrawl,
        this.config.githubToken
      );

      const pages = [];
      let processedPages = 0;
      let estimatedProgress = 0;

      console.debug(`[WebDocsServer] Starting page crawl for ${url}`);
      for await (const page of crawler.crawl(url)) {
        console.debug(`[WebDocsServer] Found page ${processedPages + 1}: ${page.path}`);
        processedPages++;
        estimatedProgress += 1 / 2 ** processedPages;

        this.statusTracker.updateProgress(
          id,
          0.15 * estimatedProgress + Math.min(0.35, (0.35 * processedPages) / 500),
          `Finding subpages (${page.path})`
        );

        pages.push(page);

        // Prevent UI lockup - wait proportional to queue size
        const toWait = 100 * this.docsIndexingQueue.size + 50;
        await new Promise(resolve => setTimeout(resolve, toWait));
      }

      if (pages.length === 0) {
        console.error('[WebDocsServer] No pages found during crawl');
        throw new Error('No pages found to index');
      }

      console.debug(`[WebDocsServer] Found ${pages.length} pages to process`);
      console.debug('[WebDocsServer] Starting content processing and embedding generation');

      // Process pages and create embeddings
      const chunks: DocumentChunk[] = [];
      const embeddings: number[][] = [];

      for (let i = 0; i < pages.length; i++) {
        const page = pages[i];
        console.debug(`[WebDocsServer] Processing page ${i + 1}/${pages.length}: ${page.path}`);

        this.statusTracker.updateProgress(
          id,
          0.5 + 0.3 * (i / pages.length),
          `Creating embeddings for ${page.path}`
        );

        try {
          const processed = await this.processor.process(page);
          console.debug(`[WebDocsServer] Created ${processed.chunks.length} chunks for ${page.path}`);

          chunks.push(...processed.chunks);
          embeddings.push(...processed.chunks.map(chunk => chunk.vector));
        } catch (error) {
          console.error(`[WebDocsServer] Error processing page ${page.path}:`, error);
        }

        // Prevent UI lockup - wait proportional to queue size
        const toWait = 50 * this.docsIndexingQueue.size + 20;
        await new Promise(resolve => setTimeout(resolve, toWait));
      }

      console.debug(`[WebDocsServer] Total chunks created: ${chunks.length}`);

      if (embeddings.length === 0) {
        console.error(`[WebDocsServer] No content was extracted from ${url}`);
        console.debug(`[WebDocsServer] Pages found: ${pages.length}`);
        console.debug(`[WebDocsServer] Chunks created: ${chunks.length}`);
        this.statusTracker.failIndexing(id, 'No content was extracted from the pages');
        return;
      }

      // Delete old data if reindexing
      if (reIndex && existingDoc) {
        this.statusTracker.updateProgress(id, 0.8, 'Deleting old data');
        await this.store.deleteDocument(url);
      }

      // Get favicon
      const favicon = await fetchFavicon(new URL(url));

      // Store the data
      this.statusTracker.updateProgress(id, 0.9, `Storing ${embeddings.length} chunks`);
      await this.store.addDocument({
        metadata: {
          url,
          title,
          favicon,
          lastIndexed: new Date()
        },
        chunks: chunks.map((chunk, i) => ({
          ...chunk,
          vector: embeddings[i]
        }))
      });

      console.debug(`[WebDocsServer] Successfully indexed ${url}`);
      console.debug(`[WebDocsServer] Pages processed: ${pages.length}`);
      console.debug(`[WebDocsServer] Chunks stored: ${chunks.length}`);

      this.statusTracker.completeIndexing(id);
    } catch (error) {
      console.error('[WebDocsServer] Error during indexing:', error);
      console.debug('[WebDocsServer] Error details:', error instanceof Error ? error.stack : error);

      // Get more context about the error
      const errorContext = {
        queueSize: this.docsIndexingQueue.size,
        url,
        reIndex,
        error: error instanceof Error ? {
          name: error.name,
          message: error.message,
          stack: error.stack
        } : error
      };
      console.error('[WebDocsServer] Error context:', errorContext);

      this.statusTracker.failIndexing(id, error instanceof Error ? error.message : 'Unknown error');
    } finally {
      this.docsIndexingQueue.delete(url);
    }
  }

  async run() {
    // Initialize components
    await this.initialize();

    // Connect to stdio transport
    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    console.error('Web Docs MCP server running on stdio');
  }
}

// Start server
const server = new WebDocsServer();
server.run().catch(console.error);

// Handle process signals
process.on('SIGINT', () => {
  console.error('Received SIGINT, shutting down...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.error('Received SIGTERM, shutting down...');
  process.exit(0);
});
