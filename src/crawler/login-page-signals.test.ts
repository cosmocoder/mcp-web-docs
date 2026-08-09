// @vitest-environment jsdom
import { LOGIN_SHELL_MAX_TEXT, pageIdentity, readLoginPageSignals } from './login-page-signals.js';

function render(html: string) {
  document.body.innerHTML = html;
  return readLoginPageSignals();
}

const LOGIN_FORM = `
  <h1>Sign in</h1>
  <form action="/login?next=%2Fdocs%2F42">
    <input name="username" type="text">
    <input name="password" type="password">
  </form>`;

describe('readLoginPageSignals', () => {
  it('reads the text, the password input and the page shape', () => {
    expect(render(LOGIN_FORM)).toEqual({
      text: 'Sign in',
      hasPasswordInput: true,
      headings: ['Sign in'],
      frameSources: [],
    });
  });

  it('is the same for one login page answering different URLs', () => {
    const first = render(`${LOGIN_FORM}<p>Continue to /docs/1. Attempt 1 of 5.</p>`);
    const second = render(`${LOGIN_FORM.replace('%2Fdocs%2F42', '%2Fdocs%2F7')}<p>Continue to /docs/7. Attempt 2 of 5.</p>`);

    expect(first.text).not.toEqual(second.text);
    expect({ ...first, text: '' }).toEqual({ ...second, text: '' });
  });

  it('differs between documentation pages built from one template', () => {
    const shapes = ['login', 'logout', 'refresh'].map(
      (endpoint) => render(`<h1>POST /api/${endpoint}</h1><p>Sign in with your username and password.</p>`).headings
    );

    expect(new Set(shapes.map((headings) => headings.join())).size).toBe(3);
  });

  it('reports an empty shape and no password input for an ordinary page', () => {
    expect(render('<p>Ordinary content</p>')).toEqual({
      text: 'Ordinary content',
      hasPasswordInput: false,
      headings: [],
      frameSources: [],
    });
  });

  it('reports the frames a page embeds, and only those with a source', () => {
    expect(render('<iframe src="/sso/login"></iframe><iframe></iframe>').frameSources).toEqual(['/sso/login']);
  });

  it('collapses whitespace and caps the headings it reports', () => {
    const signals = render(`<h1>  Sign\n  in  </h1>${[1, 2, 3, 4, 5, 6].map((n) => `<h2>Section ${n}</h2>`).join('')}`);

    expect(signals.headings).toEqual(['Sign in', 'Section 1', 'Section 2', 'Section 3', 'Section 4']);
  });
});

describe('pageIdentity', () => {
  const url = 'https://example.com/docs/42';
  const article = 'x'.repeat(LOGIN_SHELL_MAX_TEXT);

  // A theme that renders its headings as styled divs leaves nothing to go on, and a page the crawl
  // cannot tell apart must not be counted as the same page coming back
  it('has no answer for a page with an article on it and no headings', () => {
    expect(pageIdentity([], article, url)).toBeNull();
    expect(pageIdentity(['   '], article, url)).toBeNull();
  });

  // A page that is barely anything is still recognisable as that
  it('recognises a bare page with no headings', () => {
    expect(pageIdentity([], 'Continue with SSO', url)).toEqual(pageIdentity([], 'Continue', 'https://example.com/docs/7'));
    expect(pageIdentity([], 'Continue', url)).not.toBeNull();
  });

  // A login shell is not always wordless - it explains why you are looking at it
  it('still recognises a bare page that explains itself', () => {
    expect(pageIdentity([], 'Your session has expired. Please sign in again to continue.', url)).not.toBeNull();
    expect(pageIdentity([], 'x'.repeat(LOGIN_SHELL_MAX_TEXT - 1), url)).not.toBeNull();
    expect(pageIdentity([], 'x'.repeat(LOGIN_SHELL_MAX_TEXT), url)).toBeNull();
  });

  // A login page names where it is sending you back to, so that part is not what the page is
  it('is the same for one login page naming different URLs', () => {
    expect(pageIdentity(['Sign in to continue to /docs/42'], article, url)).toEqual(
      pageIdentity(['Sign in to continue to /docs/7'], article, 'https://example.com/docs/7')
    );
  });

  it('differs between pages that are actually about different things', () => {
    expect(pageIdentity(['Installing'], article, url)).not.toEqual(pageIdentity(['Configuring'], article, url));
  });

  // Only the page's own address comes out - a heading that IS an address elsewhere still counts
  it('keeps an address that is not this page', () => {
    expect(pageIdentity(['POST /api/login'], article, url)).not.toEqual(pageIdentity(['POST /api/logout'], article, url));
  });
});
