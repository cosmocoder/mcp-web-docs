import { DefaultExtractor } from './default-extractor.js';
import { JSDOM } from 'jsdom';

describe('DefaultExtractor', () => {
  let extractor: DefaultExtractor;

  beforeEach(() => {
    extractor = new DefaultExtractor();
  });

  function createDocument(html: string): Document {
    const dom = new JSDOM(html);
    return dom.window.document;
  }

  describe('extractContent', () => {
    it('should extract content from main element', async () => {
      const html = `
        <html>
          <body>
            <nav>Navigation</nav>
            <main>
              <h1>Main Title</h1>
              <p>Main content here</p>
            </main>
            <footer>Footer</footer>
          </body>
        </html>
      `;
      const doc = createDocument(html);
      const result = await extractor.extractContent(doc);

      expect(result.content).toContain('Main Title');
      expect(result.content).toContain('Main content here');
      expect(result.content).not.toContain('Navigation');
      expect(result.content).not.toContain('Footer');
    });

    it('should extract content from article element', async () => {
      const html = `
        <html>
          <body>
            <header>Header</header>
            <article>
              <h1>Article Title</h1>
              <p>Article content</p>
            </article>
          </body>
        </html>
      `;
      const doc = createDocument(html);
      const result = await extractor.extractContent(doc);

      expect(result.content).toContain('Article Title');
      expect(result.content).toContain('Article content');
      expect(result.content).not.toContain('Header');
    });

    it('should extract content from role="main" element', async () => {
      const html = `
        <html>
          <body>
            <nav>Nav</nav>
            <div role="main">
              <h1>Role Main Title</h1>
              <p>Role main content</p>
            </div>
          </body>
        </html>
      `;
      const doc = createDocument(html);
      const result = await extractor.extractContent(doc);

      expect(result.content).toContain('Role Main Title');
      expect(result.content).toContain('Role main content');
      expect(result.content).not.toContain('Nav');
    });

    it('should fall back to body when no main content element', async () => {
      const html = `
        <html>
          <body>
            <div>
              <h1>Page Title</h1>
              <p>Page content</p>
            </div>
          </body>
        </html>
      `;
      const doc = createDocument(html);
      const result = await extractor.extractContent(doc);

      expect(result.content).toContain('Page Title');
      expect(result.content).toContain('Page content');
    });

    it('should remove script and style elements', async () => {
      const html = `
        <html>
          <body>
            <style>.hidden { display: none; }</style>
            <script>console.log('secret');</script>
            <main>
              <h1>Visible Content</h1>
            </main>
          </body>
        </html>
      `;
      const doc = createDocument(html);
      const result = await extractor.extractContent(doc);

      expect(result.content).toContain('Visible Content');
      expect(result.content).not.toContain('hidden');
      expect(result.content).not.toContain('secret');
    });

    it('should extract title from h1', async () => {
      const html = `
        <html>
          <body>
            <main>
              <h1>Component Name</h1>
              <p>Description paragraph</p>
            </main>
          </body>
        </html>
      `;
      const doc = createDocument(html);
      const result = await extractor.extractContent(doc);

      expect(result.metadata.pattern?.name).toBe('Component Name');
    });

    it('should extract description from first paragraph after h1', async () => {
      const html = `
        <html>
          <body>
            <main>
              <h1>Component Name</h1>
              <p>This is the component description.</p>
              <p>This is additional content.</p>
            </main>
          </body>
        </html>
      `;
      const doc = createDocument(html);
      const result = await extractor.extractContent(doc);

      expect(result.metadata.pattern?.description).toBe('This is the component description.');
    });

    it('should return overview type metadata', async () => {
      const html = '<html><body><main><h1>Test</h1></main></body></html>';
      const doc = createDocument(html);
      const result = await extractor.extractContent(doc);

      expect(result.metadata.type).toBe('overview');
    });

    it('should return component type pattern', async () => {
      const html = '<html><body><main><h1>Test</h1></main></body></html>';
      const doc = createDocument(html);
      const result = await extractor.extractContent(doc);

      expect(result.metadata.pattern?.type).toBe('component');
    });

    it('should handle empty document', async () => {
      const html = '<html><body></body></html>';
      const doc = createDocument(html);
      const result = await extractor.extractContent(doc);

      expect(result.content).toBe('');
      expect(result.metadata.type).toBe('overview');
    });

    it('should handle document with only whitespace', async () => {
      const html = '<html><body>   \n\n   </body></html>';
      const doc = createDocument(html);
      const result = await extractor.extractContent(doc);

      expect(result.content).toBe('');
    });

    it('should initialize usageContexts and relatedPatterns as empty arrays', async () => {
      const html = '<html><body><main><h1>Test</h1></main></body></html>';
      const doc = createDocument(html);
      const result = await extractor.extractContent(doc);

      expect(result.metadata.pattern?.usageContexts).toEqual([]);
      expect(result.metadata.pattern?.relatedPatterns).toEqual([]);
    });

    it('should handle missing h1', async () => {
      const html = `
        <html>
          <body>
            <main>
              <h2>Subheading</h2>
              <p>Content here</p>
            </main>
          </body>
        </html>
      `;
      const doc = createDocument(html);
      const result = await extractor.extractContent(doc);

      expect(result.metadata.pattern?.name).toBe('');
      expect(result.content).toContain('Content here');
    });

    it('should handle missing description paragraph', async () => {
      const html = `
        <html>
          <body>
            <main>
              <h1>Title Only</h1>
              <div>Some div content</div>
            </main>
          </body>
        </html>
      `;
      const doc = createDocument(html);
      const result = await extractor.extractContent(doc);

      expect(result.metadata.pattern?.name).toBe('Title Only');
      expect(result.metadata.pattern?.description).toBe('');
    });
  });
});
