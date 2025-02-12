export interface IndexingStatus {
  id: string;
  url: string;
  title: string;
  status: 'pending' | 'indexing' | 'complete' | 'failed' | 'aborted';
  progress: number;
  description: string;
  error?: string;
}

export interface DocumentMetadata {
  url: string;
  title: string;
  favicon?: string;
  lastIndexed: Date;
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
    type: 'overview';  // Default type, let embeddings determine actual content type
  };
}

export interface CrawlResult {
  url: string;
  path: string;
  content: string;
  title: string;
  extractorUsed?: string;  // Optional field to track which extractor was used
}

export interface ProcessedDocument {
  metadata: DocumentMetadata;
  chunks: DocumentChunk[];
}

export interface SearchResult {
  content: string;
  url: string;
  title: string;
  score: number;
}

export interface StorageProvider {
  initialize(): Promise<void>;
  addDocument(doc: ProcessedDocument): Promise<void>;
  searchDocuments(query: string, limit?: number): Promise<SearchResult[]>;
  listDocuments(): Promise<DocumentMetadata[]>;
  deleteDocument(url: string): Promise<void>;
  getDocument(url: string): Promise<DocumentMetadata | null>;
}

export type DocsCrawlerType = 'default' | 'chromium' | 'cheerio' | 'github';

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
