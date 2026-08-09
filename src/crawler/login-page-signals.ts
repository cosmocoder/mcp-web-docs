import { createHash } from 'node:crypto';

/** Read in the page, so it must not reference anything outside itself. */
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

/** A login shell is nothing but a frame or a button; a docs page carrying a sign-in box has an article */
export const LOGIN_SHELL_MAX_TEXT = 200;

/** Three of the detector's six indicators. Stricter than its own two, which it never applies here. */
export const LOGIN_PAGE_CONFIDENCE = 0.5;

/**
 * What tells this page apart from the next one, or null when nothing does. A theme rendering its
 * headings as styled divs would otherwise make every page of the site one page.
 *
 * The page's own address comes out first, because a login page names where it is sending you back
 * to. Only its own: removing anything else would fold pages differing by exactly that. Accepted
 * cost: `POST /api/login` at /api/login and `POST /api/logout` at /api/logout fold into one.
 */
export function pageIdentity(headings: string[], text: string, currentUrl: string): string | null {
  const { pathname } = new URL(currentUrl);
  const identifying = headings.map((heading) => heading.replaceAll(currentUrl, '').replaceAll(pathname, '').trim()).filter(Boolean);
  if (identifying.length > 0) {
    return createHash('sha1').update(JSON.stringify(identifying)).digest('hex');
  }
  // A page that is barely anything is still recognisable as that; one with an article and no
  // headings could be any page.
  return text.length < LOGIN_SHELL_MAX_TEXT ? 'shell' : null;
}
