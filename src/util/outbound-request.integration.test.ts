import { createServer, type Server } from 'node:http';
import { createServer as createTcpServer, type AddressInfo, type Server as TcpServer } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright';
import { fetch as undiciFetch, ProxyAgent } from 'undici';

import { getBrowserConfig } from '../crawler/browser-config.js';
import {
  BlockedOutboundRequestError,
  classifyOutboundFailure,
  closeOutboundProxy,
  createOutboundProxy,
  isBlockedOutboundResponse,
  type OutboundProxy,
} from './outbound-request.js';

vi.unmock('node:dns/promises');
vi.unmock('proxy-chain');
vi.unmock('undici');

type Resolver = Parameters<typeof createOutboundProxy>[0];

async function listenOnLoopback(server: TcpServer, host = '127.0.0.1'): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, resolve);
  });
  return (server.address() as AddressInfo).port;
}

async function closeTcpServer(server: TcpServer): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function loadImage(page: Page, url: string): Promise<string> {
  return page.evaluate(
    (source) =>
      new Promise<string>((resolve) => {
        const timeout = setTimeout(() => resolve('timed out'), 5000);
        const image = new Image();
        image.onload = () => {
          clearTimeout(timeout);
          resolve('loaded');
        };
        image.onerror = () => {
          clearTimeout(timeout);
          resolve('blocked');
        };
        image.src = source;
      }),
    url
  );
}

async function openWebSocket(page: Page, url: string): Promise<string> {
  return page.evaluate(
    (source) =>
      new Promise<string>((resolve) => {
        const socket = new WebSocket(source);
        const timeout = setTimeout(() => {
          socket.close();
          resolve('timed out');
        }, 5000);
        socket.onopen = () => {
          clearTimeout(timeout);
          resolve('connected');
        };
        socket.onerror = () => {
          clearTimeout(timeout);
          resolve('blocked');
        };
      }),
    url
  );
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

describe('outbound request integration', () => {
  let browser: Browser | undefined;

  afterEach(async () => {
    await browser?.close();
    browser = undefined;
    await closeOutboundProxy();
  });

  it('blocks a real proxied socket before connecting to its private DNS result', async () => {
    let requests = 0;
    const target = createServer((_request, response) => {
      requests++;
      response.end('private');
    });
    const resolver = vi.fn().mockResolvedValue([{ address: '127.0.0.1', family: 4 }]) as unknown as Resolver;
    let proxy: OutboundProxy | undefined;
    let dispatcher: ProxyAgent | undefined;

    try {
      const port = await listenOnLoopback(target);
      proxy = await createOutboundProxy(resolver);
      dispatcher = new ProxyAgent(proxy.url);
      await expect(undiciFetch(`http://public.example:${port}`, { dispatcher, signal: AbortSignal.timeout(5000) })).rejects.toThrow();
      expect(resolver).toHaveBeenCalledWith('public.example', { all: true, order: 'verbatim' });
      expect(requests).toBe(0);
    }
    finally {
      await dispatcher?.destroy();
      await proxy?.close();
      await closeServer(target);
    }
  }, 15_000);

  it.each([
    { host: '127.0.0.1', urlHost: '127.0.0.1' },
    { host: '::1', urlHost: '[::1]' },
  ])(
    'keeps Chromium main-frame, subresource, and WebSocket traffic away from $host',
    async ({ host, urlHost }) => {
      let requests = 0;
      let upgrades = 0;
      const target = createServer((_request, response) => {
        requests++;
        response.end('private');
      });
      target.on('upgrade', (_request, socket) => {
        upgrades++;
        socket.destroy();
      });
      let tlsConnections = 0;
      const tlsTarget = createTcpServer((socket) => {
        tlsConnections++;
        socket.destroy();
      });

      try {
        const port = await listenOnLoopback(target, host);
        const tlsPort = await listenOnLoopback(tlsTarget, host);
        const config = await getBrowserConfig(undefined);
        const proxy = config.launchContext?.launchOptions?.proxy;
        expect(proxy).toEqual(expect.objectContaining({ bypass: '<-loopback>' }));
        browser = await chromium.launch({ headless: true, proxy });
        const page = await browser.newPage();
        const privateUrl = `http://${urlHost}:${port}`;

        const navigationResponse = await page.goto(`${privateUrl}/main`, { waitUntil: 'commit', timeout: 5000 });
        expect(navigationResponse?.status()).toBe(403);
        await expect(isBlockedOutboundResponse(navigationResponse)).resolves.toBe(true);

        await page.goto('about:blank');
        await expect(loadImage(page, `${privateUrl}/image.png`)).resolves.toBe('blocked');
        await expect(openWebSocket(page, `ws://${urlHost}:${port}/socket`)).resolves.toBe('blocked');

        const secureUrl = `https://${urlHost}:${tlsPort}`;
        const secureNavigation = await page
          .goto(`${secureUrl}/main`, { waitUntil: 'commit', timeout: 5000 })
          .then(async (response) => (response?.status() === 403 || (await isBlockedOutboundResponse(response)) ? 'blocked' : 'loaded'))
          .catch(() => 'blocked');
        expect(secureNavigation).toBe('blocked');
        await expect(classifyOutboundFailure(secureUrl)).resolves.toBeInstanceOf(BlockedOutboundRequestError);

        const securePage = await browser.newPage();
        await securePage.goto('about:blank');
        await expect(loadImage(securePage, `${secureUrl}/image.png`)).resolves.toBe('blocked');
        await expect(openWebSocket(securePage, `wss://${urlHost}:${tlsPort}/socket`)).resolves.toBe('blocked');

        expect(requests).toBe(0);
        expect(upgrades).toBe(0);
        expect(tlsConnections).toBe(0);
      }
      finally {
        await browser?.close();
        browser = undefined;
        await closeServer(target);
        await closeTcpServer(tlsTarget);
      }
    },
    30_000
  );
});
