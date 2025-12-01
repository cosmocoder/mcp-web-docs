import { Log } from 'crawlee';
import { Page } from 'playwright';
import { ContentExtractor } from './content-extractor-types.js';
import { contentExtractors } from './content-extractors.js';

export interface SiteDetectionRule {
  type: string;
  extractor: ContentExtractor;
  detect: (page: Page) => Promise<boolean>;
  prepare?: (page: Page, log: Log) => Promise<void>;
  linkSelectors?: string[];
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

      // Wait for sidebar to be ready
      await page.waitForSelector('[class*="sidebar"]', { timeout: 5000 })
        .catch(() => log.debug('No sidebar found'));

      // First expand all section buttons
      await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button.sidebar-subheading-action'));
        buttons.forEach(button => (button as HTMLButtonElement).click());
      });

      // Wait for any new content to appear
      await page.waitForTimeout(500);

      // Then expand any remaining collapsed sections
      await page.evaluate(() => {
        const expandButtons = Array.from(document.querySelectorAll('[aria-expanded="false"]'));
        expandButtons.forEach(button => (button as HTMLButtonElement).click());
      });

      // Wait for all animations and content updates to complete
      await page.waitForTimeout(1000);

      // Log the number of links found for debugging
      const linkCount = await page.evaluate(() => {
        return document.querySelectorAll('.sidebar-item a, [data-nodetype="story"] a, [data-nodetype="document"] a').length;
      });
      log.debug(`Found ${linkCount} sidebar links after expansion`);
    },
    linkSelectors: [
      '.sidebar-item a',
      '[data-nodetype="root"] a',
      '[data-nodetype="group"] a',
      '[data-nodetype="document"] a',
      '[data-nodetype="story"] a',
      '[data-item-id] a'
    ]
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
