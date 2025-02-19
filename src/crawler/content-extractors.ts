interface ContentExtractor {
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

  private addContentToSections(content: string, sections: string[], addedSections: Set<string>): void {
    const trimmed = content.trim();
    if (trimmed && !addedSections.has(trimmed)) {
      sections.push(trimmed);
      addedSections.add(trimmed);
    }
  }

  private cleanupCode(code: string): string {
    return code
      .replace(/^\s+|\s+$/g, '')  // Trim whitespace
      .replace(/\t/g, '  ')       // Convert tabs to spaces
      .replace(/\n{3,}/g, '\n\n') // Reduce multiple blank lines
      .replace(/\u00A0/g, ' ')    // Replace non-breaking spaces
      .replace(/\r\n/g, '\n')     // Normalize line endings
      .replace(/[ \t]+$/gm, '')   // Remove trailing spaces
      .replace(/^\n+|\n+$/g, ''); // Trim leading/trailing newlines
  }

  private isElementVisible(element: Element): boolean {
    const style = window.getComputedStyle(element);
    return style.display !== 'none' &&
           style.visibility !== 'hidden' &&
           style.opacity !== '0';
  }

  private formatCodeBlock(code: string, language: string): string {
    // Clean up the code
    const cleanCode = code
      .replace(/^\s+|\s+$/g, '')  // Trim whitespace
      .replace(/\t/g, '  ')       // Convert tabs to spaces
      .replace(/\n{3,}/g, '\n\n') // Reduce multiple blank lines
      .replace(/\u00A0/g, ' ');   // Replace non-breaking spaces

    return `\`\`\`${language}\n${cleanCode}\n\`\`\``;
  }

  private extractLinks(element: Element): string {
    let content = element.innerHTML;

    // Handle links
    const links = element.querySelectorAll('a');
    links.forEach(link => {
      const text = link.textContent?.trim();
      const href = link.getAttribute('href');
      if (text && href) {
        // Replace the link HTML with markdown link
        const linkHtml = link.outerHTML;
        content = content.replace(linkHtml, `[${text}](${href})`);
      }
    });

    // Handle inline code elements
    const codeElements = element.querySelectorAll('code, [class*="code"], [class*="inline-code"], [class*="monospace"]');
    codeElements.forEach(code => {
      const text = code.textContent?.trim();
      if (text) {
        // Replace the code HTML with markdown inline code
        const codeHtml = code.outerHTML;
        content = content.replace(codeHtml, `\`${text}\``);
      }
    });

    // Convert HTML to plain text while preserving markdown
    const div = document.createElement('div');
    div.innerHTML = content;
    return div.textContent?.trim() || '';
  }

  private async processSection(section: Element, sections: string[], addedSections: Set<string>): Promise<void> {
    try {
      // Try to find a heading in this section or its parent
      const heading = section.querySelector('h2, h3, h4') ||
                     section.closest('section')?.querySelector('h2, h3, h4');

      if (heading) {
        const title = heading.textContent?.trim();
        if (title && !addedSections.has(`## ${title}`)) {
          // Add section heading
          this.addContentToSections(`## ${title}`, sections, addedSections);
          this.addContentToSections('', sections, addedSections);

          // Process content between this heading and the next
          let current = heading.nextElementSibling;
          while (current && !current.matches('h2, h3, h4')) {
            await this.processSectionContent(current, sections, addedSections);
            current = current.nextElementSibling;
          }
        }
      }

      // Process any remaining content in the section
      const remainingContent = Array.from(section.children).filter(el =>
        !el.matches('h2, h3, h4') && (!heading || !heading.contains(el))
      );

      for (const content of remainingContent) {
        await this.processSectionContent(content, sections, addedSections);
      }
    } catch (error) {
      console.error('Error processing section:', error);
    }
  }

  private async processSectionContent(element: Element | null, sections: string[], addedSections: Set<string>): Promise<void> {
    if (!element) return;

    try {
      // Skip if element is not visible
      if (!this.isElementVisible(element)) return;

      // Handle text content with links and inline code
      if (element.matches('p, div[class*="description"], [class*="markdown"], [class*="text"], [class*="content"], [class*="docblock-text"]')) {
        const text = this.extractLinks(element);
        if (text) {
          this.addContentToSections(text, sections, addedSections);
          this.addContentToSections('', sections, addedSections);
        }
      }

      // Handle code blocks
      if (element.matches('pre.prismjs')) {
        // First try to get any visible code
        const code = element.textContent?.trim() || '';
        if (code) {
          const cleanCode = this.cleanupCode(code);
          if (cleanCode) {
            const language = element.className.match(/language-(\w+)/)?.[1] || 'typescript';
            const formattedCode = this.formatCodeBlock(cleanCode, language);
            this.addContentToSections(formattedCode, sections, addedSections);
            this.addContentToSections('', sections, addedSections);
          }
        }
      }

      // Handle tables for layout, spacing, and style tokens
      if (element.matches('table')) {
        const headers = Array.from(element.querySelectorAll('th')).map(th => th.textContent?.trim() || '');
        if (headers.length > 0) {
          // Add table header
          this.addContentToSections(`| ${headers.join(' | ')} |`, sections, addedSections);
          this.addContentToSections(`| ${headers.map(() => '---').join(' | ')} |`, sections, addedSections);

          // Process rows
          const rows = element.querySelectorAll('tr');
          for (const row of rows) {
            const cells = Array.from(row.querySelectorAll('td')).map(td => {
              const text = td.textContent?.trim() || '';
              return text.replace(/\|/g, '\\|');
            });

            if (cells.length > 0) {
              this.addContentToSections(`| ${cells.join(' | ')} |`, sections, addedSections);
            }
          }
          this.addContentToSections('', sections, addedSections);
        }
      }

      // Handle alias token divs
      if (element.matches('div')) {
        const name = element.textContent?.trim();
        const nextElement = element.nextElementSibling;
        if (name && nextElement) {
          const hexValue = nextElement.textContent?.trim();
          if (hexValue && hexValue.startsWith('#')) {
            this.addContentToSections(`${name}: ${hexValue}`, sections, addedSections);
          }
        }
      }

      // Handle expand buttons
      const button = element.querySelector('button');
      if (button?.textContent?.trim() === 'Expand') {
        try {
          (button as HTMLButtonElement).click();
          await new Promise(resolve => setTimeout(resolve, 500));
        } catch (error) {
          console.error('Error clicking expand button:', error);
        }
      }


      // Look for "Show code" buttons
      const codeButtons = Array.from(element.querySelectorAll('button'))
        .filter(button => {
          const text = button.textContent?.toLowerCase() || '';
          return text.includes('show code');
        });

      for (const button of codeButtons) {
        try {
          if (!this.isElementVisible(button)) continue;

          // Click the button and wait for animation
          (button as HTMLButtonElement).click();
          await new Promise(resolve => setTimeout(resolve, 500));

          // Look for newly revealed code blocks
          const codeBlocks = element.querySelectorAll('pre.prismjs');
          for (const block of codeBlocks) {
            if (!this.isElementVisible(block)) continue;
            const code = block.textContent?.trim() || '';
            if (code) {
              const cleanCode = this.cleanupCode(code);
              if (cleanCode) {
                const language = block.className.match(/language-(\w+)/)?.[1] || 'typescript';
                const formattedCode = this.formatCodeBlock(cleanCode, language);
                this.addContentToSections(formattedCode, sections, addedSections);
                this.addContentToSections('', sections, addedSections);
              }
            }
          }

          // Click the button again to hide the code
          (button as HTMLButtonElement).click();
        } catch (error) {
          console.error('Error handling code button:', error);
        }
      }

      // Process child elements that might contain content
      const children = Array.from(element.children).filter(el => {
        // Skip already processed elements
        if (el.matches('h1, h2, h3, h4')) return false;
        if (el.matches('script, style, iframe')) return false;

        // Skip if parent already processed this content type
        if (element.matches('pre, code') && el.matches('pre, code')) return false;

        return true;
      });

      for (const child of children) {
        await this.processSectionContent(child, sections, addedSections);
      }
    } catch (error) {
      console.error('Error processing section content:', error);
    }
  }

  private async processPropsTable(table: Element, sections: string[], addedSections: Set<string>): Promise<void> {
    this.addContentToSections('## Props', sections, addedSections);
    this.addContentToSections('', sections, addedSections);
    this.addContentToSections('| Name | Description | Default |', sections, addedSections);
    this.addContentToSections('|------|-------------|---------|', sections, addedSections);

    const rows = Array.from(table.querySelectorAll('tr')).slice(1);
    for (const row of rows) {
      const cells = row.querySelectorAll('td');
      if (cells.length >= 3) {
        const name = cells[0]?.textContent?.trim() || '';
        const description = this.extractLinks(cells[1]);
        const defaultValue = cells[2]?.textContent?.trim() || '-';

        // Get type information
        const typeInfo = cells[0]?.querySelector('span[class*="type"], code')?.textContent?.trim();
        const type = typeInfo?.replace(/["']/g, '`'); // Replace quotes with backticks for inline code

        // Format as markdown table row with proper escaping
        const formattedName = `${name}${type ? ` (\`${type}\`)` : ''}`;
        const formattedDesc = description.replace(/\|/g, '\\|'); // Escape pipe characters
        const formattedDefault = defaultValue.replace(/\|/g, '\\|').replace(/["']/g, '`');

        this.addContentToSections(
          `| ${formattedName} | ${formattedDesc} | ${formattedDefault} |`,
          sections,
          addedSections
        );
      }
    }
    this.addContentToSections('', sections, addedSections);
  }

  private async waitForStorybookContent(document: Document): Promise<Element | null> {
    const maxAttempts = 10;
    const delay = 500;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise(resolve => setTimeout(resolve, delay));

      // Check for Storybook content area
      const mainArea = document.querySelector('.sbdocs-content, #docs-root');
      if (!mainArea) continue;

      // Verify content is loaded by checking for various content types
      const hasContent = mainArea.querySelector('h1') && (
        mainArea.querySelector('p') ||
        mainArea.querySelector('table') ||
        mainArea.querySelector('ul, ol') ||
        mainArea.querySelector('[class*="docblock"]')
      );

      if (hasContent) {
        // Wait briefly for any remaining content
        await new Promise(resolve => setTimeout(resolve, 500));
        return mainArea;
      }

      // Check if Storybook is still loading
      const loadingIndicator = document.querySelector('[class*="loading"], [class*="pending"]');
      if (!loadingIndicator) {
        console.warn('No loading indicator found but content is missing');
      }
    }

    return null;
  }

  private async processTableContent(table: Element, sections: string[], addedSections: Set<string>): Promise<void> {
    try {
      // Get table headers
      const headers = Array.from(table.querySelectorAll('th')).map(th => th.textContent?.trim() || '');
      if (headers.length === 0) return;

      // Add table header
      this.addContentToSections(`| ${headers.join(' | ')} |`, sections, addedSections);
      this.addContentToSections(`| ${headers.map(() => '---').join(' | ')} |`, sections, addedSections);

      // Process rows
      const rows = table.querySelectorAll('tr');
      for (const row of rows) {
        const cells = Array.from(row.querySelectorAll('td')).map(td => {
          // Extract text with links and inline code
          const text = this.extractLinks(td);
          // Escape pipe characters
          return text.replace(/\|/g, '\\|');
        });

        if (cells.length > 0) {
          this.addContentToSections(`| ${cells.join(' | ')} |`, sections, addedSections);
        }
      }

      this.addContentToSections('', sections, addedSections);
    } catch (error) {
      console.error('Error processing table:', error);
    }
  }

  private async processListContent(list: Element, sections: string[], addedSections: Set<string>): Promise<void> {
    try {
      const items = list.querySelectorAll('li');
      for (const item of items) {
        const text = this.extractLinks(item);
        if (text) {
          const prefix = list.tagName.toLowerCase() === 'ol' ? '1. ' : '- ';
          this.addContentToSections(`${prefix}${text}`, sections, addedSections);
        }
      }
      this.addContentToSections('', sections, addedSections);
    } catch (error) {
      console.error('Error processing list:', error);
    }
  }

  private async waitForStorybookAPI(): Promise<void> {
    // Wait for Storybook API to be available
    const maxAttempts = 5;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const hasAPI = !!(window as any).__STORYBOOK_CLIENT_API__;
      if (hasAPI) {
        // Wait for story store to be ready
        const api = (window as any).__STORYBOOK_CLIENT_API__;
        if (api.storyStore && typeof api.storyStore.ready === 'function') {
          await api.storyStore.ready();
        }
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  async extractContent(document: Document): Promise<ExtractedContent> {
    const emptyResult = {
      content: '',
      metadata: { type: 'overview' as const }
    };

    try {
      // Wait for Storybook API
      await this.waitForStorybookAPI();

      // Wait for content to be loaded
      const mainArea = await this.waitForStorybookContent(document);
      if (!mainArea) {
        console.error('Failed to find Storybook content area');
        return emptyResult;
      }

      const sections: string[] = [];
      const addedSections = new Set<string>();
      let mainTitle = '';
      let mainDescription = '';

      // 1. Title and Description
      const title = mainArea.querySelector('h1')?.textContent?.trim();
      if (title) {
        mainTitle = title;
        this.addContentToSections(`# ${title}`, sections, addedSections);
        this.addContentToSections('', sections, addedSections);
      }

      const description = mainArea.querySelector('h1 + p');
      if (description) {
        mainDescription = this.extractLinks(description);
        this.addContentToSections(mainDescription, sections, addedSections);
        this.addContentToSections('', sections, addedSections);
      }

      // 2. Process content by headings
      const headings = mainArea.querySelectorAll('h1, h2, h3, h4');
      for (const heading of headings) {
        const title = heading.textContent?.trim();
        if (title && !addedSections.has(`## ${title}`)) {
          // Add section heading
          const level = heading.tagName === 'H1' ? '#' : '##';
          this.addContentToSections(`${level} ${title}`, sections, addedSections);
          this.addContentToSections('', sections, addedSections);

          // Process content between this heading and the next heading
          let current = heading.nextElementSibling;
          while (current && !current.matches('h1, h2, h3, h4')) {
            if (this.isElementVisible(current)) {
              // Handle tables and lists
              if (current.matches('table') && !current.matches('.docblock-argstable')) {
                await this.processTableContent(current, sections, addedSections);
              } else if (current.matches('ul, ol')) {
                await this.processListContent(current, sections, addedSections);
              } else {
                await this.processSectionContent(current, sections, addedSections);
              }
            }
            current = current.nextElementSibling;
          }
        }
      }

      // 3. Process props table last
      const propsTable = mainArea.querySelector('.docblock-argstable');
      if (propsTable) {
        await this.processPropsTable(propsTable, sections, addedSections);
      }

      // 4. Process any iframes that might contain additional content
      const iframes = mainArea.querySelectorAll('iframe');
      for (const iframe of iframes) {
        try {
          const iframeDoc = (iframe as HTMLIFrameElement).contentDocument;
          if (iframeDoc) {
            const iframeContent = iframeDoc.querySelector('body');
            if (iframeContent) {
              await this.processSection(iframeContent, sections, addedSections);
            }
          }
        } catch (error) {
          console.error('Error processing iframe:', error);
        }
      }

      // Return the final result
      return {
        content: sections.join('\n\n'),
        metadata: {
          type: 'overview' as const,
          pattern: {
            name: mainTitle,
            type: 'component',
            description: mainDescription,
            usageContexts: [],
            relatedPatterns: []
          }
        }
      };
    } catch (error) {
      console.error('Error extracting Storybook content:', error);
      return emptyResult;
    }

  }
}

export class GitHubPagesExtractor implements ContentExtractor {
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