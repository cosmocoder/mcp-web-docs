/**
 * Global test setup for Vitest
 */

import createFetchMock from 'vitest-fetch-mock';

// Initialize fetch mock
const fetchMocker = createFetchMock(vi);
fetchMocker.enableMocks();

// Keep outbound-request tests deterministic and offline by default. Tests for
// DNS-aware validation inject explicit resolver results.
vi.mock('node:dns/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns/promises')>();
  return {
    ...actual,
    lookup: vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]),
  };
});

// Unit tests exercise proxy policy without opening a listening socket in the
// sandbox. The mock retains constructor options so tests can invoke the real
// prepareRequestFunction wiring.
vi.mock('proxy-chain', async (importOriginal) => {
  const actual = await importOriginal<typeof import('proxy-chain')>();
  return {
    ...actual,
    Server: class MockProxyServer {
      static instances: MockProxyServer[] = [];
      static nextListenError: Error | undefined;
      readonly server = { unref: vi.fn(), maxConnections: Infinity };
      readonly port = 43123;
      readonly options: Record<string, unknown>;

      constructor(options: Record<string, unknown>) {
        this.options = options;
        MockProxyServer.instances.push(this);
      }

      listen = vi.fn(async () => {
        const error = MockProxyServer.nextListenError;
        MockProxyServer.nextListenError = undefined;
        if (error) {
          throw error;
        }
      });
      close = vi.fn().mockResolvedValue(undefined);
    },
  };
});

vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return {
    ...actual,
    fetch: vi.fn((input: string | URL, init?: RequestInit) => globalThis.fetch(input, init)),
  };
});

// Mock the logger to prevent console output during tests
vi.mock('./util/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock cli-progress to prevent progress bar output during tests
const mockSingleBar = {
  start: vi.fn(),
  update: vi.fn(),
  stop: vi.fn(),
  increment: vi.fn(),
};

vi.mock('cli-progress', () => {
  return {
    SingleBar: class MockSingleBar {
      start = vi.fn();
      update = vi.fn();
      stop = vi.fn();
      increment = vi.fn();
    },
    MultiBar: class MockMultiBar {
      create = vi.fn().mockReturnValue(mockSingleBar);
      stop = vi.fn();
      remove = vi.fn();
    },
    Presets: {
      shades_classic: {},
      shades_grey: {},
      rect: {},
    },
  };
});

// Set up test environment variables
process.env.MCP_WEB_DOCS_SECRET = 'test-secret-key-for-encryption';

// Clean up after each test file
afterEach(() => {
  vi.clearAllMocks();
});
