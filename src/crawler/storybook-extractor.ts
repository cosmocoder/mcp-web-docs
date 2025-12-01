import { ContentExtractor, ExtractedContent } from './content-extractor-types.js';
import { logger } from '../util/logger.js';

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
      logger.debug('Error processing section:', error);
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
          logger.debug('Error clicking expand button:', error);
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
          logger.debug('Error handling code button:', error);
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
      logger.debug('Error processing section content:', error);
    }
  }

  private async processPropsTable(table: Element, sections: string[], addedSections: Set<string>): Promise<void> {
    this.addContentToSections('## Props', sections, addedSections);
    this.addContentToSections('', sections, addedSections);
    this.addContentToSections('| Name | Type | Default |', sections, addedSections);
    this.addContentToSections('|------|------|---------|', sections, addedSections);

    const rows = Array.from(table.querySelectorAll('tr, tbody > div[role="row"]'));

    for (const row of rows) {
      // Skip header rows
      if (row.querySelector('th, [role="columnheader"]')) continue;

      const cells = row.querySelectorAll('td, [role="cell"]');
      if (cells.length === 0) continue;

      let name = '';
      let type = '';
      let defaultValue = '-';
      let required = false;

      // Cell 0: Name
      if (cells[0]) {
        const nameCell = cells[0];
        name = nameCell.textContent?.trim().split('\n')[0] || '';
        required = name.includes('*') || nameCell.querySelector('[class*="required"]') !== null;
        name = name.replace(/\*$/, '').trim();
      }

      // Cell 1: Type (in Storybook 7+, this is the Description column but contains type)
      // The type values are often in nested generic/span elements
      if (cells[1]) {
        const typeCell = cells[1];

        // Method 1: Look for individual type value elements (Storybook 7 format)
        // These are typically div/span elements containing quoted strings like "primary", "secondary"
        const typeValueElements = typeCell.querySelectorAll(
          '[class*="type"] > *, ' +
          'div > div:not(:has(table)):not(:has(button)), ' +
          'span[class]:not(:has(*)), ' +
          'code'
        );

        if (typeValueElements.length > 0) {
          const typeValues = Array.from(typeValueElements)
            .map(el => el.textContent?.trim())
            .filter(v => v && !v.includes('Show') && !v.includes('Deprecated'))
            .map(v => v?.replace(/^["']|["']$/g, '')) // Remove quotes
            .filter((v, i, arr) => arr.indexOf(v) === i); // Dedupe

          if (typeValues.length > 0) {
            type = typeValues.join(' \\| ');
          }
        }

        // Method 2: Fallback to full text content
        if (!type) {
          const typeText = typeCell.textContent?.trim() || '';
          // Clean up the type text - remove "Show X more..." and normalize
          type = typeText
            .replace(/Show \d+ more\.\.\.?/gi, '')
            .replace(/Show less\.\.\.?/gi, '')
            .replace(/Deprecated:[^|]+/gi, '')
            .trim();
        }
      }

      // Cell 2: Default value
      if (cells[2]) {
        const defaultCell = cells[2];
        defaultValue = defaultCell.textContent?.trim() || '-';
      }

      // If only 2 cells, second might be default
      if (cells.length === 2 && !type) {
        defaultValue = cells[1]?.textContent?.trim() || '-';
        type = '-';
      }

      // Clean and format type
      let formattedType = type
        .replace(/["']/g, '')           // Remove remaining quotes
        .replace(/\s+/g, ' ')           // Normalize whitespace
        .replace(/\s*\|\s*/g, ' \\| ')  // Normalize pipe separators
        .trim();

      // For very long type lists, keep them but make them readable
      if (formattedType.length > 150) {
        const parts = formattedType.split(' \\| ');
        if (parts.length > 6) {
          formattedType = parts.slice(0, 6).join(' \\| ') + ` (${parts.length - 6} more)`;
        }
      }

      // Clean default value
      const formattedDefault = defaultValue
        .replace(/\|/g, '\\|')
        .replace(/^["']|["']$/g, '`$&`'.replace(/["']/g, ''))  // Wrap in backticks if quoted
        .replace(/^"([^"]+)"$/, '`$1`')
        .replace(/^'([^']+)'$/, '`$1`');

      const formattedName = required ? `${name}*` : name;

      if (name && name !== 'Name') {
        this.addContentToSections(
          `| ${formattedName} | ${formattedType || '-'} | ${formattedDefault} |`,
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
      logger.debug(`[StorybookExtractor] Found ${sidebarButtons.length} sidebar buttons to expand`);

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
      logger.debug(`[StorybookExtractor] Found ${newButtons.length} total sidebar buttons after expansion`);

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
      logger.debug('[StorybookExtractor] Error expanding sidebar sections:', error);
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
      logger.debug('Error processing table:', error);
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
      logger.debug('Error processing list:', error);
    }
  }

  /**
   * Extract type annotations from inline code examples and prop documentation
   */
  private async extractTypeAnnotations(mainArea: Element, sections: string[], addedSections: Set<string>): Promise<void> {
    try {
      // Look for type definitions in code blocks
      const codeBlocks = mainArea.querySelectorAll('pre code, .prismjs, [class*="highlight"]');

      for (const block of codeBlocks) {
        const code = block.textContent || '';

        // Extract TypeScript interface/type definitions
        const interfaceMatch = code.match(/interface\s+(\w+Props?)\s*\{([^}]+)\}/);
        if (interfaceMatch) {
          const [, name, body] = interfaceMatch;
          if (!addedSections.has(`## ${name} Type`)) {
            this.addContentToSections(`## ${name} Type`, sections, addedSections);
            this.addContentToSections('```typescript', sections, addedSections);
            this.addContentToSections(`interface ${name} {${body}}`, sections, addedSections);
            this.addContentToSections('```', sections, addedSections);
            this.addContentToSections('', sections, addedSections);
          }
        }

        // Extract type alias definitions
        const typeMatch = code.match(/type\s+(\w+)\s*=\s*([^;]+);/);
        if (typeMatch) {
          const [, name, definition] = typeMatch;
          if (!addedSections.has(`Type: ${name}`)) {
            this.addContentToSections(`**Type ${name}:** \`${definition.trim()}\``, sections, addedSections);
            this.addContentToSections('', sections, addedSections);
          }
        }
      }

      // Look for prop annotations in inline code (e.g., buttonStyle="primary")
      const inlineCodes = mainArea.querySelectorAll('code:not(pre code)');
      const propAnnotations: Map<string, Set<string>> = new Map();

      for (const code of inlineCodes) {
        const text = code.textContent || '';
        // Match prop="value" or prop='value' patterns
        const propMatch = text.match(/(\w+)=["']([^"']+)["']/);
        if (propMatch) {
          const [, propName, value] = propMatch;
          if (!propAnnotations.has(propName)) {
            propAnnotations.set(propName, new Set());
          }
          propAnnotations.get(propName)?.add(value);
        }
      }

      // If we found prop annotations, add them as discovered values
      if (propAnnotations.size > 0) {
        let hasAddedHeader = false;
        for (const [propName, values] of propAnnotations) {
          if (values.size > 1) {
            if (!hasAddedHeader) {
              this.addContentToSections('## Discovered Prop Values', sections, addedSections);
              hasAddedHeader = true;
            }
            const valueList = Array.from(values).map(v => `"${v}"`).join(' | ');
            this.addContentToSections(`- **${propName}**: ${valueList}`, sections, addedSections);
          }
        }
        if (hasAddedHeader) {
          this.addContentToSections('', sections, addedSections);
        }
      }
    } catch (error) {
      logger.debug('[StorybookExtractor] Error extracting type annotations:', error);
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
        logger.debug('Failed to find Storybook content area');
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

      // Find props/args table with multiple selectors for different Storybook versions
      const propsTableSelectors = [
        '.docblock-argstable',           // Storybook 6.x
        '.docblock-argtable',            // Alternative naming
        'table.docblock-table',          // Storybook 7.x
        '[class*="ArgTable"]',           // React-based ArgTable
        '[class*="argtable"]',           // Case variations
        'table[class*="props"]',         // Generic props table
        '.sb-argstable',                 // Another Storybook variant
        '[data-testid="args-table"]',    // Test ID selector
        '.docs-story + table',           // Table after story
        'section:has(h2:contains("Props")) table', // Section with Props heading
      ];

      let propsTable: Element | null = null;
      for (const selector of propsTableSelectors) {
        try {
          propsTable = mainArea.querySelector(selector);
          if (propsTable) break;
        } catch {
          // Some selectors may not be valid in all browsers
          continue;
        }
      }

      // Also try to find ArgTypes component which renders the props
      if (!propsTable) {
        const argTypesSection = mainArea.querySelector('[class*="ArgTypes"], [class*="argtypes"]');
        if (argTypesSection) {
          propsTable = argTypesSection.querySelector('table');
        }
      }

      if (propsTable) {
        await this.processPropsTable(propsTable, sections, addedSections);
      }

      // Also extract any inline type annotations from code examples
      await this.extractTypeAnnotations(mainArea, sections, addedSections);

      // Process iframes - Storybook loads docs content in iframes
      const iframes = mainArea.querySelectorAll('iframe');
      for (const iframe of iframes) {
        try {
          const iframeDoc = (iframe as HTMLIFrameElement).contentDocument;
          if (iframeDoc) {
            // Look for props table in iframe
            const iframePropsTable = iframeDoc.querySelector(
              '.docblock-argstable, .docblock-argtable, table.docblock-table, [class*="ArgTable"]'
            );
            if (iframePropsTable && !propsTable) {
              await this.processPropsTable(iframePropsTable, sections, addedSections);
            }

            // Process any other content in the iframe
            const iframeContent = iframeDoc.querySelector('.sbdocs-content, #docs-root, body');
            if (iframeContent) {
              await this.processSection(iframeContent, sections, addedSections);

              // Also try to extract type annotations from iframe
              await this.extractTypeAnnotations(iframeContent, sections, addedSections);
            }
          }
        } catch (error) {
          // Cross-origin iframe - expected for external content
          logger.debug('Error processing iframe (may be cross-origin):', error);
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
      logger.debug('Error extracting Storybook content:', error);
      return emptyResult;
    }
  }
}
