/**
 * Global test setup for Vitest
 */

import createFetchMock from 'vitest-fetch-mock';

// Initialize fetch mock
const fetchMocker = createFetchMock(vi);
fetchMocker.enableMocks();

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
