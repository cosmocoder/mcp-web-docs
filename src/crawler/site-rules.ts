import { Page } from 'playwright';
import { logger } from '../util/logger.js';
import { ContentExtractor } from './content-extractor-types.js';
import { StorybookExtractor } from './storybook-extractor.js';
import { GitHubPagesExtractor } from './github-pages-extractor.js';
import { DefaultExtractor } from './default-extractor.js';

export interface SiteDetectionRule {
  type: string;
  extractor: ContentExtractor;
  detect: (page: Page) => Promise<boolean>;
  prepare?: (page: Page) => Promise<void>;
  linkSelectors?: string[];
}

export const siteRules: SiteDetectionRule[] = [
  {
    type: 'storybook',
    extractor: new StorybookExtractor(),
    detect: async (page) => {
      return page.evaluate(() => {
        return !!(
          document.querySelector('#storybook-root, .sbdocs, [data-nodetype="root"]') ||
          document.querySelector('meta[name="storybook-version"]') ||
          document.baseURI?.includes('path=/docs/') ||
          document.baseURI?.includes('path=/story/') ||
          (window as unknown as { __STORYBOOK_CLIENT_API__?: unknown }).__STORYBOOK_CLIENT_API__
        );
      });
    },
    prepare: async (page) => {
      // Only the sidebar is prepared here, and only to feed link discovery. The docs
      // content belongs to the extractor, which runs inside the preview iframe and
      // polls for its own. Waiting for the sidebar is the real precondition, so there
      // is no networkidle wait: Storybook keeps chattering long after the tree is up.
      await page.waitForSelector('[class*="sidebar"]', { timeout: 5000 }).catch(() => logger.debug('[SiteRules] No sidebar found'));

      // A show/hide toggle, so it gets clicked exactly once - clicking it again re-hides
      // the sections and the link count oscillates.
      await page.evaluate(() => {
        document.querySelectorAll<HTMLButtonElement>('button.sidebar-subheading-action').forEach((button) => button.click());
      });

      // Expanding a root reveals nested groups that reveal more, and a group carries no
      // link of its own - so settle on nothing being left collapsed rather than on the
      // link count, which stalls on a group whose children are all groups.
      // Buttons only: div.search-field keeps aria-expanded="false" forever.
      for (let pass = 0; pass < 8; pass++) {
        const collapsed = await page.evaluate(() => {
          const buttons = document.querySelectorAll<HTMLButtonElement>('button[aria-expanded="false"]');
          buttons.forEach((button) => button.click());
          return buttons.length;
        });

        if (collapsed === 0) {
          break;
        }
        await page.waitForTimeout(100);
      }
    },
    linkSelectors: [
      '.sidebar-item a',
      '[data-nodetype="root"] a',
      '[data-nodetype="group"] a',
      '[data-nodetype="document"] a',
      '[data-nodetype="story"] a',
      '[data-item-id] a',
    ],
  },
  {
    type: 'github',
    extractor: new GitHubPagesExtractor(),
    detect: async (page) => {
      return page.evaluate(() => {
        return (
          (window.location.hostname === 'github.io' || window.location.hostname.endsWith('.github.io')) &&
          document.querySelector('.markdown-body, .site-footer, .page-header') !== null
        );
      });
    },
  },
  {
    type: 'default',
    extractor: new DefaultExtractor(),
    detect: async () => true,
  },
];
