import { Log } from 'crawlee';
import { Page } from 'playwright';
import { ContentExtractor } from './content-extractor-types.js';
import { StorybookExtractor } from './storybook-extractor.js';
import { GitHubPagesExtractor } from './github-pages-extractor.js';
import { DefaultExtractor } from './default-extractor.js';

export interface SiteDetectionRule {
  type: string;
  extractor: ContentExtractor;
  detect: (page: Page) => Promise<boolean>;
  prepare?: (page: Page, log: Log) => Promise<void>;
  linkSelectors?: string[];
}

/** Sidebar anchors Storybook uses for stories and docs pages, across versions. */
const STORYBOOK_LINK_SELECTORS = [
  '.sidebar-item a',
  '[data-nodetype="root"] a',
  '[data-nodetype="group"] a',
  '[data-nodetype="document"] a',
  '[data-nodetype="story"] a',
  '[data-item-id] a',
];

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
    prepare: async (page, log) => {
      // No wait for the docs content here: modern Storybook renders it inside an
      // iframe (handled by findContentFrame), and StorybookExtractor polls for it
      // itself in whichever document it ends up running against.
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => log.debug('Network idle timeout - continuing anyway'));

      // Wait for sidebar to be ready
      await page.waitForSelector('[class*="sidebar"]', { timeout: 5000 }).catch(() => log.debug('No sidebar found'));

      // A show/hide toggle, so it gets clicked exactly once - clicking it again re-hides
      // the sections and the link count oscillates.
      await page.evaluate(() => {
        document.querySelectorAll<HTMLButtonElement>('button.sidebar-subheading-action').forEach((button) => button.click());
      });

      // Expanding one section can reveal more collapsed ones, and expanding is idempotent
      // (a node stops matching once it is open), so repeat until no new links turn up.
      // Nothing here touches the docs content: the extractor runs inside the preview
      // iframe and does its own expanding there.
      const selector = STORYBOOK_LINK_SELECTORS.join(', ');
      let linkCount = -1;

      for (let pass = 0; pass < 8; pass++) {
        const found = await page.evaluate((linkSelector) => {
          document.querySelectorAll<HTMLButtonElement>('[aria-expanded="false"]').forEach((button) => button.click());
          return document.querySelectorAll(linkSelector).length;
        }, selector);

        if (found === linkCount) {
          break;
        }
        linkCount = found;
        await page.waitForTimeout(100);
      }

      log.debug(`Found ${linkCount} sidebar links after expansion`);
    },
    linkSelectors: STORYBOOK_LINK_SELECTORS,
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
