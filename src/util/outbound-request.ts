import { lookup } from 'node:dns/promises';
import type { LookupAddress, LookupOptions } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import type { IncomingMessage } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { RequestError, Server as ProxyServer } from 'proxy-chain';
import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from 'undici';
import { validatePublicUrl } from './security.js';

type Resolver = typeof lookup;
type PinnedLookup = (
  hostname: string,
  options: LookupOptions,
  callback: (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void
) => void;

const MAX_REDIRECTS = 5;
const BLOCKED_HEADER = 'x-mcp-web-docs-blocked';
const PROXY_SHUTDOWN_TIMEOUT_MS = 1000;
const blockedAddresses = new BlockList();

for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blockedAddresses.addSubnet(network, prefix, 'ipv4');
}

for (const [network, prefix] of [
  ['::', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 32],
  ['2001:2::', 48],
  ['2001:10::', 28],
  ['2001:20::', 28],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
  ['5f00::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  blockedAddresses.addSubnet(network, prefix, 'ipv6');
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted', 'AbortError');
}

async function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    throw abortError();
  }

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
  });

  try {
    return await Promise.race([promise, aborted]);
  }
  finally {
    signal.removeEventListener('abort', onAbort!);
  }
}

function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  return family !== 0 && !blockedAddresses.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

function validateHostname(hostname: string): string {
  const normalized = hostname.replace(/^\[|\]$/g, '');
  const host = isIP(normalized) === 6 ? `[${normalized}]` : normalized;
  validatePublicUrl(`http://${host}`);
  return normalized;
}

function createPinnedLookup(hostname: string, addresses: LookupAddress[]): PinnedLookup {
  return (requestedHostname, options, callback) => {
    if (requestedHostname.toLowerCase() !== hostname.toLowerCase()) {
      callback(Object.assign(new Error('Unexpected hostname during pinned lookup'), { code: 'EACCES' }), '');
      return;
    }
    if (options.all) {
      callback(null, addresses);
    }
    else {
      const requestedFamily = typeof options.family === 'string' ? Number(options.family.slice(-1)) : options.family;
      const selected = addresses.find(({ family }) => !requestedFamily || family === requestedFamily);
      if (!selected) {
        callback(Object.assign(new Error('No approved address for requested family'), { code: 'ENOTFOUND' }), '');
        return;
      }
      callback(null, selected.address, selected.family);
    }
  };
}

/** Resolve all addresses once and return a lookup callback pinned to an approved address. */
export async function resolvePublicTarget(hostname: string, resolver: Resolver = lookup, signal?: AbortSignal): Promise<PinnedLookup> {
  const normalizedHostname = validateHostname(hostname);
  const family = isIP(normalizedHostname);
  const addresses = family
    ? [{ address: normalizedHostname, family }]
    : await raceWithAbort(resolver(normalizedHostname, { all: true, order: 'verbatim' }), signal);

  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error('Access to non-public addresses is not allowed');
  }

  return createPinnedLookup(normalizedHostname, addresses);
}

function requestAbortSignal(request: IncomingMessage): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.once('aborted', abort);
  request.socket.once('close', abort);

  return {
    signal: controller.signal,
    cleanup: () => {
      request.removeListener('aborted', abort);
      request.socket.removeListener('close', abort);
    },
  };
}

export interface OutboundProxy {
  url: string;
  close(): Promise<void>;
}

/** Start a loopback-only proxy that pins every target connection to its validated DNS result. */
export async function createOutboundProxy(resolver: Resolver = lookup): Promise<OutboundProxy> {
  const server = new ProxyServer({
    host: '127.0.0.1',
    port: 0,
    prepareRequestFunction: async ({ hostname, request }) => {
      const { signal, cleanup } = requestAbortSignal(request);
      try {
        const dnsLookup = await resolvePublicTarget(hostname, resolver, signal);
        return {
          dnsLookup: dnsLookup as typeof import('node:dns').lookup,
        };
      }
      catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          throw error;
        }
        throw new RequestError('Blocked outbound destination', 403, { [BLOCKED_HEADER]: '1' });
      }
      finally {
        cleanup();
      }
    },
  });

  try {
    await server.listen();
  }
  catch (error) {
    await runBoundedCleanup(() => server.close(true));
    throw error;
  }
  server.server.unref();

  return {
    url: `http://127.0.0.1:${server.port}`,
    close: () => server.close(true),
  };
}

interface ProxyState {
  proxy: OutboundProxy;
  dispatcher: Dispatcher;
}

let proxyState: Promise<ProxyState> | undefined;

async function runBoundedCleanup(action: () => Promise<unknown>): Promise<void> {
  const cleanup = Promise.resolve()
    .then(action)
    .catch(() => undefined);
  await Promise.race([cleanup, delay(PROXY_SHUTDOWN_TIMEOUT_MS, undefined, { ref: false })]);
}

function startProxyState(): Promise<ProxyState> {
  const pending = createOutboundProxy().then(async (proxy) => {
    try {
      return { proxy, dispatcher: new ProxyAgent(proxy.url) };
    }
    catch (error) {
      await runBoundedCleanup(proxy.close);
      throw error;
    }
  });
  proxyState = pending;
  void pending.catch(() => {
    if (proxyState === pending) {
      proxyState = undefined;
    }
  });
  return pending;
}

async function getProxyState(signal?: AbortSignal | null): Promise<ProxyState> {
  if (signal?.aborted) {
    throw abortError();
  }
  return raceWithAbort(proxyState ?? startProxyState(), signal);
}

export async function getOutboundProxyUrl(signal?: AbortSignal | null): Promise<string> {
  return (await getProxyState(signal)).proxy.url;
}

export async function closeOutboundProxy(): Promise<void> {
  const statePromise = proxyState;
  if (!statePromise) {
    return;
  }
  proxyState = undefined;

  await runBoundedCleanup(async () => {
    const state = await statePromise;
    await Promise.allSettled([Promise.resolve().then(() => state.dispatcher.destroy()), Promise.resolve().then(state.proxy.close)]);
  });
}

/** Fetch a public URL while validating every redirect through the pinned egress proxy. */
export async function fetchPublicUrl(urlString: string, init: RequestInit = {}): Promise<Response> {
  let url = validatePublicUrl(urlString);
  let headers = init.headers;
  const dispatcher = await getProxyState(init.signal).then((state) => state.dispatcher);

  for (let redirects = 0; ; redirects++) {
    const requestInit = { ...init, headers, redirect: 'manual', dispatcher } as RequestInit;
    const response = await undiciFetch(url.toString(), requestInit as Parameters<typeof undiciFetch>[1]);
    if (response.headers.get(BLOCKED_HEADER) === '1') {
      await response.body?.cancel();
      throw new Error('Blocked outbound destination');
    }
    const location = response.headers.get('location');

    if (![301, 302, 303, 307, 308].includes(response.status) || !location) {
      return response as unknown as Response;
    }
    if (redirects >= MAX_REDIRECTS) {
      await response.body?.cancel();
      throw new Error(`Too many redirects (maximum ${MAX_REDIRECTS})`);
    }

    await response.body?.cancel();
    const nextUrl = validatePublicUrl(new URL(location, url).toString());
    if (nextUrl.origin !== url.origin) {
      const safeHeaders = new Headers(headers);
      safeHeaders.delete('authorization');
      safeHeaders.delete('cookie');
      safeHeaders.delete('proxy-authorization');
      headers = safeHeaders;
    }
    url = nextUrl;
  }
}
