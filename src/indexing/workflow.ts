import { setTimeout as delay } from 'node:timers/promises';
import type { AuthManager } from '../crawler/auth.js';
import type { DocsCrawler } from '../crawler/docs-crawler.js';
import type { StorageState } from '../crawler/crawlee-crawler.js';
import type { WebDocumentProcessor } from '../processor/processor.js';
import type { DocumentStore } from '../storage/storage.js';
import type { DocumentChunk } from '../types.js';
import {
  detectPromptInjection,
  safeJsonParse,
  sanitizeErrorMessage,
  SessionExpiredError,
  StorageStateSchema,
  type ValidatedStorageState,
} from '../util/security.js';
import { logger } from '../util/logger.js';
import type { IndexingStatusTracker } from './status.js';

type WorkflowStore = Pick<DocumentStore, 'addDocument' | 'getDocument' | 'optimize'>;
type WorkflowProcessor = Pick<WebDocumentProcessor, 'process'>;
type WorkflowStatusTracker = Pick<
  IndexingStatusTracker,
  'cancelIndexing' | 'completeIndexing' | 'failIndexing' | 'getStatus' | 'updateProgress' | 'updateStats'
>;
type WorkflowAuthManager = Pick<AuthManager, 'clearSession' | 'loadSession'>;
type WorkflowCrawler = Pick<DocsCrawler, 'abort' | 'crawl' | 'setPathPrefix' | 'setStorageState'>;

export interface IndexingRequest {
  operationId: string;
  url: string;
  title: string;
  reIndex?: boolean;
  pathPrefix?: string;
  authInfo?: { requiresAuth: boolean; authDomain: string };
  tags?: string[];
  version?: string;
}

interface IndexingWorkflowDependencies {
  store: WorkflowStore;
  processor: WorkflowProcessor;
  statusTracker: WorkflowStatusTracker;
  authManager: WorkflowAuthManager;
  createCrawler: () => WorkflowCrawler;
  fetchFavicon: (url: URL) => Promise<string | undefined>;
}

export class IndexingWorkflow {
  constructor(private readonly dependencies: IndexingWorkflowDependencies) {}

