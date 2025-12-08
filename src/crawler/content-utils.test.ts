import { cleanContent, cleanCodeBlock } from './content-utils.js';

describe('Content Utilities', () => {
  describe('cleanContent', () => {
    it('should convert escaped newlines to actual newlines', () => {
      const input = 'Line 1\\nLine 2\\nLine 3';
      const result = cleanContent(input);
      expect(result).toBe('Line 1\nLine 2\nLine 3');
    });

    it('should normalize Windows line endings', () => {
      const input = 'Line 1\r\nLine 2\r\nLine 3';
      const result = cleanContent(input);
      expect(result).toBe('Line 1\nLine 2\nLine 3');
    });

    it('should convert tabs to spaces', () => {
      const input = 'Line 1\tindented';
      const result = cleanContent(input);
      // Tabs are converted to 2 spaces, then multiple spaces become single space
      expect(result).toBe('Line 1 indented');
    });

    it('should replace multiple spaces with single space', () => {
      const input = 'Too    many     spaces';
      const result = cleanContent(input);
      expect(result).toBe('Too many spaces');
    });

    it('should trim trailing whitespace from each line', () => {
      const input = 'Line 1   \nLine 2   ';
      const result = cleanContent(input);
      expect(result).toBe('Line 1\nLine 2');
    });

    it('should preserve leading indentation', () => {
      const input = '  indented line\n    more indented';
      const result = cleanContent(input);
      expect(result).toBe('indented line\n more indented');
    });

    it('should reduce more than 2 consecutive newlines to 2', () => {
      const input = 'Para 1\n\n\n\n\nPara 2';
      const result = cleanContent(input);
      expect(result).toBe('Para 1\n\nPara 2');
    });

    it('should trim leading and trailing whitespace', () => {
      const input = '   \n\nContent here\n\n   ';
      const result = cleanContent(input);
      expect(result).toBe('Content here');
    });

    it('should handle empty string', () => {
      expect(cleanContent('')).toBe('');
    });

    it('should handle string with only whitespace', () => {
      expect(cleanContent('   \n\n   ')).toBe('');
    });

    it('should handle complex mixed content', () => {
      const input = '  Title   \r\n\r\n\r\n\r\n  Content with   multiple   spaces  \n\tTabbed';
      const result = cleanContent(input);
      // Leading spaces preserved as single space, tabs converted to spaces then collapsed
      expect(result).toBe('Title\n\n Content with multiple spaces\n Tabbed');
    });
  });

  describe('cleanCodeBlock', () => {
    it('should trim leading and trailing whitespace', () => {
      const input = '   \nconst x = 1;\n   ';
      const result = cleanCodeBlock(input);
      expect(result).toBe('const x = 1;');
    });

    it('should convert tabs to spaces', () => {
      const input = 'function test() {\n\treturn true;\n}';
      const result = cleanCodeBlock(input);
      expect(result).toBe('function test() {\n  return true;\n}');
    });

    it('should reduce multiple blank lines', () => {
      const input = 'line 1\n\n\n\nline 2';
      const result = cleanCodeBlock(input);
      expect(result).toBe('line 1\n\nline 2');
    });

    it('should replace non-breaking spaces with regular spaces', () => {
      const input = 'const\u00A0x\u00A0=\u00A01;';
      const result = cleanCodeBlock(input);
      expect(result).toBe('const x = 1;');
    });

    it('should handle empty string', () => {
      expect(cleanCodeBlock('')).toBe('');
    });

    it('should handle code with multiple formatting issues', () => {
      const input = '\n\t\tconst x\u00A0= 1;\n\n\n\n\treturn x;\n';
      const result = cleanCodeBlock(input);
      expect(result).toBe('const x = 1;\n\n  return x;');
    });

    it('should preserve single blank lines', () => {
      const input = 'line 1\n\nline 2';
      const result = cleanCodeBlock(input);
      expect(result).toBe('line 1\n\nline 2');
    });

    it('should handle code with mixed indentation', () => {
      const input = 'function test() {\n\tif (true) {\n\t\treturn;\n\t}\n}';
      const result = cleanCodeBlock(input);
      expect(result).toBe('function test() {\n  if (true) {\n    return;\n  }\n}');
    });
  });
});
