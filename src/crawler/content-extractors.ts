interface ContentExtractor {
  canHandle(document: Document): boolean;
  extractContent(document: Document): Promise<ExtractedContent>;
}

interface ExtractedContent {
  content: string;
  metadata: {
    type: 'overview' | 'props' | 'examples' | 'api' | 'usage';
    pattern?: ComponentPattern;
    relationships?: ComponentRelationship[];
    context?: string[];
  };
}

interface ComponentPattern {
  name: string;
  type: 'component' | 'layout' | 'page';
  description: string;
  usageContexts: string[];
  relatedPatterns: string[];
}

interface ComponentRelationship {
  sourceComponent: string;
  targetComponent: string;
  type: 'contains' | 'uses' | 'extends' | 'precedes';
  context: string;
}

export class StorybookExtractor implements ContentExtractor {
  canHandle(document: Document): boolean {
    // Check if we're in the Storybook iframe
    if (window.parent !== window) {
      return document.querySelector('#root, #docs-root, .sbdocs') !== null;
    }

    // Check if we're in the main Storybook window
    const isStorybook = document.baseURI?.includes('path=/docs/') ||
                       document.baseURI?.includes('path=/story/') ||
                       document.querySelector('#storybook-root, .sbdocs, [data-nodetype="root"]') !== null ||
                       document.querySelector('meta[name="storybook-version"]') !== null ||
                       document.querySelector('.sbdocs-wrapper, .docs-story, .sb-show-main') !== null;

    if (isStorybook) return true;

    // Check for any Storybook structure
    return document.querySelector('h1') !== null;
  }

  private extractTextContent(element: Element, selector: string, prefix = ''): string {
    const elements = element.querySelectorAll(selector);
    return Array.from(elements)
      .map(el => {
        // Handle elements with links specially
        const links = Array.from(el.querySelectorAll('a'));
        if (links.length > 0) {
          let text = el.textContent || '';
          // Replace each link with markdown format
          links.forEach(link => {
            const href = link.getAttribute('href');
            if (href) {
              const linkText = link.textContent?.trim();
              text = text.replace(linkText || '', `[${linkText}](${href})`);
            }
          });
          return prefix + text.trim();
        }

        // Regular text content
        const text = el.textContent?.trim();
        return text && !text.includes('Show code') ? `${prefix}${text}` : '';
      })
      .filter(Boolean)
      .join('\n\n');
  }

