import { JSDOM } from 'jsdom';
import { StorybookExtractor } from './storybook-extractor.js';

describe('StorybookExtractor', () => {
  let extractor: StorybookExtractor;
  let originalWindow: typeof globalThis.window;

  beforeEach(() => {
    extractor = new StorybookExtractor();

    // Store original window
    originalWindow = globalThis.window;

    // Mock the private waiting methods to skip delays (using spyOn on instance)
    // These mocks are necessary because:
    // - waitForStorybookAPI checks for window.__STORYBOOK_CLIENT_API__ which doesn't exist in JSDOM
    // - waitForStorybookContent uses polling with timeouts
    // - expandSidebarSections and waitForSidebar interact with UI elements
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const extractorAny = extractor as any;

    vi.spyOn(extractorAny, 'waitForStorybookAPI').mockResolvedValue(undefined);
    vi.spyOn(extractorAny, 'waitForStorybookContent').mockImplementation((doc: unknown) => {
      return Promise.resolve((doc as Document).querySelector('.sbdocs-content, #docs-root'));
    });
    vi.spyOn(extractorAny, 'expandSidebarSections').mockResolvedValue(undefined);
    vi.spyOn(extractorAny, 'waitForSidebar').mockResolvedValue(undefined);
    // Mock expandAllTypeValues to skip setTimeout delays in props table processing
    vi.spyOn(extractorAny, 'expandAllTypeValues').mockResolvedValue(undefined);
  });

  afterEach(() => {
    // Restore original window
    globalThis.window = originalWindow;
    vi.restoreAllMocks();
  });

  const createDocument = (html: string): Document => {
    const dom = new JSDOM(html, {
      runScripts: 'dangerously',
      pretendToBeVisual: true,
    });

    // Set the global window to the JSDOM window so getComputedStyle works
    globalThis.window = dom.window as unknown as typeof globalThis.window;

    // Mock getComputedStyle to return visible styles
    dom.window.getComputedStyle = vi.fn().mockReturnValue({
      display: 'block',
      visibility: 'visible',
      opacity: '1',
    }) as unknown as typeof dom.window.getComputedStyle;

    return dom.window.document;
  };

  describe('extractContent', () => {
    it('should extract title from h1', async () => {
      const doc = createDocument(`
        <html>
          <body>
            <div class="sbdocs-content">
              <h1>Button Component</h1>
              <p>A clickable button element</p>
            </div>
          </body>
        </html>
      `);

      const result = await extractor.extractContent(doc);

      expect(result.content).toContain('# Button Component');
      expect(result.metadata.pattern?.name).toBe('Button Component');
    });

    it('should extract description from first paragraph after h1', async () => {
      const doc = createDocument(`
        <html>
          <body>
            <div class="sbdocs-content">
              <h1>Card</h1>
              <p>A container component for grouping content</p>
            </div>
          </body>
        </html>
      `);

      const result = await extractor.extractContent(doc);

      expect(result.content).toContain('A container component');
      expect(result.metadata.pattern?.description).toBe('A container component for grouping content');
    });

    it('should extract section headings', async () => {
      const doc = createDocument(`
        <html>
          <body>
            <div class="sbdocs-content">
              <h1>Component</h1>
              <p>Description</p>
              <h2>Usage</h2>
              <p>Usage instructions</p>
              <h2>Examples</h2>
              <p>Example content</p>
            </div>
          </body>
        </html>
      `);

      const result = await extractor.extractContent(doc);

      expect(result.content).toContain('## Usage');
      expect(result.content).toContain('## Examples');
    });

    it('should return empty content when no main area found', async () => {
      const doc = createDocument(`
        <html>
          <body>
            <div class="other-content">
              <p>Some text</p>
            </div>
          </body>
        </html>
      `);

      const result = await extractor.extractContent(doc);

      expect(result.content).toBe('');
      expect(result.metadata.type).toBe('overview');
    });

    it('should extract from #docs-root element', async () => {
      const doc = createDocument(`
        <html>
          <body>
            <div id="docs-root">
              <h1>Docs Root Content</h1>
              <p>Content in docs root</p>
            </div>
          </body>
        </html>
      `);

      const result = await extractor.extractContent(doc);

      expect(result.content).toContain('# Docs Root Content');
    });

    it('should set metadata type to overview', async () => {
      const doc = createDocument(`
        <html>
          <body>
            <div class="sbdocs-content">
              <h1>Test</h1>
              <p>Description</p>
            </div>
          </body>
        </html>
      `);

      const result = await extractor.extractContent(doc);

      expect(result.metadata.type).toBe('overview');
    });

    it('should set pattern type to component', async () => {
      const doc = createDocument(`
        <html>
          <body>
            <div class="sbdocs-content">
              <h1>Alert</h1>
              <p>Alert component description</p>
            </div>
          </body>
        </html>
      `);

      const result = await extractor.extractContent(doc);

      expect(result.metadata.pattern?.type).toBe('component');
    });

    it('should initialize usageContexts as empty array', async () => {
      const doc = createDocument(`
        <html>
          <body>
            <div class="sbdocs-content">
              <h1>Test</h1>
              <p>Description</p>
            </div>
          </body>
        </html>
      `);

      const result = await extractor.extractContent(doc);

      expect(result.metadata.pattern?.usageContexts).toEqual([]);
    });

    it('should initialize relatedPatterns as empty array', async () => {
      const doc = createDocument(`
        <html>
          <body>
            <div class="sbdocs-content">
              <h1>Test</h1>
              <p>Description</p>
            </div>
          </body>
        </html>
      `);

      const result = await extractor.extractContent(doc);

      expect(result.metadata.pattern?.relatedPatterns).toEqual([]);
    });
  });

  describe('code block extraction', () => {
    it('should format code blocks with language', async () => {
      const doc = createDocument(`
        <html>
          <body>
            <div class="sbdocs-content">
              <h1>Component</h1>
              <p>Description</p>
              <pre class="prismjs language-typescript">const x = 1;</pre>
            </div>
          </body>
        </html>
      `);

      const result = await extractor.extractContent(doc);

      expect(result.content).toContain('```typescript');
      expect(result.content).toContain('const x = 1;');
      expect(result.content).toContain('```');
    });

    it('should default to typescript when no language specified', async () => {
      const doc = createDocument(`
        <html>
          <body>
            <div class="sbdocs-content">
              <h1>Component</h1>
              <p>Description</p>
              <pre class="prismjs">const y = 2;</pre>
            </div>
          </body>
        </html>
      `);

      const result = await extractor.extractContent(doc);

      expect(result.content).toContain('```typescript');
    });
  });

  describe('link extraction', () => {
    it('should convert links to markdown format', async () => {
      const doc = createDocument(`
        <html>
          <body>
            <div class="sbdocs-content">
              <h1>Component</h1>
              <p>See the <a href="/docs/guide">documentation guide</a> for more info.</p>
            </div>
          </body>
        </html>
      `);

      const result = await extractor.extractContent(doc);

      expect(result.content).toContain('[documentation guide](/docs/guide)');
    });

    it('should handle inline code elements', async () => {
      const doc = createDocument(`
        <html>
          <body>
            <div class="sbdocs-content">
              <h1>Component</h1>
              <p>Use the <code>onClick</code> prop to handle clicks.</p>
            </div>
          </body>
        </html>
      `);

      const result = await extractor.extractContent(doc);

      expect(result.content).toContain('`onClick`');
    });
  });

  describe('table extraction', () => {
    it('should extract regular tables as markdown', async () => {
      const doc = createDocument(`
        <html>
          <body>
            <div class="sbdocs-content">
              <h1>Component</h1>
              <p>Description</p>
              <h2>Options</h2>
              <table>
                <tr><th>Option</th><th>Value</th></tr>
                <tr><td>size</td><td>small</td></tr>
              </table>
            </div>
          </body>
        </html>
      `);

      const result = await extractor.extractContent(doc);

      expect(result.content).toContain('| Option | Value |');
      expect(result.content).toContain('| size | small |');
    });

    it('should escape pipe characters in table cells', async () => {
      const doc = createDocument(`
        <html>
          <body>
            <div class="sbdocs-content">
              <h1>Component</h1>
              <p>Description</p>
              <h2>Types</h2>
              <table>
                <tr><th>Type</th></tr>
                <tr><td>a | b | c</td></tr>
              </table>
            </div>
          </body>
        </html>
      `);

      const result = await extractor.extractContent(doc);

      expect(result.content).toContain('a \\| b \\| c');
    });
  });

  describe('list extraction', () => {
    it('should extract unordered lists', async () => {
      const doc = createDocument(`
        <html>
          <body>
            <div class="sbdocs-content">
              <h1>Component</h1>
              <p>Description</p>
              <h2>Features</h2>
              <ul>
                <li>Feature one</li>
                <li>Feature two</li>
              </ul>
            </div>
          </body>
        </html>
      `);

      const result = await extractor.extractContent(doc);

      expect(result.content).toContain('- Feature one');
      expect(result.content).toContain('- Feature two');
    });

    it('should extract ordered lists', async () => {
      const doc = createDocument(`
        <html>
          <body>
            <div class="sbdocs-content">
              <h1>Component</h1>
              <p>Description</p>
              <h2>Steps</h2>
              <ol>
                <li>Step one</li>
                <li>Step two</li>
              </ol>
            </div>
          </body>
        </html>
      `);

      const result = await extractor.extractContent(doc);

      expect(result.content).toContain('1. Step one');
      expect(result.content).toContain('1. Step two');
    });
  });

  describe('props table extraction', () => {
    it('should extract props table with ArgTable class', async () => {
      const doc = createDocument(`
        <html>
          <body>
            <div class="sbdocs-content">
              <h1>Button</h1>
              <p>A button component</p>
              <table class="docblock-argstable">
                <tr><th>Name</th><th>Type</th><th>Default</th></tr>
                <tr><td>variant</td><td>string</td><td>"primary"</td></tr>
              </table>
            </div>
          </body>
        </html>
      `);

      const result = await extractor.extractContent(doc);

      expect(result.content).toContain('## Button Props');
      expect(result.content).toContain('| Name | Type | Default |');
    });

    it('should handle required props with asterisk', async () => {
      const doc = createDocument(`
        <html>
          <body>
            <div class="sbdocs-content">
              <h1>Input</h1>
              <p>An input component</p>
              <table class="docblock-argstable">
                <tr><th>Name</th><th>Type</th><th>Default</th></tr>
                <tr><td>value*</td><td>string</td><td>-</td></tr>
              </table>
            </div>
          </body>
        </html>
      `);

      const result = await extractor.extractContent(doc);

      expect(result.content).toContain('| value* |');
    });

    it('should use component name in Props heading when available', async () => {
      const doc = createDocument(`
        <html>
          <body>
            <div class="sbdocs-content">
              <h1>MyComponent</h1>
              <p>Description</p>
              <table class="docblock-argstable">
                <tr><th>Name</th><th>Type</th><th>Default</th></tr>
                <tr><td>prop1</td><td>string</td><td>-</td></tr>
              </table>
            </div>
          </body>
        </html>
      `);

      const result = await extractor.extractContent(doc);

      expect(result.content).toContain('## MyComponent Props');
    });
  });

  describe('error handling', () => {
    it('should return empty result when no content found', async () => {
      const doc = createDocument('<html><body></body></html>');

      const result = await extractor.extractContent(doc);

      expect(result.content).toBe('');
      expect(result.metadata.type).toBe('overview');
    });

    it('should handle missing h1 gracefully', async () => {
      const doc = createDocument(`
        <html>
          <body>
            <div class="sbdocs-content">
              <h2>Section</h2>
              <p>Content without h1 heading</p>
            </div>
          </body>
        </html>
      `);

      const result = await extractor.extractContent(doc);

      // Without h1, name should be empty string (pattern is still created)
      expect(result.metadata.pattern?.name).toBe('');
    });
  });

  describe('content deduplication', () => {
    it('should not add duplicate sections', async () => {
      const doc = createDocument(`
        <html>
          <body>
            <div class="sbdocs-content">
              <h1>Component</h1>
              <p>Description</p>
              <h2>Usage</h2>
              <p>Usage text</p>
              <h2>Usage</h2>
              <p>Duplicate heading</p>
            </div>
          </body>
        </html>
      `);

      const result = await extractor.extractContent(doc);

      // Count occurrences of "## Usage"
      const matches = result.content.match(/## Usage/g);
      expect(matches?.length || 0).toBeLessThanOrEqual(1);
    });

    it('should not add duplicate content', async () => {
      const doc = createDocument(`
        <html>
          <body>
            <div class="sbdocs-content">
              <h1>Component</h1>
              <p>Same content</p>
              <p>Same content</p>
            </div>
          </body>
        </html>
      `);

      const result = await extractor.extractContent(doc);

      // The content should be deduplicated
      const matches = result.content.match(/Same content/g);
      expect(matches?.length || 0).toBeLessThanOrEqual(1);
    });
  });

  describe('formatCodeBlock', () => {
    it('should clean up code with tabs', async () => {
      const doc = createDocument(`
        <html>
          <body>
            <div class="sbdocs-content">
              <h1>Component</h1>
              <p>Description</p>
              <pre class="prismjs language-typescript">function test() {
\treturn true;
}</pre>
            </div>
          </body>
        </html>
      `);

      const result = await extractor.extractContent(doc);

      expect(result.content).toContain('  return true;');
    });

    it('should reduce multiple blank lines', async () => {
      const doc = createDocument(`
        <html>
          <body>
            <div class="sbdocs-content">
              <h1>Component</h1>
              <p>Description</p>
              <pre class="prismjs language-typescript">const a = 1;



const b = 2;</pre>
            </div>
          </body>
        </html>
      `);

      const result = await extractor.extractContent(doc);

      // Should not have more than 2 consecutive newlines
      expect(result.content).not.toMatch(/\n{4,}/);
    });
  });
});
