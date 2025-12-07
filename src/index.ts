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
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import { DocumentStore } from './storage/storage.js';
import { FastEmbeddings } from './embeddings/fastembed.js';
import { WebDocumentProcessor } from './processor/processor.js';
import { IndexingStatusTracker } from './indexing/status.js';
import { IndexingQueueManager } from './indexing/queue-manager.js';
import { DocsConfig, loadConfig, isValidPublicUrl, normalizeUrl } from './config.js';
import { DocsCrawler } from './crawler/docs-crawler.js';
import { AuthManager } from './crawler/auth.js';
import { fetchFavicon } from './util/favicon.js';
import { DocumentChunk, IndexingStatus } from './types.js';
import { generateDocId } from './util/docs.js';
import { logger } from './util/logger.js';
import {
  StorageStateSchema,
  safeJsonParse,
  validateToolArgs,
  sanitizeErrorMessage,
  detectPromptInjection,
  wrapExternalContent,
  addInjectionWarnings,
  SessionExpiredError,
  AddDocumentationArgsSchema,
  AuthenticateArgsSchema,
  ClearAuthArgsSchema,
  SearchDocumentationArgsSchema,
  ReindexDocumentationArgsSchema,
  DeleteDocumentationArgsSchema,
  type ValidatedStorageState,
} from './util/security.js';
import type { StorageState } from './crawler/crawlee-crawler.js';

/** Progress token type from MCP spec */
type ProgressToken = string | number;