  private async extractCodeSamples(document: Document): Promise<string[]> {
    const codeSamples: string[] = [];
    const processedCodes = new Set<string>();

    // Function to process a code block
    const processCodeBlock = (block: Element, title?: string) => {
      // Find the prismjs pre element, either the block itself or a parent
      const prismBlock = block.matches('pre.prismjs') ? block : block.closest('pre.prismjs');
      const code = (prismBlock || block).textContent?.trim();

      if (code && !processedCodes.has(code)) {
        if (title) {
          codeSamples.push(`// ${title}`);
        }
        codeSamples.push(code);
        processedCodes.add(code);
      }
    };

    // First find and click all "Show code" buttons
    const showCodeButtons = Array.from(document.querySelectorAll('button'))
      .filter(button => {
        const text = button.textContent?.toLowerCase() || '';
        return text.includes('show code') || text.includes('view code');
      });

    // Click all buttons first to reveal all code blocks
    for (const button of showCodeButtons) {
      (button as HTMLButtonElement).click();
      // Brief wait between clicks
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    // Wait for code blocks to be inserted
    await new Promise(resolve => setTimeout(resolve, 500));

    // Now find all sections that might have code blocks
    const sections = document.querySelectorAll('[class*="story"], [class*="example"], [class*="docblock"], section, article');

    // Process each section
    for (const section of sections) {
      // Get the title for this section
      const titleText = section.querySelector('h1, h2, h3, h4')?.textContent?.trim() ||
                       section.getAttribute('title') ||
                       section.getAttribute('aria-label') ||
                       undefined;

      // Find and process all PrismJS code blocks in this section
      const codeBlocks = section.querySelectorAll('pre.prismjs');
      codeBlocks.forEach(block => processCodeBlock(block, titleText));
    }

    // Check for any standalone code blocks at the document level
    document.querySelectorAll('pre.prismjs').forEach(block => {
      const parentSection = block.closest('[class*="story"], [class*="example"], [class*="docblock"], section, article');
      // Only process if not already processed and not in a section we already handled
      if (!processedCodes.has(block.textContent?.trim() || '') && !parentSection) {
        processCodeBlock(block);
      }
      const container = block.closest('[class*="story"], [class*="example"], [class*="docblock"], section, article');
      const hasShowCodeButton = container?.querySelector('button')?.textContent?.toLowerCase().match(/show|view.*code/);

      if (!hasShowCodeButton) {
        // Try to get a title from the nearest heading or container
        const titleText = container?.querySelector('h1, h2, h3, h4')?.textContent?.trim() ||
                         container?.getAttribute('title') ||
                         container?.getAttribute('aria-label') ||
                         undefined;
        processCodeBlock(block, titleText);
      }
    });

    return codeSamples;
  }

  private extractPropsTable(document: Document): string {
    const propsTable = document.querySelector('.docblock-argstable');
    if (!propsTable) return '';

    let text = '## Props\n\n';
    const rows = Array.from(propsTable.querySelectorAll('tr')).slice(1); // Skip header row

    rows.forEach((row: Element) => {
      const cells = row.querySelectorAll('td');
      if (cells.length >= 4) {
        const name = cells[0]?.textContent?.trim();
        const description = cells[1]?.textContent?.trim();
        const type = cells[2]?.textContent?.trim();
        const defaultValue = cells[3]?.textContent?.trim();

        if (name) {
          text += `### ${name}`;
          if (type) text += ` (${type})`;
          text += '\n';
          if (description) text += `${description}\n`;
          if (defaultValue && defaultValue !== '-') text += `Default: ${defaultValue}\n`;
          text += '\n';
        }
      }
    });

    return text;
  }

  private cleanupContent(element: Element): void {
    // First mark sections with code examples to preserve them
    element.querySelectorAll('button').forEach(button => {
      if (button.textContent?.toLowerCase().includes('show code')) {
        const container = button.closest('[class*="story"], [class*="example"], section, article');
        if (container) {
          container.setAttribute('data-has-code', 'true');
        }
      }
    });

    // Remove navigation and non-content elements
    const selectorsToRemove = [
      // Basic cleanup
      'style', 'script',

      // Navigation elements
      '[role="navigation"]',
      '[role="search"]',

      // Sidebar and navigation
      '[class*="sidebar"]',
      '[class*="menu"]',

      // Technical elements
      'style[data-emotion]',
      '[data-testid]',
      '[data-radix-scroll-area-viewport]',
      '.os-viewport',
      '.os-content',

      // Search and toolbar elements
      '[class*="toolbar"]',
      '[class*="search"]',

      // Interactive elements we don't want in the content
      'input',
      'select'
    ];

    // Remove elements that match our selectors, but preserve code sections
    element.querySelectorAll(selectorsToRemove.join(', ')).forEach(el => {
      if (!el.closest('[data-has-code="true"]')) {
        el.remove();
      }
    });

    // Clean up but preserve content of specific elements
    const cleanupButPreserve = [
      // Interactive containers that might have useful content
      '[role="tabpanel"]',
      '[role="tablist"]',
      '[role="tab"]'
    ];

    element.querySelectorAll(cleanupButPreserve.join(', ')).forEach(el => {
      if (!el.closest('[data-has-code="true"]')) {
        // Create a new div to hold the content
        const wrapper = document.createElement('div');
        wrapper.innerHTML = el.innerHTML;

        // Clean up the wrapper but preserve code blocks
        wrapper.querySelectorAll('style, script').forEach(node => node.remove());

        // Replace the original element with our cleaned wrapper
        el.parentNode?.replaceChild(wrapper, el);
      }
    });

    // Remove empty elements except those that might be important for structure
    // or are part of code examples
    element.querySelectorAll('*').forEach(el => {
      if (!el.closest('[data-has-code="true"]') && // Not in a code section
          !el.matches('h1, h2, h3, h4, h5, h6, pre, code') && // Not a heading or code block
          !el.textContent?.trim() && // Empty text
          !el.querySelector('img, code, pre')) { // No important children
        el.remove();
      }
    });

    // Clean up "Show code" buttons after we've extracted the code
    element.querySelectorAll('button').forEach(button => {
      if (button.textContent?.toLowerCase().includes('show code')) {
        button.remove();
      }
    });
  }

  async extractContent(document: Document): Promise<ExtractedContent> {
    let text = '';
    const sections: string[] = [];

    // Get the main content area
    const mainContent = document.querySelector('#root, #docs-root, .sbdocs, #storybook-root') || document.body;
    if (!mainContent) {
      return {
        content: '',
        metadata: {
          type: 'overview',
          pattern: {
            name: '',
            type: 'component',
            description: '',
            usageContexts: [],
            relatedPatterns: []
          }
        }
      };
    }

    // Clone to avoid modifying the original DOM
    const contentClone = mainContent.cloneNode(true) as Element;

    // Clean up the content first
    this.cleanupContent(contentClone);

    // Extract title
    const title = contentClone.querySelector('h1')?.textContent?.trim();
    if (title) {
      sections.push(`# ${title}`);
    }

    // Extract description from first paragraph after h1
    const firstParagraph = contentClone.querySelector('h1 + p')?.textContent?.trim();
    if (firstParagraph) {
      sections.push(firstParagraph);
    }

    // Process content in document order
    let currentSection = '';
    let inSection = false;

    Array.from(contentClone.children).forEach(element => {
      switch (element.tagName) {
        case 'H1':
          // Title is already handled
          break;

        case 'H2': {
          // If we were in a section, save it
          if (inSection && currentSection.trim()) {
            sections.push(currentSection.trim());
          }

          // Start new section
          const title = element.textContent?.trim();
          currentSection = `## ${title}\n\n`;
          inSection = true;
          break;
        }

        case 'P': {
          // Handle paragraphs with potential links and code-like content
          const links = Array.from(element.querySelectorAll('a'));
          let text = element.textContent?.trim() || '';

          // Keep text content clean and unmodified
          text = text.trim();

          // Replace links with markdown format
          links.forEach(link => {
            const href = link.getAttribute('href');
            const linkText = link.textContent?.trim();
            if (href && linkText) {
              // If it's an external tool/doc link, add reference marker
              const isExternalTool = href.includes('figma.com') ||
                                   href.includes('zeroheight') ||
                                   href.includes('style-dictionary');
              text = text.replace(linkText, isExternalTool ?
                `[${linkText}](${href}) (External Tool)` :
                `[${linkText}](${href})`);
            }
          });

          // Add to current section or main content
          if (inSection) {
            currentSection += text + '\n\n';
          } else if (element.previousElementSibling?.tagName === 'H1') {
            sections.push('## Description\n\n' + text);
          } else {
            sections.push(text);
          }
          break;
        }

        case 'UL':
        case 'OL': {
          const items = this.extractTextContent(element, 'li', '• ');
          if (items) {
            if (inSection) {
              currentSection += items + '\n\n';
            } else {
              sections.push(items);
            }
          }
          break;
        }

        case 'PRE':
        case 'CODE': {
          const code = element.textContent?.trim();
          if (code) {
            // Use language class if present, otherwise plaintext
            const language = element.className.includes('language-')
              ? element.className.match(/language-(\w+)/)?.[1] || 'plaintext'
              : 'plaintext';

            const codeBlock = '```' + language + '\n' + code + '\n```\n\n';
            if (inSection) {
              currentSection += codeBlock;
            } else {
              sections.push('## Code Example\n\n' + codeBlock);
            }
          }
          break;
        }
      }
    });

    // Save the last section if we have one
    if (inSection && currentSection.trim()) {
      sections.push(currentSection.trim());
    }

    // Extract any remaining important content
    const remainingParagraphs = Array.from(contentClone.querySelectorAll('p'))
      .filter(p => !p.previousElementSibling?.matches('h1, h2') && p.textContent?.trim())
      .map(p => p.textContent?.trim())
      .filter(Boolean)
      .join('\n\n');

    if (remainingParagraphs) {
      sections.push('## Additional Information\n\n' + remainingParagraphs);
    }

    // Extract code samples
    const codeSamples = await this.extractCodeSamples(document);
    if (codeSamples.length > 0) {
      let codeSection = '## Code Examples\n\n';
      codeSamples.forEach((code, index) => {
        codeSection += `### Example ${index + 1}\n\`\`\`\n${code}\n\`\`\`\n\n`;
      });
      sections.push(codeSection.trim());
    }

    // Extract props table
    const propsText = this.extractPropsTable(document);
    if (propsText) {
      sections.push(propsText.trim());
    }

    // Combine all sections
    text = sections.join('\n\n');

    return {
      content: text,
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

export class GitHubPagesExtractor implements ContentExtractor {
  canHandle(document: Document): boolean {
    try {
      // First check if it's a Storybook site
      const isStorybook = document.querySelector('#storybook-root, .sbdocs, [data-nodetype="root"]') !== null ||
                         document.querySelector('meta[name="storybook-version"]') !== null ||
                         document.baseURI?.includes('path=/docs/') ||
                         document.baseURI?.includes('path=/story/') ||
                         document.querySelector('.sbdocs-wrapper, .docs-story, .sb-show-main') !== null;

      if (isStorybook) {
        return false;
      }

      // Then check if it's a GitHub Pages site
      const isGitHubPages = window.location.hostname.includes('github.io');
      if (isGitHubPages) {
        // Additional check for GitHub Pages specific elements
        return document.querySelector('.markdown-body, .site-footer, .page-header') !== null;
      }
      return false;
    } catch {
      // Fallback to checking document URL if window.location is not available
      const baseURI = document.baseURI || '';
      const isStorybook = baseURI.includes('path=/docs/') || baseURI.includes('path=/story/');
      return !isStorybook && baseURI.includes('github.io');
    }
  }

  async extractContent(document: Document): Promise<ExtractedContent> {
    // Remove navigation and footer
    document.querySelectorAll('nav, header, footer').forEach(el => el.remove());

    // Get main content
    const main = document.querySelector('main, article, .markdown-body');
    if (!main) {
      return {
        content: '',
        metadata: { type: 'overview' }
      };
    }

    const clone = main.cloneNode(true) as Element;
    clone.querySelectorAll('script, style').forEach(el => el.remove());

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
          relatedPatterns: []
        }
      }
    };
  }
}

export class DefaultExtractor implements ContentExtractor {
  canHandle(_document: Document): boolean {
    // Document parameter not used since this is a fallback extractor
    return true;
  }

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

export const contentExtractors: ContentExtractor[] = [
  new StorybookExtractor(),    // Most specific - try first
  new GitHubPagesExtractor(),  // More general - try second
  new DefaultExtractor()       // Fallback - try last
];