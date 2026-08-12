// @vitest-environment jsdom
import { isLoginWall, LOGIN_SHELL_MAX_TEXT, readLoginPageSignals } from './login-page-signals.js';

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

  // Rebuilding it from its own source is the only way a reference to anything outside it shows up
  // here rather than in the browser page.evaluate sends it to
  it('reads nothing from outside itself, as page.evaluate requires', () => {
    document.body.innerHTML = LOGIN_FORM;
    const detached = new Function(`return (${readLoginPageSignals.toString()})()`) as () => ReturnType<typeof readLoginPageSignals>;

    expect(detached()).toEqual(readLoginPageSignals());
  });

  it('collapses whitespace and caps the headings it reports', () => {
    const signals = render(`<h1>  Sign\n  in  </h1>${[1, 2, 3, 4, 5, 6].map((n) => `<h2>Section ${n}</h2>`).join('')}`);

    expect(signals.headings).toEqual(['Sign in', 'Section 1', 'Section 2', 'Section 3', 'Section 4']);
  });
});

describe('isLoginWall', () => {
  const article = 'x'.repeat(LOGIN_SHELL_MAX_TEXT);

  it('is a wall when a password is asked for and there is nothing else on the page', () => {
    expect(isLoginWall({ hasPasswordInput: true, text: 'Sign in' })).toBe(true);
  });

  // What separates a wall from documentation about signing in, since both carry the form and the
  // wording. Not the heading: a wall has one of those too.
  it('is not a wall once there is an article around the form', () => {
    expect(isLoginWall({ hasPasswordInput: true, text: article })).toBe(false);
    expect(isLoginWall({ hasPasswordInput: true, text: 'x'.repeat(LOGIN_SHELL_MAX_TEXT - 1) })).toBe(true);
  });

  // A bare page that asks for nothing is some other kind of bare page - an interstitial, a redirect
  // stub - and the crawl has no authentication to offer it
  it('is not a wall without a password field, however bare the page', () => {
    expect(isLoginWall({ hasPasswordInput: false, text: 'Sign in' })).toBe(false);
  });
});
