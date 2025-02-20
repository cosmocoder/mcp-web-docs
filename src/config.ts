import { join } from 'path';
import { homedir } from 'os';
import { mkdir } from 'fs/promises';

export interface DocsConfig {
  openaiApiKey: string;
  githubToken?: string;
  maxDepth: number;
  maxRequestsPerCrawl: number;
  maxChunkSize: number;
  maxConcurrentRequests: number;
  cacheSize: number;
  dbPath: string;
  vectorDbPath: string;
}

const DATA_DIR = join(homedir(), '.mcp-web-docs');

const DEFAULT_CONFIG: Omit<DocsConfig, 'openaiApiKey'> = {
  maxDepth: 4,
  maxRequestsPerCrawl: 1000, // Match DocsCrawler default for better coverage
  maxChunkSize: 1000,
  maxConcurrentRequests: 3, // Allow concurrent requests for better performance while maintaining stability
  cacheSize: 1000,
  dbPath: join(DATA_DIR, 'docs.db'),
  vectorDbPath: join(DATA_DIR, 'vectors')
};

export async function loadConfig(): Promise<DocsConfig> {
  console.debug('[Config] Loading configuration');

  const openaiApiKey = process.env.OPENAI_API_KEY;
  if (!openaiApiKey) {
    throw new Error('OPENAI_API_KEY environment variable is required');
  }

  // Optional GitHub token for higher rate limits
  const githubToken = process.env.GITHUB_TOKEN;
  if (githubToken) {
    console.debug('[Config] GitHub token found');
  }

  // Ensure data directory exists and set up Crawlee storage
  try {
    console.debug(`[Config] Creating data directory: ${DATA_DIR}`);
    await mkdir(DATA_DIR, { recursive: true });

    // Set Crawlee storage directory
    const crawleeStorageDir = join(DATA_DIR, 'crawlee');
    process.env.CRAWLEE_STORAGE_DIR = crawleeStorageDir;
    await mkdir(crawleeStorageDir, { recursive: true });
  } catch (error) {
    console.error('[Config] Error creating data directory:', error);
    throw error;
  }

  const config = {
    ...DEFAULT_CONFIG,
    openaiApiKey,
    githubToken
  };

  console.debug('[Config] Configuration loaded:', {
    ...config,
    openaiApiKey: '***',
    githubToken: githubToken ? '***' : undefined
  });

  return config;
}

// Constants for indexing
export const IGNORED_PATHS = [
  'favicon.ico',
  'robots.txt',
  '.rst.txt',
  'genindex',
  'py-modindex',
  'search.html',
  'search',
  'genindex.html',
  'changelog',
  'changelog.html',
  'assets/',
  'static/',
  'images/',
  'img/',
  'css/',
  'js/',
  'fonts/',
  // Common repository paths to ignore
  'node_modules/',
  'vendor/',
  'test/',
  'tests/',
  'example/',
  'examples/',
  'build/',
  'dist/',
  '.git/'
];

// Rate limiting constants
export const RATE_LIMIT = {
  maxRequests: 60, // Increased for better throughput
  timeWindow: 60 * 1000, // 1 minute
  minDelay: 250 // Reduced delay between requests
};

// Queue configuration
export const QUEUE_OPTIONS = {
  maxRequestRetries: 2,
  retryDelay: 1000,
  maxRequestsPerCrawl: 2000 // Increased from default 1000
};

// GitHub API rate limits
export const GITHUB_RATE_LIMIT = {
  unauthenticated: {
    maxRequests: 60,
    timeWindow: 60 * 60 * 1000 // 1 hour
  },
  authenticated: {
    maxRequests: 5000,
    timeWindow: 60 * 60 * 1000 // 1 hour
  }
};

// Utility function to validate URLs
export function isValidUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

// Utility function to normalize URLs
export function normalizeUrl(urlString: string): string {
  try {
    const url = new URL(urlString);
    // Remove trailing slash
    return url.toString().replace(/\/$/, '');
  } catch {
    throw new Error(`Invalid URL: ${urlString}`);
  }
}

// Utility function to check if a URL is a GitHub repository
export function isGitHubUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    return url.hostname === 'github.com';
  } catch {
    return false;
  }
}

// Utility function to check if a path is markdown
export function isMarkdownPath(path: string): boolean {
  const lowercasePath = path.toLowerCase();
  return lowercasePath.endsWith('.md') ||
         lowercasePath.endsWith('.mdx') ||
         lowercasePath.endsWith('.markdown');
}