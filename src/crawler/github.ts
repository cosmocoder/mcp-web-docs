import { URL } from 'url';
import { CrawlResult } from '../types.js';
import { BaseCrawler } from './base.js';
import { logger } from '../util/logger.js';

interface GitHubFile {
  path: string;
  type: 'file' | 'dir';
  url: string;
  content?: string;
}

export class GitHubCrawler extends BaseCrawler {
  private readonly API_BASE = 'https://api.github.com';
  private readonly RAW_CONTENT_BASE = 'https://raw.githubusercontent.com';
  private readonly MARKDOWN_EXTENSIONS = ['.md', '.mdx', '.markdown'];
  private readonly DOCUMENTATION_PATHS = ['docs', 'doc', 'documentation', 'wiki', 'guide', 'guides', 'tutorial', 'tutorials'];

  constructor(
    maxDepth: number = 4,
    maxRequestsPerCrawl: number = 1000,
    private readonly githubToken?: string,
    onProgress?: (progress: number, description: string) => void
  ) {
    super(maxDepth, maxRequestsPerCrawl, onProgress);
  }

  async *crawl(url: string): AsyncGenerator<CrawlResult, void, unknown> {
    logger.debug(`[${this.constructor.name}] Crawling GitHub repository: ${url}`);

    if (this.isAborting) {
      logger.debug('[GitHubCrawler] Crawl aborted');
      return;
    }

    try {
      const repoInfo = this.parseGitHubUrl(url);
      if (!repoInfo) {
        throw new Error(`Invalid GitHub URL: ${url}`);
      }

      // First try to find documentation directory
      const docDirs = await this.findDocumentationDirs(repoInfo);

      if (docDirs.length > 0) {
        // Process documentation directories
        for (const docDir of docDirs) {
          if (this.isAborting) break;
          yield* this.processDirectory(repoInfo, docDir);
        }
      } else {
        // Fall back to processing markdown files in root
        logger.debug('[GitHubCrawler] No documentation directory found, processing root markdown files');
        yield* this.processDirectory(repoInfo, '');
      }
    } catch (error) {
      logger.debug('[GitHubCrawler] Error crawling repository:', error);
    }
  }

  private parseGitHubUrl(url: string): { owner: string; repo: string; branch: string } | null {
    try {
      const urlObj = new URL(url);
      if (urlObj.hostname !== 'github.com') return null;

      const [, owner, repo] = urlObj.pathname.split('/');
      if (!owner || !repo) return null;

      // Remove .git extension if present
      const cleanRepo = repo.replace(/\.git$/, '');

      return {
        owner,
        repo: cleanRepo,
        branch: 'main', // Default to main, could be determined dynamically
      };
    } catch {
      return null;
    }
  }

  private async findDocumentationDirs(repoInfo: { owner: string; repo: string; branch: string }): Promise<string[]> {
    const dirs: string[] = [];

    try {
      const contents = await this.fetchRepoContents(repoInfo, '');

      for (const item of contents) {
        if (item.type === 'dir' && this.DOCUMENTATION_PATHS.some((path) => item.path.toLowerCase() === path.toLowerCase())) {
          dirs.push(item.path);
        }
      }
    } catch (error) {
      logger.debug('[GitHubCrawler] Error finding documentation directories:', error);
    }

    return dirs;
  }

  private async *processDirectory(repoInfo: { owner: string; repo: string; branch: string }, path: string): AsyncGenerator<CrawlResult> {
    try {
      const contents = await this.fetchRepoContents(repoInfo, path);

      for (const item of contents) {
        if (this.isAborting) break;

        if (item.type === 'file' && this.isMarkdownFile(item.path)) {
          const content = await this.fetchFileContent(repoInfo, item.path);
          if (content) {
            yield {
              url: this.constructGitHubUrl(repoInfo, item.path),
              path: item.path,
              content,
              title: this.extractTitleFromPath(item.path),
            };
          }
        } else if (item.type === 'dir' && this.shouldProcessDirectory(item.path)) {
          yield* this.processDirectory(repoInfo, item.path);
        }
      }
    } catch (error) {
      logger.debug(`[GitHubCrawler] Error processing directory ${path}:`, error);
    }
  }

  private async fetchRepoContents(repoInfo: { owner: string; repo: string; branch: string }, path: string): Promise<GitHubFile[]> {
    await this.rateLimit();

    const url = `${this.API_BASE}/repos/${repoInfo.owner}/${repoInfo.repo}/contents/${path}`;
    const headers: HeadersInit = {
      Accept: 'application/vnd.github.v3+json',
    };

    if (this.githubToken) {
      headers['Authorization'] = `token ${this.githubToken}`;
    }

    try {
      const response = await fetch(url, { headers });

      if (!response.ok) {
        if (response.status === 403) {
          throw new Error('GitHub API rate limit exceeded');
        }
        throw new Error(`GitHub API error: ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      logger.debug(`[GitHubCrawler] Error fetching repo contents for ${path}:`, error);
      return [];
    }
  }

  private async fetchFileContent(repoInfo: { owner: string; repo: string; branch: string }, path: string): Promise<string | null> {
    await this.rateLimit();

    const url = `${this.RAW_CONTENT_BASE}/${repoInfo.owner}/${repoInfo.repo}/${repoInfo.branch}/${path}`;
    const headers: HeadersInit = this.githubToken ? { Authorization: `token ${this.githubToken}` } : {};

    try {
      const response = await fetch(url, { headers });

      if (!response.ok) {
        throw new Error(`Failed to fetch file content: ${response.status}`);
      }

      return await response.text();
    } catch (error) {
      logger.debug(`[GitHubCrawler] Error fetching content for ${path}:`, error);
      return null;
    }
  }

  private isMarkdownFile(path: string): boolean {
    const lowercasePath = path.toLowerCase();
    return this.MARKDOWN_EXTENSIONS.some((ext) => lowercasePath.endsWith(ext));
  }

  private shouldProcessDirectory(path: string): boolean {
    const lowercasePath = path.toLowerCase();
    // Skip common non-documentation directories
    return (
      !lowercasePath.includes('node_modules') &&
      !lowercasePath.includes('vendor') &&
      !lowercasePath.includes('test') &&
      !lowercasePath.includes('example') &&
      !lowercasePath.includes('build') &&
      !lowercasePath.includes('dist')
    );
  }

  private constructGitHubUrl(repoInfo: { owner: string; repo: string; branch: string }, path: string): string {
    return `https://github.com/${repoInfo.owner}/${repoInfo.repo}/blob/${repoInfo.branch}/${path}`;
  }

  private extractTitleFromPath(path: string): string {
    // Remove extension and convert to title case
    const basename = path.split('/').pop() || '';
    const nameWithoutExt = basename.replace(/\.[^/.]+$/, '');
    return nameWithoutExt
      .split(/[-_]/)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }
}
