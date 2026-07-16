import { lookup } from 'node:dns/promises';
import type { LookupAddress, LookupOptions } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import type { IncomingMessage } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { RequestError, Server as ProxyServer } from 'proxy-chain';
import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from 'undici';
import { validatePublicUrl } from './security.js';

type Resolver = (hostname: string, options: { all: true; order: 'verbatim' }) => Promise<LookupAddress[]>;
type PinnedLookup = (
  hostname: string,
  options: LookupOptions,
  callback: (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void
) => void;

const MAX_REDIRECTS = 5;
const BLOCKED_HEADER = 'x-mcp-web-docs-blocked';
const FAILED_HEADER = 'x-mcp-web-docs-failed';
const PROXY_SHUTDOWN_TIMEOUT_MS = 1000;
const FAILURE_CLASSIFICATION_TIMEOUT_MS = 1000;
const MAX_PROXY_CONNECTIONS = 64;
const publicAddresses = new BlockList();
const blockedAddresses = new BlockList();

publicAddresses.addSubnet('0.0.0.0', 0, 'ipv4');
publicAddresses.addSubnet('2000::', 3, 'ipv6');

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

async function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (!signal) {
    return promise;
  }
  signal.throwIfAborted();

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });

  try {
    return await Promise.race([promise, aborted]);
  }
  finally {
    signal.removeEventListener('abort', onAbort!);
  }
}

function createLimitedResolver(
  resolver: Resolver
): (hostname: string, options: { all: true; order: 'verbatim' }, signal?: AbortSignal) => Promise<LookupAddress[]> {
  interface QueuedLookup {
    hostname: string;
    options: { all: true; order: 'verbatim' };
    signal?: AbortSignal;
    resolve: (addresses: LookupAddress[]) => void;
    reject: (error: unknown) => void;
    onAbort?: () => void;
  }

  let active = 0;
  const queue: QueuedLookup[] = [];

  const drain = () => {
    while (active < MAX_PROXY_CONNECTIONS && queue.length > 0) {
      const lookupRequest = queue.shift()!;
      lookupRequest.signal?.removeEventListener('abort', lookupRequest.onAbort!);
      if (lookupRequest.signal?.aborted) {
        lookupRequest.reject(lookupRequest.signal.reason);
        continue;
      }

      active++;
      Promise.resolve()
        .then(() => resolver(lookupRequest.hostname, lookupRequest.options))
        .then(lookupRequest.resolve, lookupRequest.reject)
        .finally(() => {
          active--;
          drain();
        });
    }
  };

  return (hostname, options, signal) => {
    signal?.throwIfAborted();
    return new Promise<LookupAddress[]>((resolve, reject) => {
      const lookupRequest: QueuedLookup = { hostname, options, signal, resolve, reject };
      lookupRequest.onAbort = () => {
        const index = queue.indexOf(lookupRequest);
        if (index >= 0) {
          queue.splice(index, 1);
          reject(signal!.reason);
        }
      };
      queue.push(lookupRequest);
      signal?.addEventListener('abort', lookupRequest.onAbort, { once: true });
      drain();
    });
  };
}

function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  const addressFamily = family === 4 ? 'ipv4' : 'ipv6';
  return family !== 0 && publicAddresses.check(address, addressFamily) && !blockedAddresses.check(address, addressFamily);
}

export class BlockedOutboundRequestError extends Error {
  constructor(message = 'Blocked outbound destination') {
    super(message);
    this.name = 'BlockedOutboundRequestError';
  }
}

export class OutboundRequestFailedError extends Error {
  constructor(message = 'Outbound request failed') {
    super(message);
    this.name = 'OutboundRequestFailedError';
  }
}

type BrowserResponse = { status(): number; headerValue(name: string): Promise<string | null> };

export async function getOutboundResponseError(response: BrowserResponse | null | undefined): Promise<Error | undefined> {
  if (!response || (response.status() !== 403 && response.status() !== 502)) {
    return undefined;
  }
  try {
    const [blocked, failed] = await Promise.all([response.headerValue(BLOCKED_HEADER), response.headerValue(FAILED_HEADER)]);
    if (response.status() === 403 && blocked === '1') {
      return new BlockedOutboundRequestError();
    }
    if (response.status() === 502 && failed === '1') {
      return new OutboundRequestFailedError('Outbound destination unavailable');
    }
    return undefined;
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new OutboundRequestFailedError(`Failed to inspect outbound response: ${message}`);
  }
}

