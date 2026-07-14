import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { Server as ProxyServer, type PrepareRequestFunction } from 'proxy-chain';
import { fetch as undiciFetch, ProxyAgent } from 'undici';

import { closeOutboundProxy, createOutboundProxy, fetchPublicUrl, getOutboundProxyUrl, resolvePublicTarget } from './outbound-request.js';

type Resolver = Parameters<typeof resolvePublicTarget>[1];

interface MockProxyServerInstance {
  options: Record<string, unknown> & { prepareRequestFunction?: PrepareRequestFunction };
  server: { unref: ReturnType<typeof vi.fn> };
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

  it.each(['10.0.0.1', '169.254.169.254', '::1', 'fc00::1', 'fe80::1', 'ff02::1', '::ffff:c0a8:101'])(
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
      ).rejects.toThrow('non-public');
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

  it('validates a redirect before requesting the next hop', async () => {
    fetchMock.mockResponseOnce('', { status: 302, headers: { location: 'http://127.0.0.1/admin' } });

    await expect(fetchPublicUrl('https://8.8.8.8/docs')).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

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

  it('does not forward credentials across origins', async () => {
    fetchMock.mockResponseOnce('', { status: 302, headers: { location: 'https://1.1.1.1/docs' } });
    fetchMock.mockResponseOnce('ok');

    await fetchPublicUrl('https://8.8.8.8/docs', { headers: { Authorization: 'Bearer secret' } });

    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer secret');
    expect(new Headers(fetchMock.mock.calls[1][1]?.headers).has('authorization')).toBe(false);
  });
});
