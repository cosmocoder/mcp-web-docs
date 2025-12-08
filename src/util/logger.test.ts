import { logger } from './logger.js';

describe('Logger', () => {
  describe('API surface', () => {
    it('should have debug method', () => {
      expect(typeof logger.debug).toBe('function');
    });

    it('should have info method', () => {
      expect(typeof logger.info).toBe('function');
    });

    it('should have warn method', () => {
      expect(typeof logger.warn).toBe('function');
    });

    it('should have error method', () => {
      expect(typeof logger.error).toBe('function');
    });
  });

  describe('methods do not throw', () => {
    it('should not throw when calling debug with string', () => {
      expect(() => logger.debug('Debug message')).not.toThrow();
    });

    it('should not throw when calling info with string', () => {
      expect(() => logger.info('Info message')).not.toThrow();
    });

    it('should not throw when calling warn with string', () => {
      expect(() => logger.warn('Warn message')).not.toThrow();
    });

    it('should not throw when calling error with string', () => {
      expect(() => logger.error('Error message')).not.toThrow();
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