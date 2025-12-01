import { EmbeddingModel, FlagEmbedding } from 'fastembed';
import { EmbeddingsProvider } from './types.js';
import { logger } from '../util/logger.js';
import { mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// FastEmbed configuration
const EMBEDDING_MODEL = EmbeddingModel.BGESmallENV15;
const EMBEDDING_DIMENSIONS = 384; // bge-small-en-v1.5 dimensions
const MAX_RETRIES = 3;
const CACHE_DIR = join(homedir(), '.mcp-web-docs', 'fastembed-cache');

export class FastEmbeddings implements EmbeddingsProvider {
  private model: FlagEmbedding | null = null;
  private modelInitPromise: Promise<FlagEmbedding> | null = null;
  private cache: Map<string, number[]>;
  readonly dimensions = EMBEDDING_DIMENSIONS;

  constructor() {
    this.cache = new Map();
    logger.info(`[FastEmbeddings] Using model: ${EMBEDDING_MODEL}, dimensions: ${EMBEDDING_DIMENSIONS}`);
  }

  /**
   * Initialize the FastEmbed model (lazy initialization)
   */
  private async initialize(): Promise<FlagEmbedding> {
    // Return existing model if already initialized
    if (this.model) {
      return this.model;
    }

    // Wait for existing initialization if in progress
    if (this.modelInitPromise) {
      return this.modelInitPromise;
    }

    // Start initialization
    this.modelInitPromise = this.initializeModel();
    return this.modelInitPromise;
  }

  private async initializeModel(): Promise<FlagEmbedding> {
    try {
      // Ensure cache directory exists
      if (!existsSync(CACHE_DIR)) {
        logger.debug(`[FastEmbeddings] Creating cache directory: ${CACHE_DIR}`);
        await mkdir(CACHE_DIR, { recursive: true });
      }

      logger.info(`[FastEmbeddings] Initializing model (cache: ${CACHE_DIR})`);

      let retries = 0;
      while (retries < MAX_RETRIES) {
        try {
          this.model = await FlagEmbedding.init({
            model: EMBEDDING_MODEL,
            cacheDir: CACHE_DIR,
          });

          logger.info('[FastEmbeddings] Model initialized successfully');
          this.modelInitPromise = null;
          return this.model;
        } catch (initError) {
          retries++;
          logger.warn(`[FastEmbeddings] Initialization attempt ${retries}/${MAX_RETRIES} failed: ${initError}`);

          if (retries >= MAX_RETRIES) {
            throw initError;
          }

          // Wait before retrying (exponential backoff)
          await new Promise(resolve => setTimeout(resolve, retries * 2000));
        }
      }

      throw new Error('Failed to initialize model after max retries');
    } catch (error) {
      this.modelInitPromise = null;
      logger.error('[FastEmbeddings] Fatal: Failed to initialize model:', error);
      throw error;
    }
  }

  /**
   * Generate embedding for a single text (for documents/passages)
   */
  async embed(text: string): Promise<number[]> {
    if (!text || typeof text !== 'string') {
      throw new Error('Input text must be a non-empty string');
    }

    const cleanText = text.trim();
    if (!cleanText) {
      throw new Error('Input text is empty after trimming');
    }

    // Check cache first
    const cacheKey = cleanText.slice(0, 200);
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    try {
      const model = await this.initialize();

      // Use passageEmbed for documents/content
      const embeddingGenerator = model.passageEmbed([cleanText]);

      let embedding: number[] | null = null;
      for await (const batch of embeddingGenerator) {
        if (batch && batch.length > 0 && batch[0]) {
          embedding = Array.from(batch[0]);
          break;
        }
      }

      if (!embedding || embedding.length !== this.dimensions) {
        throw new Error(
          `Invalid embedding: got ${embedding?.length} dimensions, expected ${this.dimensions}`
        );
      }

      // Cache the result
      this.cache.set(cacheKey, embedding);

      // Limit cache size
      if (this.cache.size > 1000) {
        const firstKey = this.cache.keys().next().value;
        if (firstKey) {
          this.cache.delete(firstKey);
        }
      }

      return embedding;
    } catch (error) {
      logger.error('[FastEmbeddings] Error generating embedding:', error);
      throw error;
    }
  }

  /**
   * Generate embedding for a query (optimized for search)
   */
  async embedQuery(text: string): Promise<number[]> {
    if (!text || typeof text !== 'string') {
      throw new Error('Input text must be a non-empty string');
    }

    const cleanText = text.trim();
    if (!cleanText) {
      throw new Error('Input text is empty after trimming');
    }

    // Check cache with query prefix
    const cacheKey = `query:${cleanText.slice(0, 200)}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    try {
      const model = await this.initialize();

      // Use queryEmbed for search queries
      const embeddingArray = await model.queryEmbed(cleanText);

      if (!embeddingArray || embeddingArray.length !== this.dimensions) {
        throw new Error(
          `Invalid query embedding: got ${embeddingArray?.length} dimensions, expected ${this.dimensions}`
        );
      }

      const embedding = Array.from(embeddingArray);

      // Cache the result
      this.cache.set(cacheKey, embedding);

      return embedding;
    } catch (error) {
      logger.error('[FastEmbeddings] Error generating query embedding:', error);
      throw error;
    }
  }

  /**
   * Generate embeddings for multiple texts in batch
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    if (!Array.isArray(texts) || texts.length === 0) {
      return [];
    }

    const validTexts = texts.filter(t => typeof t === 'string' && t.trim().length > 0);
    if (validTexts.length === 0) {
      return texts.map(() => []);
    }

    try {
      const model = await this.initialize();
      const embeddings: number[][] = [];

      for await (const batch of model.passageEmbed(validTexts)) {
        for (const vec of batch) {
          if (vec && vec.length === this.dimensions) {
            embeddings.push(Array.from(vec));
          } else {
            logger.warn(`[FastEmbeddings] Invalid batch embedding dimension: ${vec?.length}`);
            embeddings.push(new Array(this.dimensions).fill(0));
          }
        }
      }

      return embeddings;
    } catch (error) {
      logger.error('[FastEmbeddings] Error generating batch embeddings:', error);
      throw error;
    }
  }
}

