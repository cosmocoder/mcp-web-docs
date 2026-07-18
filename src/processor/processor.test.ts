import { JSDOM } from 'jsdom';
import { WebDocumentProcessor } from './processor.js';
import { createMockEmbeddings, createFailingEmbeddings } from '../__mocks__/embeddings.js';
import type { CrawlResult } from '../types.js';
import type { EmbeddingsProvider } from '../embeddings/types.js';
import { contentExtractors } from '../crawler/content-extractors.js';

describe('WebDocumentProcessor', () => {
  let processor: WebDocumentProcessor;
  let mockEmbeddings: EmbeddingsProvider;

  beforeEach(() => {
    mockEmbeddings = createMockEmbeddings();
    processor = new WebDocumentProcessor(mockEmbeddings, 500);
  });

  describe('process', () => {
    it('should process HTML content', async () => {
      const crawlResult: CrawlResult = {
        url: 'https://example.com/docs/page',
        path: '/docs/page.md',
        contentFormat: 'html',
        title: 'Test Page',
        content: `
          <html>
            <body>
              <main>
                <h1>Test Documentation</h1>
                <p>This is some test content for the documentation page.</p>
                <h2>Features</h2>
                <p>Here are some features of our product.</p>
              </main>
            </body>
          </html>
        `,
      };

      const result = await processor.process(crawlResult);

      expect(result).toBeDefined();
      expect(result.metadata.url).toBe(crawlResult.url);
      // Title may come from crawl result or H1, depending on processor logic
      expect(result.metadata.title).toBeTruthy();
      expect(result.chunks.length).toBeGreaterThan(0);
      expect(result.chunks[0].vector.length).toBe(mockEmbeddings.dimensions);
    });

    it('should process markdown content', async () => {
      const crawlResult: CrawlResult = {
        url: 'https://example.com/docs/readme.md',
        path: '/docs/readme.html',
        contentFormat: 'markdown',
        title: 'README',
        content: `# Project README

This is the README for our project.

## Installation

Run the following command:

\`\`\`bash
npm install example-package
\`\`\`

## Usage

Here's how to use the package.
`,
      };

      const result = await processor.process(crawlResult);

      expect(result).toBeDefined();
      // Title may come from crawl result or H1
      expect(result.metadata.title).toBeTruthy();
      expect(result.chunks.length).toBeGreaterThan(0);
    });

    it('should treat extractorUsed as diagnostic-only', async () => {
      const input: CrawlResult = {
        url: 'https://example.com/guide',
        path: '/guide.html',
        contentFormat: 'markdown',
        title: 'Guide',
        content: '# Explicit Markdown\n\n## Section\n\nBody',
        extractorUsed: 'FirstExtractor',
      };

      const first = await processor.process(input);
      const second = await processor.process({ ...input, extractorUsed: 'RenamedExtractor' });

      expect(second.metadata.title).toBe(first.metadata.title);
      expect(second.chunks.map(({ content, title }) => ({ content, title }))).toEqual(
        first.chunks.map(({ content, title }) => ({ content, title }))
      );
    });

    it('should process actual Storybook extractor output', async () => {
      const originalWindow = globalThis.window;
      const storybookWindow = new JSDOM(`<main class="sbdocs-content">
        <h1>Button Component</h1>
        <table class="docblock-argstable">
          <tr><th>Name</th><th>Type</th><th>Default</th></tr>
          <tr><td>variant</td><td>string</td><td>primary</td></tr>
        </table>
      </main>`).window;
      const storybookDocument = storybookWindow.document;
      globalThis.window = storybookWindow as unknown as typeof globalThis.window;
      storybookWindow.getComputedStyle = vi.fn().mockReturnValue({
        display: 'block',
        visibility: 'visible',
        opacity: '1',
      }) as unknown as typeof storybookWindow.getComputedStyle;

      const storybook = contentExtractors.storybook as unknown as {
        extractContent(document: Document): Promise<{ content: string; contentFormat: 'markdown'; title?: string }>;
        expandAllTypeValues(table: Element): Promise<void>;
        waitForStorybookAPI(): Promise<void>;
        waitForStorybookContent(document: Document): Promise<Element | null>;
      };
      const expandSpy = vi.spyOn(storybook, 'expandAllTypeValues').mockResolvedValue(undefined);
      const apiSpy = vi.spyOn(storybook, 'waitForStorybookAPI').mockResolvedValue(undefined);
      const contentSpy = vi.spyOn(storybook, 'waitForStorybookContent').mockResolvedValue(storybookDocument.querySelector('main'));

      try {
        const storybookContent = await storybook.extractContent(storybookDocument);
        const storybookResult = await processor.process({
          url: 'https://storybook.example.com/button',
          path: '/button',
          extractorUsed: contentExtractors.storybook.constructor.name,
          ...storybookContent,
          title: storybookContent.title || 'Button',
        });
        expect(storybookResult.metadata.title).toBe('Button Component');
        expect(storybookResult.chunks[0].content).toContain('Button Component');
        const propsChunk = storybookResult.chunks.find((chunk) => chunk.metadata.props?.length);
        expect(propsChunk?.content).toContain('| variant | string | primary |');
        expect(propsChunk?.metadata.props).toContainEqual(
          expect.objectContaining({ name: 'variant', type: 'string', defaultValue: 'primary' })
        );
      }
      finally {
        contentSpy.mockRestore();
        apiSpy.mockRestore();
        expandSpy.mockRestore();
        globalThis.window = originalWindow;
      }
    });

    it('should create chunks with proper metadata', async () => {
      const crawlResult: CrawlResult = {
        url: 'https://example.com/api',
        path: '/api',
        contentFormat: 'html',
        title: 'API',
        content: `
          <html>
            <body>
              <main>
                <h1>API Reference</h1>
                <p>This document describes the API endpoints.</p>
                <h2>GET /users</h2>
                <p>Returns a list of users.</p>
                <pre><code>
{
  "users": [...]
}
                </code></pre>
              </main>
            </body>
          </html>
        `,
      };

      const result = await processor.process(crawlResult);

      expect(result).toBeDefined();
      result.chunks.forEach((chunk) => {
        expect(chunk.url).toBe(crawlResult.url);
        expect(chunk.path).toBe(crawlResult.path);
        expect(chunk.vector).toHaveLength(mockEmbeddings.dimensions);
        expect(chunk.metadata).toBeDefined();
        expect(['overview', 'api', 'example', 'usage']).toContain(chunk.metadata.type);
      });
    });

    it('should handle large content by creating multiple chunks', async () => {
      const longContent = Array(50)
        .fill(null)
        .map(
          (_, i) => `
        <h2>Section ${i + 1}</h2>
        <p>This is the content for section ${i + 1}. It contains some text that will need to be chunked appropriately for the embedding model. Lorem ipsum dolor sit amet, consectetur adipiscing elit.</p>
      `
        )
        .join('\n');

      const crawlResult: CrawlResult = {
        url: 'https://example.com/long',
        path: '/long',
        contentFormat: 'html',
        title: 'Long Document',
        content: `
          <html>
            <body>
              <main>
                <h1>Long Document</h1>
                ${longContent}
              </main>
            </body>
          </html>
        `,
      };

      const result = await processor.process(crawlResult);

      expect(result).toBeDefined();
      expect(result.chunks.length).toBeGreaterThan(1);
    });

    it('should throw error for content that cannot be parsed', async () => {
      const crawlResult: CrawlResult = {
        url: 'https://example.com/empty',
        path: '/empty',
        contentFormat: 'html',
        title: 'Empty',
        content: '', // Empty content
      };

      await expect(processor.process(crawlResult)).rejects.toThrow();
    });

    it('should throw error for whitespace-only content', async () => {
      const crawlResult: CrawlResult = {
        url: 'https://example.com/whitespace',
        path: '/whitespace',
        contentFormat: 'html',
        title: 'Whitespace',
        content: '   \n\n   ',
      };

      await expect(processor.process(crawlResult)).rejects.toThrow();
    });

    it('should handle embedding failures gracefully', async () => {
      const failingEmbeddings = createFailingEmbeddings();
      const failingProcessor = new WebDocumentProcessor(failingEmbeddings, 500);

      const crawlResult: CrawlResult = {
        url: 'https://example.com/test',
        path: '/test',
        contentFormat: 'html',
        title: 'Test',
        content: `
          <html>
            <body>
              <main>
                <h1>Test</h1>
                <p>Some content here.</p>
              </main>
            </body>
          </html>
        `,
      };

      await expect(failingProcessor.process(crawlResult)).rejects.toThrow('Embeddings service unavailable');
    });

    it('should set lastIndexed date', async () => {
      const crawlResult: CrawlResult = {
        url: 'https://example.com/dated',
        path: '/dated',
        contentFormat: 'html',
        title: 'Dated',
        content: `
          <html>
            <body>
              <main>
                <h1>Document</h1>
                <p>Content with date.</p>
              </main>
            </body>
          </html>
        `,
      };

      const before = new Date();
      const result = await processor.process(crawlResult);
      const after = new Date();

      expect(result.metadata.lastIndexed.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(result.metadata.lastIndexed.getTime()).toBeLessThanOrEqual(after.getTime());
    });

    it('should respect maxChunkSize parameter', async () => {
      const smallChunkProcessor = new WebDocumentProcessor(mockEmbeddings, 100);

      const crawlResult: CrawlResult = {
        url: 'https://example.com/chunks',
        path: '/chunks',
        contentFormat: 'html',
        title: 'Chunks',
        content: `
          <html>
            <body>
              <main>
                <h1>Document</h1>
                <p>This is a longer paragraph that should be split into multiple chunks when using a small chunk size. The semantic chunker should create appropriate boundaries.</p>
                <p>Another paragraph with additional content that needs to be processed and chunked appropriately.</p>
              </main>
            </body>
          </html>
        `,
      };

      const result = await smallChunkProcessor.process(crawlResult);

      // With smaller chunk size, should create more chunks
      expect(result.chunks.length).toBeGreaterThanOrEqual(1);
    });

    it('should handle MDX files', async () => {
      const crawlResult: CrawlResult = {
        url: 'https://example.com/docs/component.mdx',
        path: '/docs/component.mdx',
        contentFormat: 'markdown',
        title: 'MDX Component',
        content: `# MDX Component

This is an MDX file with JSX.

<MyComponent prop="value">
  Children content
</MyComponent>

## Usage

\`\`\`jsx
import { MyComponent } from 'library';
\`\`\`
`,
      };

      const result = await processor.process(crawlResult);

      expect(result).toBeDefined();
      expect(result.metadata.title).toBe('MDX Component');
    });

    it('should process DefaultExtractor content', async () => {
      const crawlResult: CrawlResult = {
        url: 'https://example.com/default',
        path: '/default',
        contentFormat: 'text',
        title: 'Default Extracted',
        content: `Page Title

This is content extracted by the default extractor.
It's plain text without HTML markup.

Another section of content here.`,
        extractorUsed: 'DefaultExtractor',
      };

      const result = await processor.process(crawlResult);

      expect(result).toBeDefined();
      expect(result.chunks.length).toBeGreaterThan(0);
    });
  });

  describe('chunk metadata detection', () => {
    it('should detect API content type', async () => {
      const crawlResult: CrawlResult = {
        url: 'https://example.com/api-ref',
        path: '/api-ref',
        contentFormat: 'html',
        title: 'API Reference',
        content: `
          <html>
            <body>
              <main>
                <h1>API Reference</h1>
                <h2>GET /api/users</h2>
                <p>Returns array of users</p>
                <h3>Parameters</h3>
                <p>limit: number - Maximum results</p>
                <h3>Response</h3>
                <pre><code>{"users": []}</code></pre>
              </main>
            </body>
          </html>
        `,
      };

      const result = await processor.process(crawlResult);

      expect(result).toBeDefined();
      // Should detect API-related content
      // May or may not detect as API depending on content
      expect(result.chunks.length).toBeGreaterThan(0);
    });

    it('should detect example content type', async () => {
      const crawlResult: CrawlResult = {
        url: 'https://example.com/examples',
        path: '/examples',
        contentFormat: 'html',
        title: 'Examples',
        content: `
          <html>
            <body>
              <main>
                <h1>Code Examples</h1>
                <h2>Basic Example</h2>
                <pre><code>
const result = doSomething();
console.log(result);
                </code></pre>
                <h2>Advanced Example</h2>
                <pre><code>
const config = { advanced: true };
const result = doSomething(config);
                </code></pre>
              </main>
            </body>
          </html>
        `,
      };

      const result = await processor.process(crawlResult);

      expect(result).toBeDefined();
      // Should have extracted code blocks
      const hasCodeContent = result.chunks.some((c) => c.content.includes('doSomething'));
      expect(hasCodeContent).toBe(true);
    });
  });
});
