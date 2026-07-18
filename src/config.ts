import { join } from 'path';
import { homedir } from 'os';
import { mkdir } from 'fs/promises';
import { logger } from './util/logger.js';
import { validatePublicUrl } from './util/security.js';

export interface DocsConfig {
  githubToken?: string;
  maxChunkSize: number;
  cacheSize: number;
  dataDir: string;
  dbPath: string;
  vectorDbPath: string;
}

const DATA_DIR = join(homedir(), '.mcp-web-docs');

const DEFAULT_CONFIG: DocsConfig = {
  maxChunkSize: 1000,
  cacheSize: 1000,
  dataDir: DATA_DIR,
  dbPath: join(DATA_DIR, 'docs.db'),
  vectorDbPath: join(DATA_DIR, 'vectors'),
};

export async function loadConfig(): Promise<DocsConfig> {
  logger.debug('[Config] Loading configuration');

  // Optional GitHub token for higher rate limits
  const githubToken = process.env.GITHUB_TOKEN;
  if (githubToken) {
    logger.debug('[Config] GitHub token found');
  }

  // Ensure data directory exists and set up Crawlee storage
  try {
    logger.debug(`[Config] Creating data directory: ${DATA_DIR}`);
    await mkdir(DATA_DIR, { recursive: true });

    // Set Crawlee storage directory
    const crawleeStorageDir = join(DATA_DIR, 'crawlee');
    process.env.CRAWLEE_STORAGE_DIR = crawleeStorageDir;
    await mkdir(crawleeStorageDir, { recursive: true });
  }
  catch (error) {
    logger.debug('[Config] Error creating data directory:', error);
    throw error;
  }

  const config: DocsConfig = {
    ...DEFAULT_CONFIG,
    githubToken,
  };

  logger.debug('[Config] Configuration loaded:', {
    ...config,
    githubToken: githubToken ? '***' : undefined,
  });

  return config;
}

// Rate limiting constants
export const RATE_LIMIT = {
  maxRequests: 60, // Increased for better throughput
  timeWindow: 60 * 1000, // 1 minute
  minDelay: 250, // Reduced delay between requests
};

// Utility function to validate URLs
export function isValidUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    return url.protocol === 'http:' || url.protocol === 'https:';
  }
  catch {
    return false;
  }
}

/**
 * Validate URL and check for SSRF attacks (blocks private/internal networks)
 * @param urlString - URL to validate
 * @param allowPrivate - If true, skips SSRF checks (for trusted internal use)
 * @returns true if URL is valid and safe
 */
export function isValidPublicUrl(urlString: string, allowPrivate = false): boolean {
  if (!isValidUrl(urlString)) {
    return false;
  }

  if (allowPrivate) {
    return true;
  }

  try {
    validatePublicUrl(urlString);
    return true;
  }
  catch (error) {
    logger.debug(`[Config] URL blocked by SSRF protection: ${urlString}`, error);
    return false;
  }
}

// Utility function to normalize URLs
export function normalizeUrl(urlString: string): string {
  try {
    const url = new URL(urlString);
    // Remove trailing slash
    return url.toString().replace(/\/$/, '');
  }
  catch {
    throw new Error(`Invalid URL: ${urlString}`);
  }
}

// Utility function to check if a URL is a GitHub repository
export function isGitHubUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    return url.hostname === 'github.com';
  }
  catch {
    return false;
  }
}
