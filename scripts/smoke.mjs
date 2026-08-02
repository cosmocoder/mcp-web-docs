#!/usr/bin/env node

/**
 * Starts the built server and checks it answers an MCP initialize handshake.
 *
 * The unit suite mocks 'crawlee', so it cannot see a binary that throws while loading
 * its dependencies — that gap let a fatal APIFY_LOG_LEVEL ship. Anything that stops
 * `node build/index.js` from serving should fail here.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TIMEOUT_MS = 30_000;

const request = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } },
};

// The server stores data under $HOME, so point it somewhere disposable
const home = await mkdtemp(join(tmpdir(), 'mcp-web-docs-smoke-'));
const server = spawn(process.execPath, ['build/index.js'], { env: { ...process.env, HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });

let stdout = '';
let stderr = '';
server.stdout.on('data', (chunk) => (stdout += chunk));
server.stderr.on('data', (chunk) => (stderr += chunk));

const handshake = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`no initialize response within ${TIMEOUT_MS}ms`)), TIMEOUT_MS);
  const settle = (fn, value) => {
    clearTimeout(timer);
    fn(value);
  };

  server.on('error', (error) => settle(reject, error));
  server.on('exit', (code, signal) => settle(reject, new Error(`server exited (code ${code}, signal ${signal}) before responding`)));

  server.stdout.on('data', () => {
    for (const line of stdout.split('\n')) {
      if (!line.trim()) {
        continue;
      }
      try {
        const message = JSON.parse(line);
        if (message.id === request.id) {
          settle(message.error ? reject : resolve, message.error ? new Error(JSON.stringify(message.error)) : message.result);
        }
      }
      catch {
        // partial frame, wait for the rest
      }
    }
  });
});

server.stdin.write(`${JSON.stringify(request)}\n`);

try {
  const result = await handshake;
  // A reply is not enough — a server that answers `{}` is still broken, and without
  // this the log below would happily print "undefined answered initialize" and pass.
  if (!result?.serverInfo?.name || !result.protocolVersion) {
    throw new Error(`initialize answered without server info: ${JSON.stringify(result)}`);
  }
  console.log(`smoke: ${result.serverInfo.name} answered initialize (protocol ${result.protocolVersion})`);
}
catch (error) {
  console.error(`smoke failed: ${error.message}`);
  if (stderr.trim()) {
    console.error(stderr.trim());
  }
  process.exitCode = 1;
}
finally {
  server.kill('SIGKILL');
  await rm(home, { recursive: true, force: true });
}
