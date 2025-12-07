import { CrawlResult } from '../types.js';
import { Article, ArticleComponent, ProcessedContent } from './content.js';
import { logger } from '../util/logger.js';

function cleanText(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\n\s*\n/g, '\n\n')
    .trim();
}

interface MarkdownSection {
  level: number;
  title: string;
  content: string;
  startLine: number;
  endLine: number;
}

function extractFrontMatter(content: string): {
  frontMatter: Record<string, unknown>;
  content: string;
  endLine: number;
} {
  const frontMatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n/;
  const match = content.match(frontMatterRegex);

  if (!match) {
    return { frontMatter: {}, content, endLine: 0 };
  }

  try {
    const frontMatterStr = match[1];
    const frontMatter: Record<string, unknown> = {};

    // Parse YAML-like front matter
    frontMatterStr.split('\n').forEach(line => {
      const [key, ...valueParts] = line.split(':');
      if (key && valueParts.length > 0) {
        const value = valueParts.join(':').trim();
        // Remove quotes if present
        frontMatter[key.trim()] = value.replace(/^["']|["']$/g, '');
      }
    });

    return {
      frontMatter,
      content: content.slice(match[0].length),
      endLine: match[0].split('\n').length - 1
    };
  } catch (e) {
    logger.debug('[MarkdownProcessor] Error parsing front matter:', e);
    return { frontMatter: {}, content, endLine: 0 };
  }
}

/**
 * Detect if a line looks like a section header.
 * Handles:
 * - Markdown headers: # Title, ## Title, etc.
 * - Docusaurus-style headers: Title (with zero-width space or other unicode)
 * - Plain text headers: Short lines that end with special characters
 */
function isLikelyHeader(line: string, prevLine: string, nextLine: string): { isHeader: boolean; level: number; title: string } {
  // Standard markdown header
  const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);
  if (headerMatch) {
    return { isHeader: true, level: headerMatch[1].length, title: headerMatch[2].trim() };
  }

  // Clean the line of zero-width spaces and other unicode markers
  const cleanLine = line.replace(/[\u200B-\u200D\uFEFF\u2060]/g, '').trim();

  // Skip empty lines or very long lines (unlikely to be headers)
  if (!cleanLine || cleanLine.length > 80) {
    return { isHeader: false, level: 0, title: '' };
  }

  // Docusaurus-style header: ends with unicode marker (\\u200B) and is relatively short
  // These are typically section titles like "Hooks", "Example", "Important"
  if (line.includes('\u200B') || line.includes('\u200D') || line.includes('\u2060')) {
    // Check if this looks like a title (short, possibly with capitalization)
    if (cleanLine.length < 50 && cleanLine.length > 0) {
      return { isHeader: true, level: 2, title: cleanLine };
    }
  }

  // Plain text header detection:
  // - Short line (< 50 chars)
  // - Previous line is empty or doesn't exist
  // - Next line is not empty (has content following)
  // - Line contains mostly letters/spaces (not code)
  if (cleanLine.length < 50 &&
      cleanLine.length > 2 &&
      (!prevLine || prevLine.trim() === '') &&
      nextLine && nextLine.trim() !== '' &&
      /^[A-Z][A-Za-z0-9\s\-_()]+$/.test(cleanLine)) {
    return { isHeader: true, level: 2, title: cleanLine };
  }

  return { isHeader: false, level: 0, title: '' };
}

function parseMarkdownSections(content: string, startLine: number = 0): MarkdownSection[] {
  const lines = content.split('\n');
  const sections: MarkdownSection[] = [];
  let currentSection: MarkdownSection | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const prevLine = i > 0 ? lines[i - 1] : '';
    const nextLine = i < lines.length - 1 ? lines[i + 1] : '';

    const headerInfo = isLikelyHeader(line, prevLine, nextLine);

    if (headerInfo.isHeader) {
      // Save previous section if exists
      if (currentSection) {
        currentSection.endLine = startLine + i - 1;
        sections.push(currentSection);
      }

      // Start new section
      currentSection = {
        level: headerInfo.level,
        title: headerInfo.title,
        content: '',
        startLine: startLine + i,
        endLine: startLine + i
      };
    } else if (currentSection) {
      // Add line to current section
      if (currentSection.content.length > 0) {
        currentSection.content += '\n';
      }
      currentSection.content += line;
    } else {
      // Content before first header goes into an "Introduction" section
      if (!sections.length) {
        currentSection = {
          level: 1,
          title: 'Content',
          content: line,
          startLine,
          endLine: startLine
        };
      }
    }
  }

  // Add last section
  if (currentSection) {
    currentSection.endLine = startLine + lines.length - 1;
    sections.push(currentSection);
  }

  return sections;
}