class WebDocsServer {
  private server: Server;
  private config!: DocsConfig;
  private store!: DocumentStore;
  private processor!: WebDocumentProcessor;
  private statusTracker: IndexingStatusTracker;
  private indexingQueue: IndexingQueueManager;
  private authManager!: AuthManager;
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
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
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
          message,
        },
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
    this.store = new DocumentStore(this.config.dbPath, this.config.vectorDbPath, embeddings, this.config.cacheSize);
    this.processor = new WebDocumentProcessor(embeddings, this.config.maxChunkSize);

    // Initialize auth manager for handling authenticated crawls
    this.authManager = new AuthManager(this.config.dataDir);
    await this.authManager.initialize();

    // Initialize storage
    await this.store.initialize();
  }

  private setupToolHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'add_documentation',
          description: 'Add new documentation site for indexing. Supports authenticated sites via the auth options.',
          inputSchema: {
            type: 'object',
            properties: {
              url: {
                type: 'string',
                description: 'URL of the documentation site',
              },
              title: {
                type: 'string',
                description: 'Optional title for the documentation',
              },
              id: {
                type: 'string',
                description:
                  'Optional custom ID for the documentation (used for storage and identification). If not provided, an ID is auto-generated from the URL.',
              },
              auth: {
                type: 'object',
                description: 'Authentication options for protected documentation sites',
                properties: {
                  requiresAuth: {
                    type: 'boolean',
                    description: 'Set to true to open a browser for interactive login before crawling',
                  },
                  browser: {
                    type: 'string',
                    enum: ['chromium', 'chrome', 'firefox', 'webkit', 'edge'],
                    description:
                      "Optional. If omitted, the user's default browser is automatically detected from OS settings. Only specify to override.",
                  },
                  loginUrl: {
                    type: 'string',
                    description: 'Login page URL if different from main URL',
                  },
                  loginSuccessPattern: {
                    type: 'string',
                    description: 'URL regex pattern that indicates successful login',
                  },
                  loginSuccessSelector: {
                    type: 'string',
                    description: 'CSS selector that appears after successful login',
                  },
                  loginTimeoutSecs: {
                    type: 'number',
                    description: 'Timeout for login in seconds (default: 300)',
                  },
                },
              },
            },
            required: ['url'],
          },
        },
        {
          name: 'authenticate',
          description:
            "Open a browser window for interactive login to a protected site. The session will be saved and reused for future crawls. Use this before add_documentation for sites that require login. The user's default browser is automatically detected from OS settings - do NOT specify a browser unless the user explicitly requests a specific one.",
          inputSchema: {
            type: 'object',
            properties: {
              url: {
                type: 'string',
                description: 'URL of the site to authenticate to',
              },
              browser: {
                type: 'string',
                enum: ['chromium', 'chrome', 'firefox', 'webkit', 'edge'],
                description:
                  "Optional. If omitted, the user's default browser is automatically detected from OS settings. Only specify this to override auto-detection with a specific browser.",
              },
              loginUrl: {
                type: 'string',
                description: 'Login page URL if different from main URL',
              },
              loginTimeoutSecs: {
                type: 'number',
                description: 'Timeout for login in seconds (default: 300 = 5 minutes)',
              },
            },
            required: ['url'],
          },
        },
        {
          name: 'clear_auth',
          description: 'Clear saved authentication session for a domain',
          inputSchema: {
            type: 'object',
            properties: {
              url: {
                type: 'string',
                description: 'URL of the site to clear authentication for',
              },
            },
            required: ['url'],
          },
        },
        {
          name: 'list_documentation',
          description: 'List all indexed documentation sites',
          inputSchema: {
            type: 'object',
            properties: {},
          },
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
                description:
                  'Search query - be specific and include unique terms. Use quotes for exact phrases. Example: "Card component props headline status" or "REST API authentication Bearer token"',
              },
              url: {
                type: 'string',
                description:
                  'Optional: Filter results to a specific documentation site by its URL. If not provided, searches all indexed docs.',
              },
              limit: {
                type: 'number',
                description: 'Maximum number of results (default: 10)',
              },
            },
            required: ['query'],
          },
        },
        {
          name: 'reindex_documentation',
          description: 'Re-index a specific documentation site',
          inputSchema: {
            type: 'object',
            properties: {
              url: {
                type: 'string',
                description: 'URL of the documentation to re-index',
              },
            },
            required: ['url'],
          },
        },
        {
          name: 'get_indexing_status',
          description: 'Get current indexing status',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'delete_documentation',
          description:
            'Delete an indexed documentation site and all its data (vectors, metadata, cached crawl data, and optionally auth session)',
          inputSchema: {
            type: 'object',
            properties: {
              url: {
                type: 'string',
                description: 'URL of the documentation site to delete',
              },
              clearAuth: {
                type: 'boolean',
                description: 'Also clear saved authentication session for this domain (default: false)',
              },
            },
            required: ['url'],
          },
        },
      ],
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
        case 'authenticate':
          return this.handleAuthenticate(request.params.arguments);
        case 'clear_auth':
          return this.handleClearAuth(request.params.arguments);
        case 'delete_documentation':
          return this.handleDeleteDocumentation(request.params.arguments);
        default:
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
      }
    });
  }

  private async handleAddDocumentation(args: Record<string, unknown> | undefined, progressToken?: ProgressToken) {
    // Validate arguments with schema
    let validatedArgs;
    try {
      validatedArgs = validateToolArgs(args, AddDocumentationArgsSchema);
    } catch (error) {
      throw new McpError(ErrorCode.InvalidParams, sanitizeErrorMessage(error));
    }

    const { url, title, id, auth: authOptions } = validatedArgs;

    // Additional SSRF protection check
    if (!isValidPublicUrl(url)) {
      throw new McpError(ErrorCode.InvalidParams, 'Access to private networks is blocked');
    }

    const normalizedUrl = normalizeUrl(url);
    const docTitle = title || new URL(normalizedUrl).hostname;
    // Use custom ID if provided, otherwise auto-generate
    const docId = id || generateDocId(normalizedUrl, docTitle);
    if (authOptions?.requiresAuth) {
      const hasExistingSession = await this.authManager.hasSession(normalizedUrl);
      if (!hasExistingSession) {
        logger.info(`[WebDocsServer] auth.requiresAuth=true, starting interactive login for ${normalizedUrl}`);
        try {
          await this.authManager.performInteractiveLogin(normalizedUrl, {
            browser: authOptions.browser,
            loginUrl: authOptions.loginUrl,
            loginSuccessPattern: authOptions.loginSuccessPattern,
            loginSuccessSelector: authOptions.loginSuccessSelector,
            loginTimeoutSecs: authOptions.loginTimeoutSecs,
          });
          logger.info(`[WebDocsServer] Authentication successful for ${normalizedUrl}`);
        } catch (error) {
          throw new McpError(
            ErrorCode.InternalError,
            `Authentication failed: ${sanitizeErrorMessage(error)}. Please try using the 'authenticate' tool separately.`
          );
        }
      } else {
        // Validate that the existing session is still valid before crawling
        logger.info(`[WebDocsServer] Validating existing session for ${normalizedUrl}...`);
        const validation = await this.authManager.validateSession(normalizedUrl);
        if (!validation.isValid) {
          logger.warn(`[WebDocsServer] Session expired for ${normalizedUrl}: ${validation.reason}`);
          // Clear the expired session
          await this.authManager.clearSession(normalizedUrl);
          throw new McpError(
            ErrorCode.InvalidParams,
            `Authentication session has expired (${validation.reason}). Please use the 'authenticate' tool to log in again.`
          );
        }
        logger.info(`[WebDocsServer] ✓ Session validated for ${normalizedUrl}`);
      }
    }

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
      .catch((error) => {
        const err = error as Error;
        if (err?.name !== 'AbortError') {
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
          text: JSON.stringify(
            {
              status: 'started',
              message: `Started indexing ${normalizedUrl}`,
              docId,
              instruction:
                'IMPORTANT: You MUST call get_indexing_status repeatedly (every few seconds) until status is "complete" or "failed". Do not ask the user - just keep polling automatically.',
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private async handleListDocumentation() {
    const docs = await this.store.listDocuments();
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(docs, null, 2),
        },
      ],
    };
  }

  private async handleSearchDocumentation(args: Record<string, unknown> | undefined) {
    // Validate arguments with schema
    let validatedArgs;
    try {
      validatedArgs = validateToolArgs(args, SearchDocumentationArgsSchema);
    } catch (error) {
      throw new McpError(ErrorCode.InvalidParams, sanitizeErrorMessage(error));
    }

    const { query, url, limit = 10 } = validatedArgs;

    // Normalize URL if provided for filtering
    const filterUrl = url ? normalizeUrl(url) : undefined;

    const results = await this.store.searchByText(query, { limit, filterUrl });

    // Apply prompt injection detection and external content markers to results
    const safeResults = results.map((result) => {
      // Detect prompt injection patterns in the content
      const injectionResult = detectPromptInjection(result.content);

      // Add injection warnings if detected
      let safeContent = addInjectionWarnings(result.content, injectionResult);

      // Wrap with external content markers
      safeContent = wrapExternalContent(safeContent, result.url);

      return {
        ...result,
        content: safeContent,
        // Include security metadata
        security: {
          isExternalContent: true,
          injectionDetected: injectionResult.hasInjection,
          injectionSeverity: injectionResult.maxSeverity,
          detectionCount: injectionResult.detections.length,
        },
      };
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(safeResults, null, 2),
        },
      ],
    };
  }

  private async handleReindexDocumentation(args: Record<string, unknown> | undefined, progressToken?: ProgressToken) {
    // Validate arguments with schema
    let validatedArgs;
    try {
      validatedArgs = validateToolArgs(args, ReindexDocumentationArgsSchema);
    } catch (error) {
      throw new McpError(ErrorCode.InvalidParams, sanitizeErrorMessage(error));
    }

    const { url } = validatedArgs;

    // Additional SSRF protection check
    if (!isValidPublicUrl(url)) {
      throw new McpError(ErrorCode.InvalidParams, 'Access to private networks is blocked');
    }

    const normalizedUrl = normalizeUrl(url as string);
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
      .catch((error) => {
        const err = error as Error;
        if (err?.name !== 'AbortError') {
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
          text: JSON.stringify(
            {
              status: 'started',
              message: wasCancelled
                ? `Started re-indexing ${normalizedUrl}. Previous operation was cancelled.`
                : `Started re-indexing ${normalizedUrl}`,
              docId,
              instruction:
                'IMPORTANT: You MUST call get_indexing_status repeatedly (every few seconds) until status is "complete" or "failed". Do not ask the user - just keep polling automatically.',
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private handleGetIndexingStatus() {
    // Get only active operations and recently completed ones (auto-cleans old statuses)
    const statuses = this.statusTracker.getActiveStatuses();

    // Check if any operations are still in progress
    const hasActiveOperations = statuses.some((s) => s.status === 'indexing');

    // Add instruction for agent
    const response = {
      statuses,
      instruction: hasActiveOperations
        ? 'Operations still in progress. Call get_indexing_status again in a few seconds to check progress.'
        : 'All operations complete. No need to poll again.',
    };

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response, null, 2),
        },
      ],
    };
  }

  /**
   * Handle interactive authentication request.
   * Opens a visible browser for the user to login manually.
   */
  private async handleAuthenticate(args: Record<string, unknown> | undefined) {
    // Validate arguments with schema
    let validatedArgs;
    try {
      validatedArgs = validateToolArgs(args, AuthenticateArgsSchema);
    } catch (error) {
      throw new McpError(ErrorCode.InvalidParams, sanitizeErrorMessage(error));
    }

    const { url, browser, loginUrl, loginTimeoutSecs = 300 } = validatedArgs;

    // Additional SSRF protection check
    if (!isValidPublicUrl(url)) {
      throw new McpError(ErrorCode.InvalidParams, 'Access to private networks is blocked');
    }

    const normalizedUrl = normalizeUrl(url);
    const domain = new URL(normalizedUrl).hostname;

    // Check if we already have a session
    const hasSession = await this.authManager.hasSession(normalizedUrl);
    if (hasSession) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                status: 'existing_session',
                message: `Already have a saved session for ${domain}. Use clear_auth first if you need to re-authenticate.`,
                domain,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    try {
      logger.info(`[Auth] Opening ${browser || 'auto-detected'} browser for authentication to ${domain}`);

      // Perform interactive login
      await this.authManager.performInteractiveLogin(normalizedUrl, {
        browser,
        loginUrl,
        loginTimeoutSecs,
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                status: 'success',
                message: `Successfully authenticated to ${domain}. Session saved for future crawls.`,
                domain,
                instruction: 'You can now use add_documentation to crawl this site. The saved session will be used automatically.',
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      const safeErrorMessage = sanitizeErrorMessage(error);
      logger.error(`[Auth] Authentication failed:`, safeErrorMessage);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                status: 'failed',
                message: `Authentication failed: ${safeErrorMessage}`,
                domain,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  }

  /**
   * Handle clearing saved authentication for a domain
   */
  private async handleClearAuth(args: Record<string, unknown> | undefined) {
    // Validate arguments with schema
    let validatedArgs;
    try {
      validatedArgs = validateToolArgs(args, ClearAuthArgsSchema);
    } catch (error) {
      throw new McpError(ErrorCode.InvalidParams, sanitizeErrorMessage(error));
    }

    const { url } = validatedArgs;
    const normalizedUrl = normalizeUrl(url);
    const domain = new URL(normalizedUrl).hostname;

    await this.authManager.clearSession(normalizedUrl);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              status: 'success',
              message: `Cleared saved authentication for ${domain}`,
              domain,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  /**
   * Handle deleting an indexed documentation site and all its data
   */
  private async handleDeleteDocumentation(args: Record<string, unknown> | undefined) {
    // Validate arguments with schema
    let validatedArgs;
    try {
      validatedArgs = validateToolArgs(args, DeleteDocumentationArgsSchema);
    } catch (error) {
      throw new McpError(ErrorCode.InvalidParams, sanitizeErrorMessage(error));
    }

    const { url, clearAuth = false } = validatedArgs;
    const normalizedUrl = normalizeUrl(url);
    const domain = new URL(normalizedUrl).hostname;

    // Check if document exists
    const doc = await this.store.getDocument(normalizedUrl);
    if (!doc) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                status: 'not_found',
                message: `No indexed documentation found for ${normalizedUrl}`,
                url: normalizedUrl,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    const deletedItems: string[] = [];

    try {
      // 1. Delete from SQLite and LanceDB (via store)
      await this.store.deleteDocument(normalizedUrl);
      deletedItems.push('document metadata (SQLite)', 'vector chunks (LanceDB)');
      logger.info(`[WebDocsServer] Deleted document from store: ${normalizedUrl}`);

      // 2. Delete Crawlee dataset
      const docId = generateDocId(normalizedUrl, doc.title);
      try {
        const { Dataset } = await import('crawlee');
        const dataset = await Dataset.open(docId);
        await dataset.drop();
        deletedItems.push('crawl cache (Crawlee dataset)');
        logger.info(`[WebDocsServer] Deleted Crawlee dataset: ${docId}`);
      } catch {
        logger.debug(`[WebDocsServer] No Crawlee dataset to delete for ${docId}`);
      }

      // 3. Optionally clear auth session
      if (clearAuth as boolean) {
        await this.authManager.clearSession(normalizedUrl);
        deletedItems.push('authentication session');
        logger.info(`[WebDocsServer] Cleared auth session for ${domain}`);
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                status: 'success',
                message: `Successfully deleted documentation for ${normalizedUrl}`,
                url: normalizedUrl,
                title: doc.title,
                deletedItems,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      const safeErrorMessage = sanitizeErrorMessage(error);
      logger.error(`[WebDocsServer] Error deleting documentation:`, safeErrorMessage);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                status: 'error',
                message: `Failed to delete documentation: ${safeErrorMessage}`,
                url: normalizedUrl,
                deletedItems,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  }

  private async indexAndAdd(id: string, url: string, title: string, reIndex: boolean = false, signal?: AbortSignal) {
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
      const crawler = new DocsCrawler(this.config.maxDepth, this.config.maxRequestsPerCrawl, this.config.githubToken);

      // Load saved authentication session if available
      const savedSession = await this.authManager.loadSession(url);
      if (savedSession) {
        try {
          // Validate the session structure before using it
          const validatedState: ValidatedStorageState = safeJsonParse(savedSession, StorageStateSchema);
          // The validated state is structurally compatible with StorageState
          crawler.setStorageState(validatedState as StorageState);
          logger.info(`[WebDocsServer] Using validated authentication session for ${url}`);
        } catch (e) {
          logger.warn(`[WebDocsServer] Failed to parse or validate saved session:`, e);
          // Continue without authentication rather than failing
        }
      }

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
        await new Promise((resolve) => setTimeout(resolve, 50));
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

        this.statusTracker.updateProgress(id, 0.5 + 0.3 * (i / pages.length), `Creating embeddings (${i + 1}/${pages.length})`);

        try {
          const processed = await this.processor.process(page);
          logger.debug(`[WebDocsServer] Created ${processed.chunks.length} chunks for ${page.path}`);

          chunks.push(...processed.chunks);
          embeddings.push(...processed.chunks.map((chunk) => chunk.vector));

          this.statusTracker.updateStats(id, {
            pagesProcessed: i + 1,
            chunksCreated: chunks.length,
          });
        } catch (error) {
          logger.error(`[WebDocsServer] Error processing page ${page.path}:`, error);
        }

        // Small delay
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      logger.info(`[WebDocsServer] Total chunks created: ${chunks.length}`);

      // Scan for potential prompt injection patterns in indexed content
      let injectionWarnings = 0;
      for (const chunk of chunks) {
        const injectionResult = detectPromptInjection(chunk.content);
        if (injectionResult.hasInjection) {
          injectionWarnings++;
          if (injectionResult.maxSeverity === 'high') {
            logger.warn(
              `[Security] HIGH severity prompt injection pattern detected in ${chunk.path || 'unknown'}: ${injectionResult.detections[0]?.description}`
            );
          }
        }
      }
      if (injectionWarnings > 0) {
        logger.warn(
          `[Security] Detected ${injectionWarnings} chunks with potential prompt injection patterns in ${url}. Content will be marked when returned in search results.`
        );
      }

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
          lastIndexed: new Date(),
        },
        chunks: chunks.map((chunk, i) => ({
          ...chunk,
          vector: embeddings[i],
        })),
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

      // Handle expired session errors specially
      if (error instanceof SessionExpiredError) {
        logger.warn(`[WebDocsServer] Session expired during crawl of ${url}: ${error.message}`);
        logger.warn(`[WebDocsServer] Expected URL: ${error.expectedUrl}, Detected URL: ${error.detectedUrl}`);

        // Clear the expired session
        await this.authManager.clearSession(url);
        logger.info(`[WebDocsServer] Cleared expired session for ${url}`);

        // Report user-friendly error
        const userMessage = `Authentication session has expired. The crawler was redirected to a login page. Please use the 'authenticate' tool to log in again before re-indexing.`;
        this.statusTracker.failIndexing(id, userMessage);
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
          await new Promise((resolve) => setTimeout(resolve, 1000 * attempt)); // Exponential backoff
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
