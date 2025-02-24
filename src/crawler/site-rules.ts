import { Log } from 'crawlee';
import { Page } from 'playwright';
import { ContentExtractor } from './content-extractor-types.js';
import { contentExtractors } from './content-extractors.js';

export interface SiteDetectionRule {
  type: string;
  extractor: ContentExtractor;
  detect: (page: Page) => Promise<boolean>;
  prepare?: (page: Page, log: Log) => Promise<void>;
}

export const siteRules: SiteDetectionRule[] = [
  {
    type: 'storybook',
    extractor: contentExtractors.storybook,
    detect: async (page) => {
      return page.evaluate(() => {
        return !!(document.querySelector('#storybook-root, .sbdocs, [data-nodetype="root"]') ||
                 document.querySelector('meta[name="storybook-version"]') ||
                 document.baseURI?.includes('path=/docs/') ||
                 document.baseURI?.includes('path=/story/') ||
                 (window as any).__STORYBOOK_CLIENT_API__);
      });
    },
    prepare: async (page, log) => {
      await Promise.all([
        page.waitForLoadState('networkidle', { timeout: 5000 })
          .catch(() => log.debug('Network idle timeout - continuing anyway')),
        page.waitForSelector('.sbdocs-content, #docs-root, .docs-story, [class*="story-"]', {
          timeout: 5000
        }).catch(() => log.debug('No Storybook content found in main page'))
      ]);
    }
  },
  {
    type: 'github',
    extractor: contentExtractors.github,
    detect: async (page) => {
      return page.evaluate(() => {
        return window.location.hostname.includes('github.io') &&
               document.querySelector('.markdown-body, .site-footer, .page-header') !== null;
      });
    }
  },
  {
    type: 'default',
    extractor: contentExtractors.default,
    detect: async () => true
  }
];
