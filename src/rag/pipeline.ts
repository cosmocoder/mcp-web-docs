import { QueryProcessor } from "./query-processor.js";
import { DocumentStore } from "../storage/storage.js";
import { EmbeddingsProvider } from "../embeddings/types.js";
import { OpenAIEmbeddings } from "../embeddings/openai.js";
import { ContextRetriever } from "./retriever.js";
import { ContextAssembler } from "./context-assembler.js";
import { ResponseGenerator, GeneratedResponse } from "./response-generator.js";
import { ResponseValidator, ValidationResult } from "./validator.js";
import { VersionManager } from "./version-manager.js";
import { RAGCache } from "./cache.js";
import { logger } from "../util/logger.js";

export interface RAGResponse {
  response: GeneratedResponse;
  validation: ValidationResult;
}

export interface RAGConfig {
  openaiApiKey: string;
  dbPath: string;
  vectorDbPath: string;
  maxCacheSize?: number;
}

export class RAGPipeline {
  private queryProcessor: QueryProcessor;
  private contextRetriever: ContextRetriever;
  private contextAssembler: ContextAssembler;
  private responseGenerator: ResponseGenerator;
  private responseValidator: ResponseValidator;
  private versionManager: VersionManager;
  private cache: RAGCache;
  private store: DocumentStore;
  private embeddings: EmbeddingsProvider;

  constructor(config: RAGConfig) {
    // Initialize embeddings provider
    this.embeddings = new OpenAIEmbeddings(config.openaiApiKey);

    // Initialize storage
    this.store = new DocumentStore(
      config.dbPath,
      config.vectorDbPath,
      this.embeddings,
      config.maxCacheSize
    );

    // Initialize RAG components
    this.queryProcessor = new QueryProcessor(config.openaiApiKey, this.embeddings);
    this.contextRetriever = new ContextRetriever(this.store, this.embeddings);
    this.contextAssembler = new ContextAssembler();
    this.responseGenerator = new ResponseGenerator(config.openaiApiKey);
    this.responseValidator = new ResponseValidator(config.openaiApiKey);
    this.versionManager = new VersionManager();
    this.cache = new RAGCache();
  }

  async initialize(): Promise<void> {
    await this.store.initialize();
  }

  async process(query: string): Promise<RAGResponse> {
    // Check cache first
    const cached = await this.cache.getCachedResponse(query);
    if (cached) {
      return {
        response: cached.response,
        validation: {
          factCheck: true,
          codeCheck: true,
          consistencyCheck: true,
          details: {
            factCheckDetails: [],
            codeCheckDetails: [],
            consistencyCheckDetails: []
          }
        }
      };
    }

    try {
      // Process query and determine intent
      const queryIntent = await this.queryProcessor.processQuery(query);
      logger.debug('Query intent classified:', queryIntent);

      // Retrieve relevant context
      const retrieval = await this.contextRetriever.retrieveContext(queryIntent, {
        limit: 10,
        minScore: 0.7,
        filterByIntent: true
      });
      logger.debug('Retrieved context chunks:', retrieval.chunks.length);

      // Assemble context
      const assembled = await this.contextAssembler.assembleContext(retrieval.chunks);
      logger.debug('Assembled context with relationships');

      // Apply version awareness
      await this.versionManager.getVersionedContext(assembled, "1.0");
      logger.debug('Applied version context');

      // Generate response
      const generatedResponse = await this.responseGenerator.generateResponse(assembled, queryIntent);
      logger.debug('Generated response');

      // Validate response
      const validation = await this.responseValidator.validateResponse(generatedResponse, assembled);
      logger.debug('Validated response:', validation);

      // Cache if validation passed
      if (validation.factCheck && validation.codeCheck && validation.consistencyCheck) {
        await this.cache.cacheResponse(query, generatedResponse);
      }

      return { response: generatedResponse, validation };
    } catch (error) {
      logger.debug('Error processing RAG pipeline:', error);
      throw error;
    }
  }
}
