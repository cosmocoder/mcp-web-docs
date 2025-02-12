import { CrawlResult } from '../types.js';
import { Article, ArticleComponent, ProcessedContent } from './content.js';

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
    console.error('[MarkdownProcessor] Error parsing front matter:', e);
    return { frontMatter: {}, content, endLine: 0 };
  }
}

function parseMarkdownSections(content: string, startLine: number = 0): MarkdownSection[] {
  const lines = content.split('\n');
  const sections: MarkdownSection[] = [];
  let currentSection: MarkdownSection | null = null;

  const headerRegex = /^(#{1,6})\s+(.+)$/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headerMatch = line.match(headerRegex);

    if (headerMatch) {
      // Save previous section if exists
      if (currentSection) {
        currentSection.endLine = startLine + i - 1;
        sections.push(currentSection);
      }

      // Start new section
      currentSection = {
        level: headerMatch[1].length,
        title: headerMatch[2].trim(),
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
          title: 'Introduction',
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
    console.debug(`[MarkdownProcessor] Processing content for ${page.url}`);

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
      console.error(`[MarkdownProcessor] No valid content sections found in ${page.url}`);
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
    console.error('[MarkdownProcessor] Error processing markdown content:', error);
    console.debug('[MarkdownProcessor] Error details:', error instanceof Error ? error.stack : error);
    return undefined;
  }
}