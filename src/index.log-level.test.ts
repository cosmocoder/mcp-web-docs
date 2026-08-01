import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * These tests deliberately exercise the REAL @apify/log, in a child process.
 *
 * index.test.ts mocks 'crawlee' wholesale, so it never loads @apify/log and cannot
 * catch a bad APIFY_LOG_LEVEL — the server crashed on startup while that suite stayed
 * green. The failure happens when @apify/log is first imported, and Node caches that
 * module across a test run, so it can only be observed from a fresh process.
 *
 * The value cannot be imported from index.ts either, because importing it boots the
 * whole server, so it is read out of the source instead.
 */
const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const assignedLevel = source.match(/APIFY_LOG_LEVEL\s*=\s*'([^']*)'/)?.[1];

const OFF = '0';

function loadApifyLog(level: string | undefined): string {
  return execFileSync(process.execPath, ['-e', 'process.stdout.write(String(require("@apify/log").default.getLevel()))'], {
    env: { ...process.env, APIFY_LOG_LEVEL: level },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

describe('APIFY_LOG_LEVEL', () => {
  it('is set by index.ts to a value @apify/log accepts', () => {
    expect(assignedLevel).toBeDefined();

    // Silencing this matters because @apify/log writes INFO via console.log, and
    // stdout carries the MCP JSON-RPC channel
    expect(loadApifyLog(assignedLevel)).toBe(OFF);
  });

  it("throws on import when set to the string 'OFF'", () => {
    expect(() => loadApifyLog('OFF')).toThrow();
  });
});