  async run(request: IndexingRequest, signal: AbortSignal): Promise<void> {
    const { operationId, url, title, pathPrefix, authInfo, tags, version } = request;
    const reIndex = request.reIndex ?? false;
    const { store, processor, statusTracker, authManager } = this.dependencies;

    const checkCancelled = () => {
      if (signal.aborted) {
        logger.info(`[IndexingWorkflow] Operation cancelled for ${url}`);
        if (statusTracker.getStatus(operationId)?.status !== 'cancelled') {
          statusTracker.cancelIndexing(operationId);
        }
        const error = new Error('Operation cancelled');
        error.name = 'AbortError';
        throw error;
      }
    };

    try {
      logger.info(`[IndexingWorkflow] Starting indexing for ${url} (reIndex: ${reIndex})`);
      checkCancelled();

      logger.debug(`[IndexingWorkflow] Checking if document exists: ${url}`);
      const existingDoc = await store.getDocument(url);
      checkCancelled();

      if (existingDoc) {
        logger.debug(`[IndexingWorkflow] Document exists: ${url}`);
        if (!reIndex) {
          logger.info(`[IndexingWorkflow] Document ${url} already indexed and reIndex=false`);
          statusTracker.completeIndexing(operationId);
          return;
        }
        logger.info(`[IndexingWorkflow] Will reindex existing document: ${url}`);
      }
      else {
        logger.debug(`[IndexingWorkflow] Document does not exist: ${url}`);
      }

      checkCancelled();

      statusTracker.updateProgress(operationId, 0, 'Finding subpages');
      logger.info(`[IndexingWorkflow] Starting crawl${pathPrefix ? ` with pathPrefix=${pathPrefix}` : ''}`);
      const crawler = this.dependencies.createCrawler();

      if (pathPrefix) {
        crawler.setPathPrefix(pathPrefix);
      }

      const savedSession = await authManager.loadSession(url);
      checkCancelled();
      if (savedSession) {
        try {
          const validatedState: ValidatedStorageState = safeJsonParse(savedSession, StorageStateSchema);
          crawler.setStorageState(validatedState as StorageState);
          logger.info(`[IndexingWorkflow] Using validated authentication session for ${url}`);
        }
        catch (error) {
          logger.warn(`[IndexingWorkflow] Failed to parse or validate saved session:`, error);
        }
      }

      const pages = [];
      let processedPages = 0;
      let estimatedProgress = 0;

      logger.info(`[IndexingWorkflow] Starting page crawl for ${url}`);
      const abortCrawler = (): void => crawler.abort();
      signal.addEventListener('abort', abortCrawler, { once: true });
      if (signal.aborted) {
        abortCrawler();
      }
      try {
        for await (const page of crawler.crawl(url)) {
          checkCancelled();

          logger.debug(`[IndexingWorkflow] Found page ${processedPages + 1}: ${page.path}`);
          processedPages++;
          estimatedProgress += 1 / 2 ** processedPages;

          statusTracker.updateProgress(
            operationId,
            0.15 * estimatedProgress + Math.min(0.35, (0.35 * processedPages) / 500),
            `Finding subpages (${page.path})`
          );
          statusTracker.updateStats(operationId, { pagesFound: processedPages });
          pages.push(page);

          await delay(50, undefined, { signal });
          checkCancelled();
        }
      }
      catch (error) {
        if (signal.aborted) {
          checkCancelled();
        }
        throw error;
      }
      finally {
        signal.removeEventListener('abort', abortCrawler);
      }
      checkCancelled();

      if (pages.length === 0) {
        logger.warn('[IndexingWorkflow] No pages found during crawl');
        throw new Error('No pages found to index');
      }

      logger.info(`[IndexingWorkflow] Found ${pages.length} pages to process`);
      logger.info('[IndexingWorkflow] Starting content processing and embedding generation');
      statusTracker.updateStats(operationId, { pagesFound: pages.length });
      checkCancelled();

      const chunks: DocumentChunk[] = [];

      for (let i = 0; i < pages.length; i++) {
        checkCancelled();
        const page = pages[i];
        logger.debug(`[IndexingWorkflow] Processing page ${i + 1}/${pages.length}: ${page.path}`);
        statusTracker.updateProgress(operationId, 0.5 + 0.3 * (i / pages.length), `Creating embeddings (${i + 1}/${pages.length})`);

        try {
          const processed = await processor.process(page);
          logger.debug(`[IndexingWorkflow] Created ${processed.chunks.length} chunks for ${page.path}`);
          chunks.push(...processed.chunks);
          statusTracker.updateStats(operationId, {
            pagesProcessed: i + 1,
            chunksCreated: chunks.length,
          });
        }
        catch (error) {
          if (signal.aborted) {
            checkCancelled();
          }
          logger.error(`[IndexingWorkflow] Error processing page ${page.path}:`, error);
          throw new Error(sanitizeErrorMessage(`Failed to process ${page.path}: ${sanitizeErrorMessage(error)}`));
        }

        checkCancelled();
        await delay(20, undefined, { signal });
        checkCancelled();
      }

      logger.info(`[IndexingWorkflow] Total chunks created: ${chunks.length}`);

      let injectionWarnings = 0;
      for (const chunk of chunks) {
        const injectionResult = detectPromptInjection(chunk.content);
        if (injectionResult.hasInjection) {
          injectionWarnings++;
          if (injectionResult.maxSeverity === 'high') {
            logger.debug(
              `[Security] Prompt injection pattern detected in ${chunk.path || 'unknown'}: ${injectionResult.detections[0]?.description}`
            );
          }
        }
      }
      if (injectionWarnings > 0) {
        logger.debug(
          `[Security] Detected ${injectionWarnings} chunks with potential prompt injection patterns in ${url}. Content will be marked when returned in search results.`
        );
      }

      checkCancelled();

      if (chunks.length === 0) {
        logger.warn(`[IndexingWorkflow] No content was extracted from ${url}`);
        logger.warn(`[IndexingWorkflow] Pages found: ${pages.length}`);
        logger.warn(`[IndexingWorkflow] Chunks created: ${chunks.length}`);
        statusTracker.failIndexing(operationId, 'No content was extracted from the pages');
        return;
      }

      checkCancelled();

      const favicon = await this.dependencies.fetchFavicon(new URL(url));
      checkCancelled();
      statusTracker.updateProgress(operationId, 0.9, `Storing ${chunks.length} chunks`);
      await this.addDocumentWithRetry(
        {
          metadata: {
            url,
            title,
            favicon: favicon ?? undefined,
            lastIndexed: new Date(),
            requiresAuth: authInfo?.requiresAuth,
            authDomain: authInfo?.authDomain,
            version,
            pathPrefix,
          },
          chunks,
        },
        signal,
        tags
      );
      checkCancelled();

      if (tags && tags.length > 0) {
        logger.info(`[IndexingWorkflow] Tags set for ${url}:`, tags);
      }
      else {
        logger.debug(`[IndexingWorkflow] Tags cleared for ${url}`);
      }

      logger.info(`[IndexingWorkflow] Successfully indexed ${url}`);
      logger.info(`[IndexingWorkflow] Pages processed: ${pages.length}`);
      logger.info(`[IndexingWorkflow] Chunks stored: ${chunks.length}`);
      statusTracker.updateStats(operationId, { chunksCreated: chunks.length });
      statusTracker.completeIndexing(operationId);

      store.optimize().catch((error) => {
        logger.warn('[IndexingWorkflow] Background optimization failed:', error);
      });
    }
    catch (error) {
      if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
        if (signal.aborted && statusTracker.getStatus(operationId)?.status !== 'cancelled') {
          statusTracker.cancelIndexing(operationId);
        }
        logger.info(`[IndexingWorkflow] Indexing cancelled for ${url}`);
        return;
      }

      if (error instanceof SessionExpiredError) {
        logger.warn(`[IndexingWorkflow] Session expired during crawl of ${url}: ${error.message}`);
        logger.warn(`[IndexingWorkflow] Expected URL: ${error.expectedUrl}, Detected URL: ${error.detectedUrl}`);
        await authManager.clearSession(url);
        checkCancelled();
        logger.info(`[IndexingWorkflow] Cleared expired session for ${url}`);
        statusTracker.failIndexing(
          operationId,
          `Authentication session has expired. The crawler was redirected to a login page. Please use the 'authenticate' tool to log in again before re-indexing.`
        );
        return;
      }

      logger.error('[IndexingWorkflow] Error during indexing:', error);
      logger.error('[IndexingWorkflow] Error details:', error instanceof Error ? error.stack : error);
      statusTracker.failIndexing(operationId, error instanceof Error ? error.message : 'Unknown error');
    }
  }

  private async addDocumentWithRetry(
    doc: Parameters<WorkflowStore['addDocument']>[0],
    signal: AbortSignal,
    tags?: string[],
    maxRetries = 3
  ): Promise<void> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      signal.throwIfAborted();
      try {
        await this.dependencies.store.addDocument(doc, { signal, tags: tags ?? [] });
        return;
      }
      catch (error) {
        const isRetryable =
          error instanceof Error && (error.message.includes('Commit conflict') || error.message.startsWith('Replacement lease lost for '));
        if (isRetryable && attempt < maxRetries) {
          logger.warn(`[IndexingWorkflow] Storage conflict, retrying (${attempt}/${maxRetries})...`);
          await delay(1000 * attempt, undefined, { signal });
          continue;
        }
        throw error;
      }
    }
  }
}
