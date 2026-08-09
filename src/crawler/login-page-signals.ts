import { createHash } from 'node:crypto';

/**
 * Read in the page, so it must not reference anything outside itself.
 */
export function readLoginPageSignals(): {
  text: string;
  hasPasswordInput: boolean;
  headings: string[];
  frameSources: string[];
} {
  const collapse = (value: string) => value.replace(/\s+/g, ' ').trim();
  return {
    text: collapse(document.body?.textContent || ''),
    hasPasswordInput: document.querySelector('input[type="password"]') !== null,
    headings: [...document.querySelectorAll('h1, h2')].slice(0, 5).map((heading) => collapse(heading.textContent || '')),
    frameSources: [...document.querySelectorAll('iframe')].map((frame) => frame.getAttribute('src') || '').filter(Boolean),
  };
}

/**
 * A page that is nothing but a frame or a button is a login shell; a documentation page carrying a
 * sign-in box has an article around it.
 */
export const LOGIN_SHELL_MAX_TEXT = 200;

/**
 * What tells this page apart from the next one, or null when nothing does. A page the crawl cannot
 * tell apart must not be counted as the same page coming back: a documentation theme that renders
 * its headings as styled divs would otherwise make every page of the site one login page.
 *
 * The page's own address comes out first, because a login page often names where it is sending you
 * back to. Only its own: removing anything else would fold pages that differ by exactly that.
 * A documentation theme that renders its headings as styled divs would otherwise make every page of
 * the site one login page.
 */
export function pageIdentity(headings: string[], text: string, currentUrl: string): string | null {
  const addresses = new Set([currentUrl, new URL(currentUrl).pathname]);
  const identifying = headings
    .map((heading) => [...addresses].reduce((stripped, address) => stripped.split(address).join(''), heading).trim())
    .filter(Boolean);
  if (identifying.length > 0) {
    return createHash('sha1').update(JSON.stringify(identifying)).digest('hex');
  }
  // Nothing to go on. A page that is barely anything is still recognisable as that - a login shell
  // is a login shell - but a page with an article on it and no headings could be any page.
  return text.length < LOGIN_SHELL_MAX_TEXT ? 'shell' : null;
}
