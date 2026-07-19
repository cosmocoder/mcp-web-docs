export interface IndexingStatus {
  operationId: string;
  documentId: string;
  /** Compatibility alias retained for existing clients; always matches documentId. */
  id: string;
  url: string;
  title: string;
  status: 'pending' | 'indexing' | 'complete' | 'failed' | 'cancelled';
  progress: number;
  description: string;
  error?: string;
  // Enhanced tracking fields
  startedAt?: Date;
  pagesFound?: number;
  pagesProcessed?: number;
  chunksCreated?: number;
}

export interface DocumentMetadata {
  url: string;
  title: string;
  favicon?: string;
  lastIndexed: Date;
  /** Whether this documentation site requires authentication to access */
  requiresAuth?: boolean;
  /** The domain where the auth session is stored (e.g., "github.com" for GitHub auth) */
  authDomain?: string;
  /** User-defined tags for categorizing documentation (e.g., "frontend", "mycompany") */
  tags?: string[];
  /** Version of the documentation (e.g., "18", "v6.4", "3.11") for versioned packages */
  version?: string;
  /** Optional URL path restriction used when crawling this documentation site */
  pathPrefix?: string;
}

export interface DocumentChunk {
  content: string;
  url: string;
  title: string;
  path: string;
  startLine: number;
  endLine: number;
  vector: number[];
  metadata: {
    type: 'overview' | 'api' | 'example' | 'usage';
    version?: string;
    framework?: string;
    language?: string;
    codeBlocks?: {
      code: string;
      language: string;
      context: string;
    }[];
    props?: {
      name: string;
      type: string;
      required: boolean;
      defaultValue?: string;
      description: string;
    }[];
  };
}

export type ContentFormat = 'markdown' | 'text';

export interface CrawlResult {
  url: string;
  path: string;
  content: string;
  contentFormat: ContentFormat;
  title: string;
  extractorUsed?: string; // Optional field to track which extractor was used
}

export interface ProcessedDocument {
  metadata: DocumentMetadata;
  chunks: DocumentChunk[];
}

export interface SearchResult {
  id: string;
  content: string;
  url: string;
  title: string;
  score: number;
  vector?: number[]; // Make vector optional
  metadata: {
    type: 'overview' | 'api' | 'example' | 'usage';
    path: string;
    lastUpdated: Date;
    version?: string;
    framework?: string;
    language?: string;
    codeBlocks?: {
      code: string;
      language: string;
      context: string;
    }[];
    props?: {
      name: string;
      type: string;
      required: boolean;
      defaultValue?: string;
      description: string;
    }[];
  };
}

export interface SearchOptions {
  limit?: number;
  includeVectors?: boolean;
  filterByType?: 'overview' | 'api' | 'example' | 'usage' | 'component_usage' | 'concept' | 'troubleshooting' | 'general';
  textQuery?: string;
  /** Filter results to a specific documentation site by its base URL */
  filterUrl?: string;
  /** Restrict results to this exact set of document URLs; an empty list matches nothing */
  filterUrls?: string[];
  /** Filter results to documentation sites that have ALL of the specified tags */
  filterByTags?: string[];
}

export interface AddDocumentOptions {
  signal?: AbortSignal;
  tags?: string[];
}

// ============ Collections ============

/**
 * A collection groups related documentation sites together.
 * For example, "My React Project" might contain React, Next.js, and TypeScript docs.
 */
export interface Collection {
  /** Unique name/identifier for the collection */
  name: string;
  /** Optional description of the collection's purpose */
  description?: string;
  /** When the collection was created */
  createdAt: Date;
  /** When the collection was last modified */
  updatedAt: Date;
  /** Number of documents in this collection (for list views) */
  documentCount?: number;
}

/**
 * A collection with its full list of documents.
 * Used when fetching a specific collection's details.
 */
export interface CollectionWithDocuments extends Collection {
  /** The documentation sites in this collection */
  documents: DocumentMetadata[];
}
