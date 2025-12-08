import type { Page } from 'playwright';
import type { Log } from 'crawlee';
import { siteRules } from './site-rules.js';

describe('Site Rules', () => {
  const createMockPage = (evaluateResult: unknown = false): Page => {
    return {
      evaluate: vi.fn().mockResolvedValue(evaluateResult),
      waitForLoadState: vi.fn().mockResolvedValue(undefined),
      waitForSelector: vi.fn().mockResolvedValue(undefined),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
    } as unknown as Page;
  };

  const mockLog: Log = {
    info: vi.fn(),
    debug: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  } as unknown as Log;

  describe('storybook rule', () => {
    const storybookRule = siteRules.find((r) => r.type === 'storybook')!;

    it('should detect storybook by #storybook-root element', async () => {
      const page = createMockPage(true);

      const result = await storybookRule.detect(page);

      expect(result).toBe(true);
      expect(page.evaluate).toHaveBeenCalled();
    });

    it('should not detect when no storybook elements found', async () => {
      const page = createMockPage(false);

      const result = await storybookRule.detect(page);

      expect(result).toBe(false);
    });

    it('should have prepare function for storybook', () => {
      expect(storybookRule.prepare).toBeDefined();
    });

    it('should have link selectors for storybook', () => {
      expect(storybookRule.linkSelectors).toBeDefined();
      expect(storybookRule.linkSelectors).toContain('.sidebar-item a');
      expect(storybookRule.linkSelectors).toContain('[data-nodetype="story"] a');
    });

    it('should expand sidebar sections in prepare', async () => {
      const page = {
        evaluate: vi.fn().mockResolvedValue(5),
        waitForLoadState: vi.fn().mockResolvedValue(undefined),
        waitForSelector: vi.fn().mockResolvedValue(undefined),
        waitForTimeout: vi.fn().mockResolvedValue(undefined),
      } as unknown as Page;

      await storybookRule.prepare?.(page, mockLog);

      expect(page.waitForLoadState).toHaveBeenCalledWith('networkidle', { timeout: 5000 });
      expect(page.evaluate).toHaveBeenCalled();
    });

    it('should handle timeout errors gracefully in prepare', async () => {
      const page = {
        evaluate: vi.fn().mockResolvedValue(0),
        waitForLoadState: vi.fn().mockRejectedValue(new Error('Timeout')),
        waitForSelector: vi.fn().mockRejectedValue(new Error('Timeout')),
        waitForTimeout: vi.fn().mockResolvedValue(undefined),
      } as unknown as Page;

      // Should not throw
      await expect(storybookRule.prepare?.(page, mockLog)).resolves.toBeUndefined();
    });

    it('should use StorybookExtractor', () => {
      expect(storybookRule.extractor.constructor.name).toBe('StorybookExtractor');
    });
  });

  describe('github rule', () => {
    const githubRule = siteRules.find((r) => r.type === 'github')!;

    it('should detect GitHub Pages sites', async () => {
      const page = createMockPage(true);

      const result = await githubRule.detect(page);

      expect(result).toBe(true);
    });

    it('should not detect non-GitHub sites', async () => {
      const page = createMockPage(false);

      const result = await githubRule.detect(page);

      expect(result).toBe(false);
    });

    it('should use GitHubPagesExtractor', () => {
      expect(githubRule.extractor.constructor.name).toBe('GitHubPagesExtractor');
    });

    it('should not have prepare function', () => {
      expect(githubRule.prepare).toBeUndefined();
    });

    it('should not have link selectors', () => {
      expect(githubRule.linkSelectors).toBeUndefined();
    });
  });

  describe('default rule', () => {
    const defaultRule = siteRules.find((r) => r.type === 'default')!;

    it('should always detect (fallback)', async () => {
      const page = createMockPage(false);

      const result = await defaultRule.detect(page);

      expect(result).toBe(true);
    });

    it('should use DefaultExtractor', () => {
      expect(defaultRule.extractor.constructor.name).toBe('DefaultExtractor');
    });

    it('should not have prepare function', () => {
      expect(defaultRule.prepare).toBeUndefined();
    });

    it('should not have link selectors', () => {
      expect(defaultRule.linkSelectors).toBeUndefined();
    });
  });

  describe('rule ordering', () => {
    it('should have storybook rule before default', () => {
      const storybookIndex = siteRules.findIndex((r) => r.type === 'storybook');
      const defaultIndex = siteRules.findIndex((r) => r.type === 'default');

      expect(storybookIndex).toBeLessThan(defaultIndex);
    });

    it('should have github rule before default', () => {
      const githubIndex = siteRules.findIndex((r) => r.type === 'github');
      const defaultIndex = siteRules.findIndex((r) => r.type === 'default');

      expect(githubIndex).toBeLessThan(defaultIndex);
    });

    it('should have default rule last', () => {
      const defaultIndex = siteRules.findIndex((r) => r.type === 'default');

      expect(defaultIndex).toBe(siteRules.length - 1);
    });
  });

  describe('all rules', () => {
    it('should have extractors for all rules', () => {
      for (const rule of siteRules) {
        expect(rule.extractor).toBeDefined();
        expect(rule.extractor.extractContent).toBeDefined();
      }
    });

    it('should have detect functions for all rules', () => {
      for (const rule of siteRules) {
        expect(rule.detect).toBeDefined();
        expect(typeof rule.detect).toBe('function');
      }
    });

    it('should have type strings for all rules', () => {
      for (const rule of siteRules) {
        expect(rule.type).toBeDefined();
        expect(typeof rule.type).toBe('string');
      }
    });
  });
});
