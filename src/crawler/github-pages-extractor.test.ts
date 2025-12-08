import { JSDOM } from 'jsdom';
import { GitHubPagesExtractor } from './github-pages-extractor.js';

describe('GitHubPagesExtractor', () => {
  let extractor: GitHubPagesExtractor;

  beforeEach(() => {
    extractor = new GitHubPagesExtractor();
  });

  const createDocument = (html: string): Document => {
    const dom = new JSDOM(html);
    return dom.window.document;
  };

  describe('extractContent', () => {
    it('should extract content from main element', async () => {
      const doc = createDocument(`
        <html>
          <body>
            <nav>Navigation</nav>
            <header>Header</header>
            <main>
              <h1>Main Title</h1>
              <p>First paragraph description</p>
              <p>More content here</p>
            </main>
            <footer>Footer</footer>
          </body>
        </html>
      `);

      const result = await extractor.extractContent(doc);

      expect(result.content).toContain('Main Title');
      expect(result.content).toContain('First paragraph description');
      expect(result.content).not.toContain('Navigation');
      expect(result.content).not.toContain('Footer');
      expect(result.metadata.type).toBe('overview');
      expect(result.metadata.pattern?.name).toBe('Main Title');
      expect(result.metadata.pattern?.description).toBe('First paragraph description');
    });

    it('should extract content from article element', async () => {
      const doc = createDocument(`
        <html>
          <body>
            <nav>Navigation</nav>
            <article>
              <h1>Article Title</h1>
              <p>Article description</p>
            </article>
          </body>
        </html>
      `);

      const result = await extractor.extractContent(doc);

      expect(result.content).toContain('Article Title');
      expect(result.content).toContain('Article description');
      expect(result.metadata.pattern?.name).toBe('Article Title');
    });

    it('should extract content from markdown-body class', async () => {
      const doc = createDocument(`
        <html>
          <body>
            <div class="markdown-body">
              <h1>Markdown Content</h1>
              <p>Markdown description</p>
            </div>
          </body>
        </html>
      `);

      const result = await extractor.extractContent(doc);

      expect(result.content).toContain('Markdown Content');
      expect(result.metadata.pattern?.name).toBe('Markdown Content');
    });

    it('should return empty content when no main element found', async () => {
      const doc = createDocument(`
        <html>
          <body>
            <nav>Navigation only</nav>
            <div>Some random content</div>
          </body>
        </html>
      `);

      const result = await extractor.extractContent(doc);

      expect(result.content).toBe('');
      expect(result.metadata.type).toBe('overview');
    });

    it('should remove script and style elements', async () => {
      const doc = createDocument(`
        <html>
          <body>
            <main>
              <h1>Title</h1>
              <script>console.log('malicious');</script>
              <style>.hidden { display: none; }</style>
              <p>Safe content</p>
            </main>
          </body>
        </html>
      `);

      const result = await extractor.extractContent(doc);

      expect(result.content).toContain('Title');
      expect(result.content).toContain('Safe content');
      expect(result.content).not.toContain('malicious');
      expect(result.content).not.toContain('display: none');
    });

    it('should handle missing title gracefully', async () => {
      const doc = createDocument(`
        <html>
          <body>
            <main>
              <p>Just a paragraph without title</p>
            </main>
          </body>
        </html>
      `);

      const result = await extractor.extractContent(doc);

      expect(result.content).toContain('Just a paragraph');
      expect(result.metadata.pattern?.name).toBe('');
    });

    it('should handle missing description gracefully', async () => {
      const doc = createDocument(`
        <html>
          <body>
            <main>
              <h1>Title Only</h1>
            </main>
          </body>
        </html>
      `);

      const result = await extractor.extractContent(doc);

      expect(result.content).toContain('Title Only');
      expect(result.metadata.pattern?.description).toBe('');
    });

    it('should remove nav, header, and footer before extraction', async () => {
      const doc = createDocument(`
        <html>
          <body>
            <nav>Site Navigation</nav>
            <header>Site Header</header>
            <main>
              <h1>Main Content</h1>
              <p>This is the main content</p>
            </main>
            <footer>Site Footer</footer>
          </body>
        </html>
      `);

      // Check that nav/header/footer are removed from the document
      const result = await extractor.extractContent(doc);

      // The content should not include nav/header/footer text
      expect(result.content).not.toContain('Site Navigation');
      expect(result.content).not.toContain('Site Header');
      expect(result.content).not.toContain('Site Footer');
      expect(result.content).toContain('Main Content');
    });

    it('should set component type in pattern metadata', async () => {
      const doc = createDocument(`
        <html>
          <body>
            <main>
              <h1>Button Component</h1>
              <p>A clickable button element</p>
            </main>
          </body>
        </html>
      `);

      const result = await extractor.extractContent(doc);

      expect(result.metadata.pattern?.type).toBe('component');
      expect(result.metadata.pattern?.usageContexts).toEqual([]);
      expect(result.metadata.pattern?.relatedPatterns).toEqual([]);
    });

    it('should get first paragraph after h1 as description', async () => {
      const doc = createDocument(`
        <html>
          <body>
            <main>
              <h1>Component Name</h1>
              <p>This is the description after h1</p>
              <p>This is not the description</p>
            </main>
          </body>
        </html>
      `);

      const result = await extractor.extractContent(doc);

      expect(result.metadata.pattern?.description).toBe('This is the description after h1');
    });
  });
});
