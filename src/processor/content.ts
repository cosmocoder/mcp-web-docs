import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import { CrawlResult } from '../types.js';
import { logger } from '../util/logger.js';

export interface ArticleComponent {
  title: string;
  body: string;
}

export interface Article {
  url: string;
  path: string;
  title: string;
  components: ArticleComponent[];
}

export interface ProcessedContent {
  article: Article;
  content: string;
}

function cleanText(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\n\s*\n/g, '\n\n')
    .trim();
}

function findMainContent(doc: Document): Element | null {
  const selectors = [
    // Storybook specific selectors
    '[class*="story-content"]',
    '[class*="storybook-"]',
    '[class*="docs-content"]',
    '[class*="sbdocs-"]',
    '[class*="docblock-"]',
    // Jimdo UI specific selectors
    '[class*="docs-"]',
    '[class*="documentation"]',
    '[class*="content"]',
    '[class*="main"]',
    // Common documentation selectors
    'main',
    '[role="main"]',
    '#root',
    '#app',
    '#__next',
    '#storybook-root',
    '.documentation',
    '.docs-content',
    '.markdown-body',
    'article',
    '.article',
    '.content',
    '.page-content',
    '.docusaurus-content',
    '.vuepress-content',
    '.gatsby-content',
    '.mdx-content',
    '.nextra-content',
    '.nuxt-content',
  ];

  // Try each selector
  for (const selector of selectors) {
    const elements = Array.from(doc.querySelectorAll(selector));
    if (elements.length > 0) {
      // If multiple elements found, return the one with most content
      return elements.reduce((best, current) => {
        const bestLength = best.textContent?.length || 0;
        const currentLength = current.textContent?.length || 0;
        return currentLength > bestLength ? current : best;
      });
    }
  }

  // Fallback: try to find the element with the most content
  const candidates = Array.from(doc.body.children);
  if (candidates.length === 0) return null;

  return candidates.reduce((best, current) => {
    const bestLength = best.textContent?.length || 0;
    const currentLength = current.textContent?.length || 0;
    return currentLength > bestLength ? current : best;
  });
}

function getAllTextContent(element: Element): string {
  let content = '';

  // Handle code blocks specially
  if (element.tagName === 'PRE' || element.classList.contains('code')) {
    const code = element.textContent?.trim();
    if (code) {
      return '\n```\n' + code + '\n```\n';
    }
    return '';
  }

  // Handle lists specially
  if (element.tagName === 'UL' || element.tagName === 'OL') {
    const items = Array.from(element.querySelectorAll('li'))
      .map((li) => '- ' + li.textContent?.trim())
      .filter(Boolean)
      .join('\n');
    if (items) {
      return '\n' + items + '\n';
    }
    return '';
  }

  // Handle tables specially
  if (element.tagName === 'TABLE') {
    const rows = Array.from(element.querySelectorAll('tr'))
      .map((tr) =>
        Array.from(tr.querySelectorAll('td, th'))
          .map((cell) => cell.textContent?.trim() || '')
          .join(' | ')
      )
      .filter(Boolean)
      .join('\n');
    if (rows) {
      return '\n' + rows + '\n';
    }
    return '';
  }

  // Skip unwanted elements
  if (['SCRIPT', 'STYLE', 'NAV', 'HEADER', 'FOOTER'].includes(element.tagName)) {
    return '';
  }

  // Get text content of this element
  const text = element.textContent?.trim();
  if (text) {
    content += text + '\n';
  }

  return content;
}

function extractContentBetweenElements(start: Element, end: Element | null): string {
  let content = '';
  let current: Element | null = start;

  // Process all elements between start and end
  while (current && current !== end) {
    content += getAllTextContent(current);

    // Check children first (depth-first)
    if (current.firstElementChild && current !== start) {
      current = current.firstElementChild;
    }
    // Then try next sibling
    else if (current.nextElementSibling) {
      current = current.nextElementSibling;
    }
    // Finally try parent's next sibling
    else {
      let parent: Element | null = current.parentElement;
      while (parent && parent !== end && !parent.nextElementSibling) {
        parent = parent.parentElement;
      }
      if (parent && parent !== end) {
        current = parent.nextElementSibling;
      } else {
        break;
      }
    }
  }

  return cleanText(content);
}

