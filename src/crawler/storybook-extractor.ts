import { ContentExtractor, ExtractedContent } from './content-extractor-types.js';

export class StorybookExtractor implements ContentExtractor {
  private addContentToSections(content: string, sections: string[], addedSections: Set<string>): void {
    const trimmed = content.trim();
    if (trimmed && !addedSections.has(trimmed)) {
      sections.push(trimmed);
      addedSections.add(trimmed);
    }
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
        const linkHtml = link.outerHTML;
        content = content.replace(linkHtml, `[${text}](${href})`);
      }
    });

    // Handle inline code elements
    const codeElements = element.querySelectorAll('code, [class*="code"], [class*="inline-code"], [class*="monospace"]');
    codeElements.forEach(code => {
      const text = code.textContent?.trim();
      if (text) {
        const codeHtml = code.outerHTML;
        content = content.replace(codeHtml, `\`${text}\``);
      }
    });

    const div = document.createElement('div');
    div.innerHTML = content;
    return div.textContent?.trim() || '';
  }

  private async processSection(section: Element, sections: string[], addedSections: Set<string>): Promise<void> {
    try {
      const heading = section.querySelector('h2, h3, h4') ||
                     section.closest('section')?.querySelector('h2, h3, h4');

      if (heading) {
        const title = heading.textContent?.trim();
        if (title && !addedSections.has(`## ${title}`)) {
          this.addContentToSections(`## ${title}`, sections, addedSections);
          this.addContentToSections('', sections, addedSections);

          let current = heading.nextElementSibling;
          while (current && !current.matches('h2, h3, h4')) {
            await this.processSectionContent(current, sections, addedSections);
            current = current.nextElementSibling;
          }
        }
      }

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
      if (!this.isElementVisible(element)) return;

      if (element.matches('p, div[class*="description"], [class*="markdown"], [class*="text"], [class*="content"], [class*="docblock-text"]')) {
        const text = this.extractLinks(element);
        if (text) {
          this.addContentToSections(text, sections, addedSections);
          this.addContentToSections('', sections, addedSections);
        }
      }

      if (element.matches('pre.prismjs')) {
        const code = element.textContent?.trim() || '';
        if (code) {
          const language = element.className.match(/language-(\w+)/)?.[1] || 'typescript';
          const formattedCode = this.formatCodeBlock(code, language);
          this.addContentToSections(formattedCode, sections, addedSections);
          this.addContentToSections('', sections, addedSections);
        }
      }

      if (element.matches('table')) {
        await this.processTableContent(element, sections, addedSections);
      }

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

      const button = element.querySelector('button');
      if (button?.textContent?.trim() === 'Expand') {
        try {
          (button as HTMLButtonElement).click();
          await new Promise(resolve => setTimeout(resolve, 500));
        } catch (error) {
          console.error('Error clicking expand button:', error);
        }
      }

      const codeButtons = Array.from(element.querySelectorAll('button'))
        .filter(button => {
          const text = button.textContent?.toLowerCase() || '';
          return text.includes('show code');
        });

      for (const button of codeButtons) {
        try {
          if (!this.isElementVisible(button)) continue;

          (button as HTMLButtonElement).click();
          await new Promise(resolve => setTimeout(resolve, 500));

          const codeBlocks = element.querySelectorAll('pre.prismjs');
          for (const block of codeBlocks) {
            if (!this.isElementVisible(block)) continue;
            const code = block.textContent?.trim() || '';
            if (code) {
              const language = block.className.match(/language-(\w+)/)?.[1] || 'typescript';
              const formattedCode = this.formatCodeBlock(code, language);
              this.addContentToSections(formattedCode, sections, addedSections);
              this.addContentToSections('', sections, addedSections);
            }
          }

          (button as HTMLButtonElement).click();
        } catch (error) {
          console.error('Error handling code button:', error);
        }
      }

      const children = Array.from(element.children).filter(el => {
        if (el.matches('h1, h2, h3, h4')) return false;
        if (el.matches('script, style, iframe')) return false;
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

        const typeInfo = cells[0]?.querySelector('span[class*="type"], code')?.textContent?.trim();
        const type = typeInfo?.replace(/["']/g, '`');

        const formattedName = `${name}${type ? ` (\`${type}\`)` : ''}`;
        const formattedDesc = description.replace(/\|/g, '\\|');
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

  private async waitForSidebar(document: Document): Promise<void> {
    const maxAttempts = 20;
    const delay = 250;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const sidebar = document.querySelector('[class*="sidebar"]');
      if (sidebar) {
        // Wait for sidebar content to load
        await new Promise(resolve => setTimeout(resolve, 500));
        return;
      }
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  private async expandSidebarSections(document: Document): Promise<void> {
    try {
      // Wait for sidebar to be ready
      await this.waitForSidebar(document);

      // Find all sidebar-subheading-action buttons (the "Show/Hide" buttons)
      const sidebarButtons = document.querySelectorAll('button.sidebar-subheading-action');
      console.debug(`[StorybookExtractor] Found ${sidebarButtons.length} sidebar buttons to expand`);

      // First pass: Click all buttons to show all sections
      for (const button of sidebarButtons) {
        if (this.isElementVisible(button)) {
          (button as HTMLButtonElement).click();
          // Wait for content to update
          await new Promise(resolve => setTimeout(resolve, 250));
        }
      }

      // Wait for any new buttons that might appear
      await new Promise(resolve => setTimeout(resolve, 500));

      // Second pass: Click any new buttons that appeared
      const newButtons = document.querySelectorAll('button.sidebar-subheading-action');
      console.debug(`[StorybookExtractor] Found ${newButtons.length} total sidebar buttons after expansion`);

      for (const button of newButtons) {
        if (this.isElementVisible(button)) {
          (button as HTMLButtonElement).click();
          // Wait for content to update
          await new Promise(resolve => setTimeout(resolve, 250));
        }
      }

      // Final wait to ensure all sections have expanded
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (error) {
      console.error('[StorybookExtractor] Error expanding sidebar sections:', error);
    }
  }

  private async waitForStorybookContent(document: Document): Promise<Element | null> {
    const maxAttempts = 10;
    const delay = 500;

    // First, expand all sidebar sections
    await this.expandSidebarSections(document);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise(resolve => setTimeout(resolve, delay));

      const mainArea = document.querySelector('.sbdocs-content, #docs-root');
      if (!mainArea) continue;

      const hasContent = mainArea.querySelector('h1') && (
        mainArea.querySelector('p') ||
        mainArea.querySelector('table') ||
        mainArea.querySelector('ul, ol') ||
        mainArea.querySelector('[class*="docblock"]')
      );

      if (hasContent) {
        await new Promise(resolve => setTimeout(resolve, 500));
        return mainArea;
      }

      const loadingIndicator = document.querySelector('[class*="loading"], [class*="pending"]');
      if (!loadingIndicator) {
        console.warn('No loading indicator found but content is missing');
      }
    }

    return null;
  }

  private async processTableContent(table: Element, sections: string[], addedSections: Set<string>): Promise<void> {
    try {
      const headers = Array.from(table.querySelectorAll('th')).map(th => th.textContent?.trim() || '');
      if (headers.length === 0) return;

      this.addContentToSections(`| ${headers.join(' | ')} |`, sections, addedSections);
      this.addContentToSections(`| ${headers.map(() => '---').join(' | ')} |`, sections, addedSections);

      const rows = table.querySelectorAll('tr');
      for (const row of rows) {
        const cells = Array.from(row.querySelectorAll('td')).map(td => {
          const text = this.extractLinks(td);
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
    return new Promise(resolve => {
      if (typeof (window as any).__STORYBOOK_CLIENT_API__ !== 'undefined') {
        const checkReady = () => {
          const api = (window as any).__STORYBOOK_CLIENT_API__;
          if (api?.storyStore?.ready) {
            resolve();
          } else {
            setTimeout(checkReady, 100);
          }
        };
        checkReady();
        return;
      }

      if (document.querySelector('#storybook-root, .sbdocs, [data-nodetype="root"]') !== null ||
          document.querySelector('meta[name="storybook-version"]') !== null ||
          document.baseURI?.includes('path=/docs/') ||
          document.baseURI?.includes('path=/story/')) {
        resolve();
        return;
      }

      resolve();
    });
  }

  async extractContent(document: Document): Promise<ExtractedContent> {
    const emptyResult = {
      content: '',
      metadata: { type: 'overview' as const }
    };

    try {
      await this.waitForStorybookAPI();

      const mainArea = await this.waitForStorybookContent(document);
      if (!mainArea) {
        console.error('Failed to find Storybook content area');
        return emptyResult;
      }

      const sections: string[] = [];
      const addedSections = new Set<string>();
      let mainTitle = '';
      let mainDescription = '';

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

      const headings = mainArea.querySelectorAll('h1, h2, h3, h4');
      for (const heading of headings) {
        const title = heading.textContent?.trim();
        if (title && !addedSections.has(`## ${title}`)) {
          const level = heading.tagName === 'H1' ? '#' : '##';
          this.addContentToSections(`${level} ${title}`, sections, addedSections);
          this.addContentToSections('', sections, addedSections);

          let current = heading.nextElementSibling;
          while (current && !current.matches('h1, h2, h3, h4')) {
            if (this.isElementVisible(current)) {
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

      const propsTable = mainArea.querySelector('.docblock-argstable');
      if (propsTable) {
        await this.processPropsTable(propsTable, sections, addedSections);
      }

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