function processCodeBlocks(content: string): string {
  // Preserve code blocks by replacing them with placeholders
  const codeBlocks: string[] = [];
  let processedContent = content.replace(/```[\s\S]*?```/g, (match) => {
    codeBlocks.push(match);
    return `CODE_BLOCK_${codeBlocks.length - 1}`;
  });

  // Clean the text
  processedContent = cleanText(processedContent);

  // Restore code blocks
  processedContent = processedContent.replace(/CODE_BLOCK_(\d+)/g, (_, index) =>
    codeBlocks[parseInt(index)]
  );

  return processedContent;
}

export async function processMarkdownContent(page: CrawlResult): Promise<ProcessedContent | undefined> {
  try {
    logger.debug(`[MarkdownProcessor] Processing content for ${page.url}`);

    // Extract front matter
    const { frontMatter, content: mainContent, endLine } = extractFrontMatter(page.content);

    // Parse markdown sections
    const sections = parseMarkdownSections(mainContent, endLine);

    // Process sections into components
    const components: ArticleComponent[] = sections.map(section => ({
      title: section.title,
      body: processCodeBlocks(section.content)
    }));

    // Filter out empty components
    const validComponents = components.filter(comp => comp.body.length > 0);

    if (validComponents.length === 0) {
      logger.debug(`[MarkdownProcessor] No valid content sections found in ${page.url}`);
      return undefined;
    }

    const article: Article = {
      url: page.url,
      path: page.path,
      title: (frontMatter.title as string) || page.title || validComponents[0].title,
      components: validComponents
    };

    return {
      article,
      content: validComponents
        .map(comp => `${comp.title}\n\n${comp.body}`)
        .join('\n\n')
        .trim()
    };
  } catch (error) {
    logger.debug('[MarkdownProcessor] Error processing markdown content:', error);
    logger.debug('[MarkdownProcessor] Error details:', error instanceof Error ? error.stack : error);
    return undefined;
  }
}

/**
 * Process content that was already extracted and formatted by a custom extractor
 * (e.g., StorybookExtractor, GithubPagesExtractor).
 *
 * These extractors output markdown-formatted content, so we don't need to
 * parse HTML - we just need to structure the content into sections.
 */
export async function processExtractedContent(page: CrawlResult): Promise<ProcessedContent | undefined> {
  try {
    logger.debug(`[ExtractedContentProcessor] Processing pre-extracted content for ${page.url}`);
    logger.debug(`[ExtractedContentProcessor] Content length: ${page.content.length} bytes`);

    const content = page.content;

    if (!content || content.trim().length === 0) {
      logger.debug(`[ExtractedContentProcessor] No content found in ${page.url}`);
      return undefined;
    }

    // Parse markdown sections - the content is already in markdown format
    const sections = parseMarkdownSections(content, 0);

    logger.debug(`[ExtractedContentProcessor] Found ${sections.length} sections`);

    // Convert sections to components, preserving the markdown content as-is
    const components: ArticleComponent[] = sections.map(section => ({
      title: section.title,
      // Don't over-process - just trim and normalize whitespace
      body: section.content.trim()
    }));

    // Filter out empty components but keep sections with minimal content
    // (some sections like "## Props" header might have content in the next section)
    const validComponents = components.filter(comp => comp.body.length > 0 || comp.title.length > 0);

    if (validComponents.length === 0) {
      // If no sections found, treat entire content as one component
      logger.debug(`[ExtractedContentProcessor] No sections found, using entire content`);
      const article: Article = {
        url: page.url,
        path: page.path,
        title: page.title || 'Content',
        components: [{
          title: page.title || 'Content',
          body: content.trim()
        }]
      };

      return {
        article,
        content: content.trim()
      };
    }

    // Extract title from first H1 if present, otherwise use page title
    let title = page.title;
    const firstH1Section = sections.find(s => s.level === 1);
    if (firstH1Section) {
      title = firstH1Section.title;
    }

    const article: Article = {
      url: page.url,
      path: page.path,
      title: title || validComponents[0].title,
      components: validComponents
    };

    logger.debug(`[ExtractedContentProcessor] Created article with ${validComponents.length} components`);
    logger.debug(`[ExtractedContentProcessor] Total content length: ${content.length} bytes`);

    return {
      article,
      content: validComponents
        .map(comp => comp.title ? `${comp.title}\n\n${comp.body}` : comp.body)
        .join('\n\n')
        .trim()
    };
  } catch (error) {
    logger.debug('[ExtractedContentProcessor] Error processing extracted content:', error);
    logger.debug('[ExtractedContentProcessor] Error details:', error instanceof Error ? error.stack : error);
    return undefined;
  }
}