export async function isBlockedOutboundResponse(response: BrowserResponse | null | undefined): Promise<boolean> {
  return (await getOutboundResponseError(response)) instanceof BlockedOutboundRequestError;
}

export function isNavigationCancellationError(errorText: string): boolean {
  return /ERR_ABORTED|NS_BINDING_ABORTED|cancel(?:l)?ed.*load|load.*cancel(?:l)?ed/i.test(errorText);
}

function validateHostname(hostname: string): string {
  const normalized = hostname.replace(/^\[|\]$/g, '');
  const host = isIP(normalized) === 6 ? `[${normalized}]` : normalized;
  try {
    validatePublicUrl(`http://${host}`);
  }
  catch {
    throw new BlockedOutboundRequestError('Access to non-public addresses is not allowed');
  }
  return normalized;
}

function validateOutboundUrl(urlString: string): URL {
  try {
    return validatePublicUrl(urlString);
  }
  catch (error) {
    if (error instanceof Error && error.message.startsWith('Access to')) {
      throw new BlockedOutboundRequestError(error.message);
    }
    throw error;
  }
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
    throw new BlockedOutboundRequestError('Access to non-public addresses is not allowed');
  }

  return createPinnedLookup(normalizedHostname, addresses);
}

const limitedClassificationResolver = createLimitedResolver(lookup);

/** Re-resolve the exact URL whose connection failed to distinguish policy blocks from ordinary network failures. */
export async function classifyOutboundFailure(
  input: string | URL,
  resolver: Resolver = lookup
): Promise<BlockedOutboundRequestError | OutboundRequestFailedError> {
  let url: URL;
  try {
    url = validateOutboundUrl(input.toString());
  }
  catch (error) {
    if (error instanceof BlockedOutboundRequestError || (error instanceof Error && error.message.startsWith('Access to'))) {
      return new BlockedOutboundRequestError();
    }
    return new OutboundRequestFailedError('Outbound destination unavailable');
  }

  const signal = AbortSignal.timeout(FAILURE_CLASSIFICATION_TIMEOUT_MS);
  try {
    const classificationResolver: Resolver =
      resolver === lookup ? (hostname, options) => limitedClassificationResolver(hostname, options, signal) : resolver;
    await resolvePublicTarget(url.hostname, classificationResolver, signal);
    return new OutboundRequestFailedError('Outbound destination unavailable');
  }
  catch (error) {
    if (error instanceof BlockedOutboundRequestError) {
      return new BlockedOutboundRequestError();
    }
    return new OutboundRequestFailedError('Outbound destination unavailable');
  }
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
  const limitedResolver = createLimitedResolver(resolver);
  const server = new ProxyServer({
    host: '127.0.0.1',
    port: 0,
    prepareRequestFunction: async ({ hostname, request }) => {
      const { signal, cleanup } = requestAbortSignal(request);
      try {
        const dnsLookup = await resolvePublicTarget(hostname, (target, options) => limitedResolver(target, options, signal), signal);
        return {
          dnsLookup: dnsLookup as typeof import('node:dns').lookup,
        };
      }
      catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          throw error;
        }
        if (error instanceof BlockedOutboundRequestError) {
          throw new RequestError('Blocked outbound destination', 403, { [BLOCKED_HEADER]: '1' });
        }
        throw new RequestError('Outbound destination unavailable', 502, { [FAILED_HEADER]: '1' });
      }
      finally {
        cleanup();
      }
    },
  });
  // Bound concurrent proxy sockets so hostile pages cannot fan out unbounded resolver work.
  server.server.maxConnections = MAX_PROXY_CONNECTIONS;

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
  signal?.throwIfAborted();
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
  let url = validateOutboundUrl(urlString);
  let headers = init.headers;
  const dispatcher = await getProxyState(init.signal).then((state) => state.dispatcher);

  for (let redirects = 0; ; redirects++) {
    const requestInit = { ...init, headers, redirect: 'manual', dispatcher } as RequestInit;
    let response;
    try {
      response = await undiciFetch(url.toString(), requestInit as Parameters<typeof undiciFetch>[1]);
    }
    catch (error) {
      if (init.signal?.aborted) {
        throw error;
      }
      throw await classifyOutboundFailure(url);
    }
    if (response.headers.get(BLOCKED_HEADER) === '1') {
      await response.body?.cancel();
      throw new BlockedOutboundRequestError();
    }
    if (response.headers.get(FAILED_HEADER) === '1') {
      await response.body?.cancel();
      throw new OutboundRequestFailedError('Outbound destination unavailable');
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
    const nextUrl = validateOutboundUrl(new URL(location, url).toString());
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
