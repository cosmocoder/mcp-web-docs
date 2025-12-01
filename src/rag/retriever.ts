import { EnhancedChunk } from "../types/rag.js";
import { EmbeddingsProvider } from "../embeddings/types.js";
import { DocumentStore } from "../storage/storage.js";
import { QueryIntent, QueryIntentType } from "./query-processor.js";
import { SearchResult } from "../types.js";
import { logger } from "../util/logger.js";

export interface RetrievalResult {
  chunks: EnhancedChunk[];
  relevanceScores: number[];
}

export interface RetrievalOptions {
  limit?: number;
  minScore?: number;
  filterByIntent?: boolean;
}

export class ContextRetriever {
  constructor(
    private readonly store: DocumentStore,
    private readonly embeddings: EmbeddingsProvider
  ) {}

  async retrieveContext(
    queryIntent: QueryIntent,
    options: RetrievalOptions = {}
  ): Promise<RetrievalResult> {
    const {
      limit = 10,
      minScore = 0.7,
      filterByIntent = true
    } = options;

    logger.debug(`[ContextRetriever] Retrieving context for intent: ${queryIntent.intent}`, {
      embedding: {
        length: queryIntent.embedding.length,
        sample: queryIntent.embedding.slice(0, 5)
      },
      options: { limit, minScore, filterByIntent }
    });

    // Validate the embedding
    if (!queryIntent.embedding || queryIntent.embedding.length === 0) {
      logger.debug('[ContextRetriever] Empty embedding in queryIntent');
      return { chunks: [], relevanceScores: [] };
    }

    // Search for relevant chunks using the original query embedding
    logger.debug(`[ContextRetriever] Searching documents with embedding of length ${queryIntent.embedding.length}`);
    // Cast to any to work around TypeScript errors with the StorageProvider interface
    const searchResults = await (this.store as any).searchDocuments(
      queryIntent.embedding, // Use the pre-computed query embedding
      {
        limit: limit * 2, // Get more results initially for filtering
        includeVectors: true, // Need vectors for filtering
        filterByType: filterByIntent ? queryIntent.intent : undefined
      }
    );

    logger.debug(`[ContextRetriever] Search returned ${searchResults.length} results`);

    // Filter and process results
    const filteredResults = searchResults
      .filter((result: SearchResult) => {
        // Apply minimum relevance score threshold
        if (result.score < minScore) {
          logger.debug(`[ContextRetriever] Filtering out result with score ${result.score} < ${minScore}`);
          return false;
        }

        if (filterByIntent) {
          // Additional intent-based filtering logic here
          // For example, for API queries, prioritize chunks with API documentation
          // Map intent to metadata type
          const typeMap: Record<QueryIntentType, string[]> = {
            'overview': ['overview'],
            'api': ['api'],
            'example': ['example'],
            'usage': ['usage', 'overview'],
            'component_usage': ['usage', 'overview'],
            'concept': ['overview'],
            'troubleshooting': ['example', 'usage'],
            'general': ['overview', 'api', 'example', 'usage']
          };

          const allowedTypes = typeMap[queryIntent.intent] || ['overview'];
          const resultType = result.metadata?.type || 'overview';
          const isAllowed = allowedTypes.includes(resultType);

          if (!isAllowed) {
            logger.debug(`[ContextRetriever] Filtering out result with type ${resultType} not in allowed types:`, allowedTypes);
            return false;
          }
        }

        return true;
      })
      .slice(0, limit);

    logger.debug(`[ContextRetriever] After filtering, ${filteredResults.length} results remain`);

    // Convert search results to EnhancedChunks
    const chunks: EnhancedChunk[] = filteredResults.map((result: SearchResult) => {
      // Log vector information for debugging
      logger.debug(`[ContextRetriever] Processing result:`, {
        id: result.id,
        score: result.score,
        hasVector: !!result.vector,
        vectorLength: result.vector ? result.vector.length : 'N/A'
      });

      // Use the vector from the search result if available, otherwise create a default vector
      const embedding = result.vector && Array.isArray(result.vector) && result.vector.length > 0
        ? result.vector
        : new Array(this.embeddings.dimensions).fill(0);

      return {
        id: result.id,
        content: result.content,
        embedding,
        metadata: {
          sourceReliability: 1.0, // Default reliability score
          lastVerified: new Date(),
          citationInfo: {
            version: "1.0", // Default version
          },
          contextualSummary: result.content.substring(0, 200), // Simple summary
          prerequisites: [],
          validationRules: {
            constraints: [],
            requirements: []
          },
          semanticTags: queryIntent.entities,
          complexity: 'basic', // Default complexity
          type: result.metadata?.type || 'overview', // Use type from search result or default to overview
          framework: result.metadata?.framework,
          language: result.metadata?.language
        },
        relationships: []
      };
    });

    return {
      chunks,
      relevanceScores: filteredResults.map((r: SearchResult) => r.score)
    };
  }
}
