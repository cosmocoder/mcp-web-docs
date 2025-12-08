import { generateDocId } from './docs.js';

describe('Docs Utilities', () => {
  describe('generateDocId', () => {
    it('should generate ID for GitHub Pages URLs', () => {
      const result = generateDocId('https://jimdo.github.io/ui/latest', 'UI Components');
      expect(result).toBe('jimdo-ui');
    });

    it('should generate ID for GitHub Pages with subdirectory', () => {
      const result = generateDocId('https://myorg.github.io/my-package/docs/guide', 'Guide');
      expect(result).toBe('myorg-my-package');
    });

    it('should generate ID for scoped package titles', () => {
      const result = generateDocId('https://example.com/docs', '@org/package-name');
      expect(result).toBe('-org-package-name');
    });

    it('should generate ID from hostname for regular URLs', () => {
      const result = generateDocId('https://docs.example.com/guide', 'Example Guide');
      // Includes first path part since it's not 'docs'
      expect(result).toBe('docs-guide');
    });

    it('should include path part for non-docs paths', () => {
      const result = generateDocId('https://example.com/react-components', 'Components');
      expect(result).toBe('example-react-components');
    });

    it('should exclude docs from path', () => {
      const result = generateDocId('https://example.com/docs/getting-started', 'Getting Started');
      expect(result).toBe('example');
    });

    it('should handle www prefix', () => {
      const result = generateDocId('https://www.example.com/api', 'API Reference');
      expect(result).toBe('example-api');
    });

    it('should handle simple hostname', () => {
      const result = generateDocId('https://localhost:3000/', 'Local Docs');
      // Port is not included in the hostname parsing
      expect(result).toBe('localhost');
    });

    it('should handle URLs with query parameters', () => {
      const result = generateDocId('https://docs.site.com/api?version=2', 'API v2');
      // Includes path part
      expect(result).toBe('docs-api');
    });

    it('should handle URLs with fragments', () => {
      const result = generateDocId('https://example.com/guide#section', 'Guide');
      expect(result).toBe('example-guide');
    });
  });
});
