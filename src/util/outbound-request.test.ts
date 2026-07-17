import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { Server as ProxyServer, type PrepareRequestFunction } from 'proxy-chain';
import { fetch as undiciFetch, ProxyAgent } from 'undici';

import {
  BlockedOutboundRequestError,
  classifyOutboundFailure,
  closeOutboundProxy,
  createOutboundProxy,
  fetchPublicUrl,
  getOutboundProxyUrl,
  OutboundRequestFailedError,
  resolvePublicTarget,
} from './outbound-request.js';

type Resolver = Parameters<typeof resolvePublicTarget>[1];

interface MockProxyServerInstance {
  options: Record<string, unknown> & { prepareRequestFunction?: PrepareRequestFunction };
  server: { unref: ReturnType<typeof vi.fn>; maxConnections: number };
  close: ReturnType<typeof vi.fn>;
}

interface MockProxyServerConstructor {
  instances: MockProxyServerInstance[];
  nextListenError?: Error;
}

const mockProxyServer = ProxyServer as unknown as MockProxyServerConstructor;

function resolver(addresses: Array<{ address: string; family: 4 | 6 }>): Resolver {
  return vi.fn().mockResolvedValue(addresses) as unknown as Resolver;
}

function latestProxyServer(): MockProxyServerInstance {
  return mockProxyServer.instances.at(-1)!;
}

