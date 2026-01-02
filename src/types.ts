export interface IndexingStatus {
  id: string;
  url: string;
  title: string;
  status: 'pending' | 'indexing' | 'complete' | 'failed' | 'aborted' | 'cancelled';
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

export interface CrawlResult {
  url: string;
  path: string;
  content: string;
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
  /** Filter results to documentation sites that have ALL of the specified tags */
  filterByTags?: string[];
}

export interface StorageProvider {
  initialize(): Promise<void>;
  addDocument(doc: ProcessedDocument): Promise<void>;
  searchDocuments(queryVector: number[], options?: SearchOptions): Promise<SearchResult[]>;
  searchByText(query: string, options?: SearchOptions): Promise<SearchResult[]>;
  listDocuments(): Promise<DocumentMetadata[]>;
  deleteDocument(url: string): Promise<void>;
  getDocument(url: string): Promise<DocumentMetadata | null>;
  /** Set tags for a documentation site (replaces existing tags) */
  setTags(url: string, tags: string[]): Promise<void>;
  /** List all unique tags with their usage counts */
  listAllTags(): Promise<Array<{ tag: string; count: number }>>;
  /** Get URLs of documents that have ALL of the specified tags */
  getUrlsByTags(tags: string[]): Promise<string[]>;
  /** Optimize storage by compacting data and cleaning up old versions */
  optimize(): Promise<{ compacted: boolean; cleanedUp: boolean; error?: string }>;
}

export type DocsCrawlerType = 'crawlee' | 'github';

export interface CrawlerOptions {
  maxDepth?: number;
  maxRequestsPerCrawl?: number;
  useLocalCrawling?: boolean;
  githubToken?: string;
  onProgress?: (progress: number, description: string) => void;
  experimental?: {
    useChromiumForDocsCrawling?: boolean;
  };
}

export interface WebCrawler {
  crawl(url: string, maxDepth?: number): AsyncGenerator<CrawlResult, DocsCrawlerType, unknown>;
  abort(): void;
}

export interface DocumentProcessor {
  process(crawlResult: CrawlResult, chunkSize?: number): Promise<ProcessedDocument>;
}