function extractSections(mainContent: Element): ArticleComponent[] {
  const headerSelectors = [
    'h1',
    'h2',
    'h3',
    'h4',
    '[class*="heading"]',
    '[class*="title"]',
    '[class*="sbdocs-h"]',
    '[class*="story-title"]',
    '[class*="docblock-title"]',
    '[class*="docs-title"]',
  ];
  const headers = Array.from(mainContent.querySelectorAll(headerSelectors.join(','))).filter((header) => {
    const text = header.textContent?.trim();
    return text && text.length > 0;
  });

  if (headers.length === 0) {
    // No headers found, treat entire content as one section
    const title = mainContent.querySelector('h1, [class*="title"]')?.textContent?.trim() || 'Content';
    const body = getAllTextContent(mainContent);
    if (body.length > 0) {
      return [{ title, body: cleanText(body) }];
    }
    return [];
  }

  const components: ArticleComponent[] = [];

  // Process content before first header
  if (headers[0].previousElementSibling) {
    const introContent = extractContentBetweenElements(mainContent.firstElementChild as Element, headers[0]);
    if (introContent.length > 0) {
      components.push({
        title: 'Introduction',
        body: introContent,
      });
    }
  }

  // Process sections between headers
  headers.forEach((header, index) => {
    const nextHeader = headers[index + 1];
    const title = header.textContent?.trim() || '';
    const body = extractContentBetweenElements(header, nextHeader);

    if (body.length > 0) {
      components.push({ title, body });
    }
  });

  // Filter out empty components and normalize
  return components
    .filter((comp) => comp.body.length > 0)
    .map((comp) => ({
      title: comp.title,
      body: cleanText(comp.body),
    }));
}

export async function processHtmlContent(page: CrawlResult): Promise<ProcessedContent | undefined> {
  try {
    logger.debug(`[ContentProcessor] Processing content for ${page.url}`);

    const dom = new JSDOM(page.content);
    const doc = dom.window.document;

    // Try to find main content first
    const mainContent = findMainContent(doc);

    // If no main content found, use Readability
    if (!mainContent) {
      logger.debug('[ContentProcessor] No main content found, trying Readability');
      const reader = new Readability(doc);
      const readability = reader.parse();

      if (!readability) {
        logger.debug(`[ContentProcessor] No content could be extracted from ${page.url}`);
        return undefined;
      }

      return {
        article: {
          url: page.url,
          path: page.path,
          title: readability.title || page.path,
          components: [
            {
              title: readability.title || 'Content',
              body: cleanText(readability.textContent || ''),
            },
          ],
        },
        content: cleanText(readability.textContent || ''),
      };
    }

    logger.debug('[ContentProcessor] Found main content, extracting sections');

    // Extract sections from main content
    const components = extractSections(mainContent);

    if (components.length === 0) {
      logger.debug(`[ContentProcessor] No valid content sections found in ${page.url}`);
      return undefined;
    }

    logger.debug(`[ContentProcessor] Extracted ${components.length} sections`);

    const article: Article = {
      url: page.url,
      path: page.path,
      title: page.title || components[0].title,
      components,
    };

    return {
      article,
      content: components
        .map((comp) => `${comp.title}\n\n${comp.body}`)
        .join('\n\n')
        .trim(),
    };
  } catch (error) {
    logger.debug('[ContentProcessor] Error processing HTML content:', error);
    logger.debug('[ContentProcessor] Error details:', error instanceof Error ? error.stack : error);
    return undefined;
  }
}
