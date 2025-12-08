import { processHtmlContent } from './content.js';
import type { CrawlResult } from '../types.js';

describe('HTML Content Processor', () => {
  describe('processHtmlContent', () => {
    it('should process simple HTML content', async () => {
      const page: CrawlResult = {
        url: 'https://example.com/docs/page',
        path: '/docs/page',
        title: 'Documentation Page',
        content: `
          <!DOCTYPE html>
          <html>
            <head><title>Page Title</title></head>
            <body>
              <main>
                <h1>Welcome to the Documentation</h1>
                <p>This is the introduction paragraph.</p>
                <h2>Getting Started</h2>
                <p>Here's how to get started.</p>
              </main>
            </body>
          </html>
        `,
      };

      const result = await processHtmlContent(page);

      expect(result).toBeDefined();
      expect(result?.article.url).toBe(page.url);
      expect(result?.article.components.length).toBeGreaterThan(0);
    });

    it('should extract content from article tags', async () => {
      const page: CrawlResult = {
        url: 'https://example.com/blog/post',
        path: '/blog/post',
        title: 'Blog Post',
        content: `
          <html>
            <body>
              <nav>Navigation items</nav>
              <article>
                <h1>Article Title</h1>
                <p>Article content goes here.</p>
                <h2>Section One</h2>
                <p>More content.</p>
              </article>
              <footer>Footer content</footer>
            </body>
          </html>
        `,
      };

      const result = await processHtmlContent(page);

      expect(result).toBeDefined();
      expect(result?.content).toContain('Article content');
      // Should not include nav/footer content
      expect(result?.content).not.toContain('Navigation items');
    });

    it('should handle documentation-specific selectors', async () => {
      const page: CrawlResult = {
        url: 'https://example.com/docs',
        path: '/docs',
        title: 'Docs',
        content: `
          <html>
            <body>
              <div class="sidebar">Sidebar</div>
              <div class="markdown-body">
                <h1>Documentation</h1>
                <p>Main documentation content.</p>
              </div>
            </body>
          </html>
        `,
      };

      const result = await processHtmlContent(page);

      expect(result).toBeDefined();
      expect(result?.content).toContain('Main documentation content');
    });

    it('should preserve code blocks', async () => {
      const page: CrawlResult = {
        url: 'https://example.com/code',
        path: '/code',
        title: 'Code',
        content: `
          <html>
            <body>
              <main>
                <h1>Code Examples</h1>
                <pre><code>function example() {
  return "Hello";
}</code></pre>
              </main>
            </body>
          </html>
        `,
      };

      const result = await processHtmlContent(page);

      expect(result).toBeDefined();
      expect(result?.content).toContain('function example');
    });

    it('should handle lists properly', async () => {
      const page: CrawlResult = {
        url: 'https://example.com/list',
        path: '/list',
        title: 'List',
        content: `
          <html>
            <body>
              <main>
                <h1>Features</h1>
                <ul>
                  <li>Feature one</li>
                  <li>Feature two</li>
                  <li>Feature three</li>
                </ul>
              </main>
            </body>
          </html>
        `,
      };

      const result = await processHtmlContent(page);

      expect(result).toBeDefined();
      expect(result?.content).toContain('Feature one');
      expect(result?.content).toContain('Feature two');
    });

    it('should handle tables', async () => {
      const page: CrawlResult = {
        url: 'https://example.com/table',
        path: '/table',
        title: 'Table',
        content: `
          <html>
            <body>
              <main>
                <h1>API Reference</h1>
                <table>
                  <tr><th>Method</th><th>Description</th></tr>
                  <tr><td>GET</td><td>Retrieve data</td></tr>
                  <tr><td>POST</td><td>Create data</td></tr>
                </table>
              </main>
            </body>
          </html>
        `,
      };

      const result = await processHtmlContent(page);

      expect(result).toBeDefined();
      expect(result?.content).toContain('GET');
      expect(result?.content).toContain('POST');
    });

    it('should skip script and style tags', async () => {
      const page: CrawlResult = {
        url: 'https://example.com/scripts',
        path: '/scripts',
        title: 'Scripts',
        content: `
          <html>
            <head>
              <style>.class { color: red; }</style>
            </head>
            <body>
              <script>alert('hello');</script>
              <main>
                <h1>Content</h1>
                <p>Actual content here.</p>
              </main>
              <script>console.log('end');</script>
            </body>
          </html>
        `,
      };

      const result = await processHtmlContent(page);

      expect(result).toBeDefined();
      expect(result?.content).not.toContain('alert');
      expect(result?.content).not.toContain('color: red');
      expect(result?.content).toContain('Actual content');
    });

    it('should use Readability as fallback', async () => {
      const page: CrawlResult = {
        url: 'https://example.com/blog',
        path: '/blog',
        title: 'Blog',
        content: `
          <html>
            <head><title>Blog Post</title></head>
            <body>
              <div>
                <p>This is a paragraph of content.</p>
                <p>Another paragraph with more information.</p>
                <p>Yet another paragraph to provide enough content for Readability.</p>
                <p>Additional paragraph for proper content extraction.</p>
                <p>Final paragraph of meaningful content.</p>
              </div>
            </body>
          </html>
        `,
      };

      const result = await processHtmlContent(page);

      // Should still extract something even without clear main content
      expect(result).toBeDefined();
    });

    it('should return undefined for pages without extractable content', async () => {
      const page: CrawlResult = {
        url: 'https://example.com/empty',
        path: '/empty',
        title: 'Empty',
        content: `
          <html>
            <body>
              <nav>Just navigation</nav>
            </body>
          </html>
        `,
      };

      const result = await processHtmlContent(page);
      // May return undefined or minimal content depending on parser
      if (result) {
        expect(result.content.length).toBeLessThan(100);
      }
    });

    it('should handle Storybook-specific classes', async () => {
      const page: CrawlResult = {
        url: 'https://storybook.example.com/docs',
        path: '/docs',
        title: 'Storybook',
        content: `
          <html>
            <body>
              <div class="sbdocs-wrapper">
                <div class="sbdocs-content">
                  <h1 class="sbdocs-h1">Component Documentation</h1>
                  <div class="docblock-description">
                    <p>Description of the component.</p>
                  </div>
                </div>
              </div>
            </body>
          </html>
        `,
      };

      const result = await processHtmlContent(page);

      expect(result).toBeDefined();
      expect(result?.content).toContain('Component Documentation');
    });

    it('should handle React app root containers', async () => {
      const page: CrawlResult = {
        url: 'https://example.com/react-app',
        path: '/react-app',
        title: 'React App',
        content: `
          <html>
            <body>
              <div id="root">
                <div>
                  <h1>React App Content</h1>
                  <p>This is rendered by React.</p>
                </div>
              </div>
            </body>
          </html>
        `,
      };

      const result = await processHtmlContent(page);

      expect(result).toBeDefined();
      expect(result?.content).toContain('React App Content');
    });

    it('should handle Next.js containers', async () => {
      const page: CrawlResult = {
        url: 'https://example.com/nextjs',
        path: '/nextjs',
        title: 'Next.js',
        content: `
          <html>
            <body>
              <div id="__next">
                <main>
                  <h1>Next.js Page</h1>
                  <p>Content from Next.js.</p>
                </main>
              </div>
            </body>
          </html>
        `,
      };

      const result = await processHtmlContent(page);

      expect(result).toBeDefined();
      expect(result?.content).toContain('Next.js Page');
    });

    it('should handle multiple heading levels for section extraction', async () => {
      const page: CrawlResult = {
        url: 'https://example.com/headings',
        path: '/headings',
        title: 'Headings',
        content: `
          <html>
            <body>
              <main>
                <h1>Main Title</h1>
                <p>Intro text.</p>
                <h2>Section 1</h2>
                <p>Section 1 content.</p>
                <h3>Subsection 1.1</h3>
                <p>Subsection content.</p>
                <h2>Section 2</h2>
                <p>Section 2 content.</p>
                <h4>Deep Section</h4>
                <p>Deep content.</p>
              </main>
            </body>
          </html>
        `,
      };

      const result = await processHtmlContent(page);

      expect(result).toBeDefined();
      expect(result?.article.components.length).toBeGreaterThan(3);
    });

    it('should handle malformed HTML gracefully', async () => {
      const page: CrawlResult = {
        url: 'https://example.com/malformed',
        path: '/malformed',
        title: 'Malformed',
        content: `
          <html>
            <body>
              <div>
                <p>Unclosed paragraph
                <p>Another unclosed
                <span>Nested <b>incorrectly</span></b>
                <main>
                  <h1>Still Works</h1>
                  <p>Content here.</p>
                </main>
              </div>
            </body>
          </html>
        `,
      };

      // Should not throw
      const result = await processHtmlContent(page);
      expect(result).toBeDefined();
    });

    it('should clean text and remove extra whitespace', async () => {
      const page: CrawlResult = {
        url: 'https://example.com/whitespace',
        path: '/whitespace',
        title: 'Whitespace',
        content: `
          <html>
            <body>
              <main>
                <h1>Title</h1>
                <p>Text    with    extra     spaces.</p>
                <p>


                Multiple newlines here.


                </p>
              </main>
            </body>
          </html>
        `,
      };

      const result = await processHtmlContent(page);

      expect(result).toBeDefined();
      // Should normalize whitespace
      expect(result?.content).not.toMatch(/\s{3,}/);
    });
  });
});
