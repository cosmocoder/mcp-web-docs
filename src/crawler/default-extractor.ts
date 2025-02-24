import { ContentExtractor, ExtractedContent } from './content-extractor-types.js';

export class DefaultExtractor implements ContentExtractor {
  async extractContent(document: Document): Promise<ExtractedContent> {
    // Remove common non-content elements
    document.querySelectorAll('style, script, nav, header, footer').forEach(el => el.remove());

    // Get main content
    const main = document.querySelector('main, article, [role="main"]');
    const contentElement = main ? main.cloneNode(true) as Element : document.body;

    // Extract title and description
    const title = contentElement.querySelector('h1')?.textContent?.trim();
    const firstParagraph = contentElement.querySelector('h1 + p')?.textContent?.trim();

    return {
      content: contentElement.textContent?.trim() || '',
      metadata: {
        type: 'overview',
        pattern: {
          name: title || '',
          type: 'component',
          description: firstParagraph || '',
          usageContexts: [],
          relatedPatterns: []
        }
      }
    };
  }
}
