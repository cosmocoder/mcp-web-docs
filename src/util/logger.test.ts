import { logger } from './logger.js';

describe('Logger', () => {
  describe('API surface', () => {
    it.each(['debug', 'info', 'warn', 'error'] as const)('should have %s method', (method) => {
      expect(typeof logger[method]).toBe('function');
    });
  });

  describe('methods do not throw', () => {
    it.each(['debug', 'info', 'warn', 'error'] as const)('should not throw when calling %s with string', (method) => {
      expect(() => logger[method]('Test message')).not.toThrow();
    });

    it('should not throw when calling with multiple arguments', () => {
      expect(() => logger.error('Multiple', 'arguments', 123, true)).not.toThrow();
    });

    it('should not throw when calling with Error object', () => {
      const error = new Error('Test error');
      expect(() => logger.error('Got error:', error)).not.toThrow();
    });

    it('should not throw when calling with nested object', () => {
      const obj = { nested: { deep: { value: true } } };
      expect(() => logger.info('Object:', obj)).not.toThrow();
    });

    it('should not throw when calling with circular reference', () => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      expect(() => logger.error('Circular:', circular)).not.toThrow();
    });

    it('should not throw when calling with null/undefined', () => {
      expect(() => logger.info('Values:', null, undefined)).not.toThrow();
    });

    it('should not throw when calling with empty string', () => {
      expect(() => logger.info('')).not.toThrow();
    });

    it('should not throw when calling with unicode', () => {
      expect(() => logger.info('Unicode: 你好世界 🌍')).not.toThrow();
    });

    it('should not throw when calling with special characters', () => {
      expect(() => logger.info('Special: <>&"\' \n\t')).not.toThrow();
    });

    it('should not throw when calling with very long message', () => {
      const longMessage = 'a'.repeat(10000);
      expect(() => logger.info(longMessage)).not.toThrow();
    });
  });
});