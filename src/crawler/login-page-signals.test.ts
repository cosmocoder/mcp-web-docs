// @vitest-environment jsdom
import { readLoginPageSignals } from './crawlee-crawler.js';

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
      // the query is dropped: it is where a login page puts the address it turned away
      forms: ['/login'],
      fields: ['username:text', 'password:password'],
    });
  });

  // The point of the shape: what a login page keeps across requests, and what documentation pages
  // differ in. Hashing the prose instead failed both ways - it folded one API reference template
  // describing three endpoints into a single page, and let a login page naming its return URL escape.
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
      forms: [],
      fields: [],
    });
  });

  it('collapses whitespace and caps the headings it reports', () => {
    const signals = render(`<h1>  Sign\n  in  </h1>${[1, 2, 3, 4, 5, 6].map((n) => `<h2>Section ${n}</h2>`).join('')}`);

    expect(signals.headings).toEqual(['Sign in', 'Section 1', 'Section 2', 'Section 3', 'Section 4']);
  });
});
