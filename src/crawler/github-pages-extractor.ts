import { ContentExtractor, ExtractedContent } from './content-extractor-types.js';

export class GitHubPagesExtractor implements ContentExtractor {
  async extractContent(document: Document): Promise<ExtractedContent> {
    // Remove navigation and footer
    document.querySelectorAll('nav, header, footer').forEach((el) => el.remove());

    // Get main content
    const main = document.querySelector('main, article, .markdown-body');
    if (!main) {
      return {
        content: '',
        metadata: { type: 'overview' },
      };
    }

    const clone = main.cloneNode(true) as Element;
    clone.querySelectorAll('script, style').forEach((el) => el.remove());

    // Extract title and description
    const title = clone.querySelector('h1')?.textContent?.trim();
    const firstParagraph = clone.querySelector('h1 + p')?.textContent?.trim();

    return {
      content: clone.textContent?.trim() || '',
      metadata: {
        type: 'overview',
        pattern: {
          name: title || '',
          type: 'component',
          description: firstParagraph || '',
          usageContexts: [],
          relatedPatterns: [],
        },
      },
    };
  }
}
