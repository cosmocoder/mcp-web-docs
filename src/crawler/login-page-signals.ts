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
 * A wall asks for a password and has nothing else on it, which is enough to act on a single page:
 * documentation about signing in carries the same wording and the same form, but has an article
 * around them. The heading does not separate the two - a wall has one of those as well.
 */
export function isLoginWall(signals: { hasPasswordInput: boolean; text: string }): boolean {
  return signals.hasPasswordInput && signals.text.length < LOGIN_SHELL_MAX_TEXT;
}
