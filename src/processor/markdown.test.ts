import { processMarkdownContent, processExtractedContent } from './markdown.js';
import type { CrawlResult } from '../types.js';

describe('Markdown Processor', () => {
  describe('processMarkdownContent', () => {
    it('should process simple markdown content', async () => {
      const page: CrawlResult = {
        url: 'https://example.com/docs/guide.md',
        path: '/docs/guide.md',
        title: 'Guide',
        content: `# Introduction

This is the introduction to our guide.

## Getting Started

Here's how to get started with our library.

## Installation

Run the following command:

\`\`\`bash
npm install our-library
\`\`\`
`,
      };

      const result = await processMarkdownContent(page);

      expect(result).toBeDefined();
      // Title comes from page title or front matter, not H1 necessarily
      expect(result?.article.title).toBeTruthy();
      expect(result?.article.url).toBe(page.url);
      expect(result?.article.path).toBe(page.path);
      expect(result?.article.components.length).toBeGreaterThan(0);
    });

    it('should extract front matter', async () => {
      const page: CrawlResult = {
        url: 'https://example.com/docs/page.md',
        path: '/docs/page.md',
        title: 'Page',
        content: `---
title: Custom Title
description: A custom description
---

# Heading

Content here.
`,
      };

      const result = await processMarkdownContent(page);

      expect(result).toBeDefined();
      expect(result?.article.title).toBe('Custom Title');
    });

    it('should preserve code blocks', async () => {
      const page: CrawlResult = {
        url: 'https://example.com/docs/code.md',
        path: '/docs/code.md',
        title: 'Code Examples',
        content: `# Code Examples

Here is some JavaScript code:

\`\`\`javascript
function hello() {
  console.log('Hello, world!');
}
\`\`\`

And here is Python:

\`\`\`python
def hello():
    print("Hello, world!")
\`\`\`
`,
      };

      const result = await processMarkdownContent(page);

      expect(result).toBeDefined();
      expect(result?.content).toContain('```javascript');
      expect(result?.content).toContain('console.log');
      expect(result?.content).toContain('```python');
    });

    it('should handle markdown without headers', async () => {
      const page: CrawlResult = {
        url: 'https://example.com/docs/simple.md',
        path: '/docs/simple.md',
        title: 'Simple Page',
        content: `This is just a simple paragraph.

Another paragraph here.

And a final one.
`,
      };

      const result = await processMarkdownContent(page);

      expect(result).toBeDefined();
      expect(result?.article.components.length).toBeGreaterThan(0);
    });

    it('should return undefined for empty content', async () => {
      const page: CrawlResult = {
        url: 'https://example.com/docs/empty.md',
        path: '/docs/empty.md',
        title: 'Empty',
        content: '',
      };

      const result = await processMarkdownContent(page);
      expect(result).toBeUndefined();
    });

    it('should handle whitespace-only content', async () => {
      const page: CrawlResult = {
        url: 'https://example.com/docs/whitespace.md',
        path: '/docs/whitespace.md',
        title: 'Whitespace',
        content: '   \n\n   \n   ',
      };

      const result = await processMarkdownContent(page);
      expect(result).toBeUndefined();
    });

    it('should handle nested headers', async () => {
      const page: CrawlResult = {
        url: 'https://example.com/docs/nested.md',
        path: '/docs/nested.md',
        title: 'Nested',
        content: `# Top Level

Introduction text.

## Second Level

Section content.

### Third Level

Subsection content.

#### Fourth Level

Deep content.
`,
      };

      const result = await processMarkdownContent(page);

      expect(result).toBeDefined();
      expect(result?.article.components.length).toBeGreaterThanOrEqual(4);
    });

    it('should detect Docusaurus-style headers with unicode markers', async () => {
      const page: CrawlResult = {
        url: 'https://example.com/docs/docusaurus.md',
        path: '/docs/docusaurus.md',
        title: 'Docusaurus Page',
        content: `# Main Title

Introduction paragraph.

Hooks\u200B

This section covers hooks.

Example\u200B

Here is an example.
`,
      };

      const result = await processMarkdownContent(page);

      expect(result).toBeDefined();
      expect(result?.article.components.length).toBeGreaterThan(1);
    });

    it('should handle special characters in content', async () => {
      const page: CrawlResult = {
        url: 'https://example.com/docs/special.md',
        path: '/docs/special.md',
        title: 'Special Characters',
        content: `# Special Characters

Here are some special characters: < > & " ' \` * _ [] () {}

## Math Symbols

α β γ δ ε × ÷ ± ≠ ≤ ≥

## Emojis

🚀 📚 💡 ✅ ❌
`,
      };

      const result = await processMarkdownContent(page);

      expect(result).toBeDefined();
      expect(result?.content).toContain('<');
      expect(result?.content).toContain('α');
      expect(result?.content).toContain('🚀');
    });
  });

  describe('processExtractedContent', () => {
    it('should process pre-extracted content', async () => {
      const page: CrawlResult = {
        url: 'https://example.com/component',
        path: '/component',
        title: 'Button Component',
        content: `# Button

A versatile button component.

## Props

| Prop | Type | Default |
|------|------|---------|
| variant | string | 'primary' |
| disabled | boolean | false |

## Example

\`\`\`jsx
<Button variant="secondary">Click me</Button>
\`\`\`
`,
        extractorUsed: 'StorybookExtractor',
      };

      const result = await processExtractedContent(page);

      expect(result).toBeDefined();
      expect(result?.article.title).toBe('Button');
      expect(result?.article.components.length).toBeGreaterThan(0);
    });

    it('should handle content without sections', async () => {
      const page: CrawlResult = {
        url: 'https://example.com/simple',
        path: '/simple',
        title: 'Simple Page',
        content: `Just some plain text content without any headers or structure.

This is another paragraph.`,
        extractorUsed: 'DefaultExtractor',
      };

      const result = await processExtractedContent(page);

      expect(result).toBeDefined();
      expect(result?.article.components.length).toBe(1);
      expect(result?.content).toContain('Just some plain text');
    });

    it('should return undefined for empty extracted content', async () => {
      const page: CrawlResult = {
        url: 'https://example.com/empty',
        path: '/empty',
        title: 'Empty',
        content: '',
        extractorUsed: 'StorybookExtractor',
      };

      const result = await processExtractedContent(page);
      expect(result).toBeUndefined();
    });

    it('should preserve markdown formatting in extracted content', async () => {
      const page: CrawlResult = {
        url: 'https://example.com/formatted',
        path: '/formatted',
        title: 'Formatted',
        content: `# Formatted Content

Here is **bold** and *italic* text.

- List item 1
- List item 2
- List item 3

> A blockquote here

And some \`inline code\` too.
`,
        extractorUsed: 'GithubPagesExtractor',
      };

      const result = await processExtractedContent(page);

      expect(result).toBeDefined();
      expect(result?.content).toContain('**bold**');
      expect(result?.content).toContain('*italic*');
      expect(result?.content).toContain('- List item');
    });

    it('should use page title when no H1 found', async () => {
      const page: CrawlResult = {
        url: 'https://example.com/notitle',
        path: '/notitle',
        title: 'Page Title from Crawl',
        content: `## Only H2 Headers

Some content here.

## Another Section

More content.
`,
        extractorUsed: 'StorybookExtractor',
      };

      const result = await processExtractedContent(page);

      expect(result).toBeDefined();
      expect(result?.article.title).toBe('Page Title from Crawl');
    });

    it('should handle very long content', async () => {
      const longContent = `# Long Document

${Array(100)
  .fill(null)
  .map((_, i) => `## Section ${i + 1}\n\nThis is the content for section ${i + 1}. Lorem ipsum dolor sit amet.`)
  .join('\n\n')}
`;

      const page: CrawlResult = {
        url: 'https://example.com/long',
        path: '/long',
        title: 'Long Document',
        content: longContent,
        extractorUsed: 'DefaultExtractor',
      };

      const result = await processExtractedContent(page);

      expect(result).toBeDefined();
      expect(result?.article.components.length).toBeGreaterThan(50);
    });
  });
});
