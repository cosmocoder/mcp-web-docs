import { readFileSync } from 'node:fs';

/**
 * Loads the real @apify/log. index.test.ts mocks 'crawlee' wholesale, so it never
 * loads @apify/log and cannot catch a level the logger refuses to parse.
 *
 * The value can't be imported from index.ts — importing it boots the server — so it
 * is read out of the source. That pins what is assigned, not when: scripts/smoke.mjs
 * is what catches the assignment moving below the crawlee import.
 */
const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const assignments = source.match(/^\s*process\.env\.APIFY_LOG_LEVEL\s*=\s*'[^']*';/gm) ?? [];

it('sets APIFY_LOG_LEVEL to a level @apify/log accepts', async () => {
  expect(assignments, 'index.ts should assign APIFY_LOG_LEVEL exactly once, as a single-quoted literal').toHaveLength(1);

  // An unparsed match falls back to '', which resolves to INFO and fails the assertion
  process.env.APIFY_LOG_LEVEL = /'([^']*)'/.exec(assignments[0] ?? '')?.[1] ?? '';
  vi.resetModules();

  // Silencing this matters because @apify/log writes INFO through console.log, and
  // stdout carries the MCP JSON-RPC channel
  const { default: log } = await import('@apify/log');

  expect(log.getLevel()).toBe(0);
});