describe('outbound request security', () => {
  beforeEach(() => {
    fetchMock.resetMocks();
  });

  afterAll(async () => {
    await closeOutboundProxy();
  });

  it('accepts a hostname only when every resolved address is public', async () => {
    const lookup = resolver([
      { address: '8.8.8.8', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ]);

    await expect(resolvePublicTarget('example.com', lookup)).resolves.toEqual(expect.any(Function));
    expect(lookup).toHaveBeenCalledWith('example.com', { all: true, order: 'verbatim' });
  });

  it.each(['10.0.0.1', '169.254.169.254', '::1', '100:0:0:1::1', '4000::1', 'fc00::1', 'fe80::1', 'ff02::1', '::ffff:c0a8:101'])(
    'rejects a hostname when DNS includes non-public address %s',
    async (address) => {
      await expect(
        resolvePublicTarget(
          'example.com',
          resolver([
            { address: '8.8.8.8', family: 4 },
            { address, family: address.includes(':') ? 6 : 4 },
          ])
        )
      ).rejects.toMatchObject({
        name: 'BlockedOutboundRequestError',
        message: expect.stringContaining('non-public'),
      });
    }
  );

  it('surfaces a proxy-blocked target as a request failure', async () => {
    const proxy = await createOutboundProxy(resolver([{ address: '127.0.0.1', family: 4 }]));
    const prepareRequest = latestProxyServer().options.prepareRequestFunction!;
    const request = Object.assign(new EventEmitter(), { socket: new EventEmitter() }) as unknown as IncomingMessage;

    await expect(
      prepareRequest({
        hostname: 'example.com',
        port: 443,
        isHttp: false,
        connectionId: 1,
        request,
        username: '',
        password: '',
      })
    ).rejects.toMatchObject({ name: 'RequestError', statusCode: 403 });
    await proxy.close();

    fetchMock.mockResponseOnce('Blocked outbound destination', {
      status: 403,
      headers: { 'x-mcp-web-docs-blocked': '1' },
    });
    await expect(fetchPublicUrl('http://8.8.8.8/docs')).rejects.toThrow('Blocked outbound destination');
  });

  it.each(['EAI_AGAIN', 'ENOTFOUND'])('classifies resolver error %s as an unblocked proxy failure', async (code) => {
    const lookup = vi.fn().mockRejectedValue(Object.assign(new Error(code), { code })) as unknown as Resolver;
    const proxy = await createOutboundProxy(lookup);
    const prepareRequest = latestProxyServer().options.prepareRequestFunction!;
    const request = Object.assign(new EventEmitter(), { socket: new EventEmitter() }) as unknown as IncomingMessage;

    await expect(
      prepareRequest({
        hostname: 'example.com',
        port: 443,
        isHttp: false,
        connectionId: 1,
        request,
        username: '',
        password: '',
      })
    ).rejects.toMatchObject({
      name: 'RequestError',
      statusCode: 502,
      headers: { 'x-mcp-web-docs-failed': '1' },
    });
    await proxy.close();
  });

  it('classifies concurrent failures independently even for the same endpoint', async () => {
    const [blocked, failed] = await Promise.all([
      classifyOutboundFailure('https://same.example.com/docs', resolver([{ address: '127.0.0.1', family: 4 }])),
      classifyOutboundFailure('https://same.example.com/docs', resolver([{ address: '8.8.8.8', family: 4 }])),
    ]);

    expect(blocked).toBeInstanceOf(BlockedOutboundRequestError);
    expect(failed).toBeInstanceOf(OutboundRequestFailedError);
  });

  it('surfaces a proxy network failure to raw fetch callers', async () => {
    fetchMock.mockResponseOnce('Outbound destination unavailable', {
      status: 502,
      headers: { 'x-mcp-web-docs-failed': '1' },
    });

    await expect(fetchPublicUrl('http://8.8.8.8/docs')).rejects.toMatchObject({
      name: 'OutboundRequestFailedError',
      message: 'Outbound destination unavailable',
    });
  });

  it('classifies a rejected raw fetch by validating the failed URL', async () => {
    fetchMock.mockRejectOnce(new Error('fetch failed'));

    await expect(fetchPublicUrl('https://8.8.8.8/docs')).rejects.toBeInstanceOf(OutboundRequestFailedError);
  });

  it('pins the proxy connector to the validated address without resolving again', async () => {
    const lookup = vi
      .fn()
      .mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }])
      .mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]) as unknown as Resolver;
    const proxy = await createOutboundProxy(lookup);
    const prepareRequest = latestProxyServer().options.prepareRequestFunction!;
    const socket = new EventEmitter();
    const request = Object.assign(new EventEmitter(), { socket }) as unknown as IncomingMessage;
    const target = await prepareRequest({
      hostname: 'example.com',
      port: 443,
      isHttp: false,
      connectionId: 1,
      request,
      username: '',
      password: '',
    });

    const connectedAddress = await new Promise<string>((resolve, reject) => {
      target!.dnsLookup!('example.com', { all: false }, (error, address) => {
        if (error) {
          reject(error);
        }
        else {
          resolve(address as string);
        }
      });
    });

    expect(connectedAddress).toBe('8.8.8.8');
    expect(lookup).toHaveBeenCalledOnce();
    await proxy.close();
  });

  it('bounds concurrent resolver work and removes aborted queued lookups', async () => {
    const pending: Array<(addresses: Array<{ address: string; family: 4 }>) => void> = [];
    const lookup = vi.fn(
      () =>
        new Promise<Array<{ address: string; family: 4 }>>((resolve) => {
          pending.push(resolve);
        })
    ) as unknown as Resolver;
    const proxy = await createOutboundProxy(lookup);
    const prepareRequest = latestProxyServer().options.prepareRequestFunction!;
    const requests = Array.from(
      { length: 65 },
      () => Object.assign(new EventEmitter(), { socket: new EventEmitter() }) as unknown as IncomingMessage
    );
    const lookups = requests.map((request, index) =>
      prepareRequest({
        hostname: `host-${index}.example.com`,
        port: 443,
        isHttp: false,
        connectionId: index,
        request,
        username: '',
        password: '',
      })
    );

    await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(64));

    requests[0].emit('aborted');
    await expect(lookups[0]).rejects.toMatchObject({ name: 'AbortError' });
    expect(lookup).toHaveBeenCalledTimes(64);

    requests[64].emit('aborted');
    await expect(lookups[64]).rejects.toMatchObject({ name: 'AbortError' });

    pending.forEach((resolve) => resolve([{ address: '8.8.8.8', family: 4 }]));
    await expect(Promise.all(lookups.slice(1, 64))).resolves.toHaveLength(63);
    expect(lookup).toHaveBeenCalledTimes(64);
    await proxy.close();
  });

  it('aborts DNS validation while the resolver is pending', async () => {
    const controller = new AbortController();
    const lookup = vi.fn(() => new Promise<never>(() => {})) as unknown as Resolver;
    const result = resolvePublicTarget('example.com', lookup, controller.signal);

    controller.abort();

    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('binds the egress proxy only to loopback and closes cleanly', async () => {
    const proxy = await createOutboundProxy(resolver([{ address: '8.8.8.8', family: 4 }]));
    const server = latestProxyServer();

    expect(proxy.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(server.options).toMatchObject({ host: '127.0.0.1', port: 0 });
    expect(server.server.unref).toHaveBeenCalledOnce();
    expect(server.server.maxConnections).toBe(64);
    await expect(proxy.close()).resolves.toBeUndefined();
    expect(server.close).toHaveBeenCalledWith(true);
  });

  it('honors a caller abort before proxy setup or network access', async () => {
    const serverCount = mockProxyServer.instances.length;
    const controller = new AbortController();
    controller.abort();

    await expect(fetchPublicUrl('https://8.8.8.8/docs', { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockProxyServer.instances).toHaveLength(serverCount);
  });

  it('retries proxy startup after a failed initialization', async () => {
    await closeOutboundProxy();
    const serverCount = mockProxyServer.instances.length;
    mockProxyServer.nextListenError = new Error('listen failed');

    await expect(getOutboundProxyUrl()).rejects.toThrow('listen failed');
    await expect(getOutboundProxyUrl()).resolves.toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    expect(mockProxyServer.instances).toHaveLength(serverCount + 2);
    expect(mockProxyServer.instances[serverCount].close).toHaveBeenCalledWith(true);
    await closeOutboundProxy();
  });

  it('bounds shutdown while force cleanup is pending or rejects', async () => {
    await closeOutboundProxy();
    await getOutboundProxyUrl();
    const server = latestProxyServer();
    const destroy = vi.spyOn(ProxyAgent.prototype, 'destroy').mockReturnValue(new Promise(() => {}));
    server.close.mockRejectedValueOnce(new Error('close failed'));
    vi.useFakeTimers();

    try {
      const closing = closeOutboundProxy();
      await vi.advanceTimersByTimeAsync(1000);

      await expect(closing).resolves.toBeUndefined();
      expect(destroy).toHaveBeenCalledOnce();
      expect(server.close).toHaveBeenCalledWith(true);
    }
    finally {
      vi.useRealTimers();
      destroy.mockRestore();
    }
  });

  it.each(['http://127.0.0.1/admin', 'http://[::1]/admin'])(
    'validates a redirect to %s before requesting the next hop',
    async (location) => {
      fetchMock.mockResponseOnce('', { status: 302, headers: { location } });

      await expect(fetchPublicUrl('https://8.8.8.8/docs')).rejects.toMatchObject({ name: 'BlockedOutboundRequestError' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  );

  it('preserves redirects between public URLs', async () => {
    fetchMock.mockResponseOnce('', { status: 302, headers: { location: 'https://1.1.1.1/docs' } });
    fetchMock.mockResponseOnce('ok');

    const response = await fetchPublicUrl('https://8.8.8.8/docs');

    expect(await response.text()).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vi.mocked(undiciFetch)).toHaveBeenCalledWith(
      'https://8.8.8.8/docs',
      expect.objectContaining({ dispatcher: expect.any(ProxyAgent), redirect: 'manual' })
    );
  });

  it('does not replay a request body across redirects', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    vi.mocked(undiciFetch).mockResolvedValueOnce({
      status: 307,
      headers: new Headers({ location: 'https://1.1.1.1/docs' }),
      body: { cancel },
    } as unknown as Awaited<ReturnType<typeof undiciFetch>>);

    await expect(fetchPublicUrl('https://8.8.8.8/docs', { body: 'payload', method: 'POST' })).rejects.toThrow(
      'Cannot redirect a request with a body'
    );

    expect(cancel).toHaveBeenCalledOnce();
    expect(undiciFetch).toHaveBeenCalledOnce();
  });

  it('does not forward credentials across origins', async () => {
    fetchMock.mockResponseOnce('', { status: 302, headers: { location: 'https://1.1.1.1/docs' } });
    fetchMock.mockResponseOnce('ok');

    await fetchPublicUrl('https://8.8.8.8/docs', { headers: { Authorization: 'Bearer secret' } });

    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer secret');
    expect(new Headers(fetchMock.mock.calls[1][1]?.headers).has('authorization')).toBe(false);
  });
});
