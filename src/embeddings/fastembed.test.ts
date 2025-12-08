import { FastEmbeddings } from './fastembed.js';

// Helper to create async generator from array
async function* createAsyncGenerator<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) {
    yield item;
  }
}

// Use vi.hoisted to define mocks that will be available when vi.mock runs
const { mockPassageEmbed, mockQueryEmbed, mockFlagEmbeddingInit, mockExistsSync, mockMkdir } = vi.hoisted(() => ({
  mockPassageEmbed: vi.fn(),
  mockQueryEmbed: vi.fn(),
  mockFlagEmbeddingInit: vi.fn(),
  mockExistsSync: vi.fn(),
  mockMkdir: vi.fn(),
}));

// Mock fastembed module
vi.mock('fastembed', () => ({
  EmbeddingModel: {
    BGESmallENV15: 'bge-small-en-v1.5',
  },
  FlagEmbedding: {
    init: mockFlagEmbeddingInit,
  },
}));

// Mock fs/promises
vi.mock('node:fs/promises', () => ({
  mkdir: mockMkdir,
}));

// Mock fs
vi.mock('node:fs', () => ({
  existsSync: mockExistsSync,
}));

describe('FastEmbeddings', () => {
  let embeddings: FastEmbeddings;

  beforeEach(() => {
    vi.clearAllMocks();

    // Default mock implementations
    mockPassageEmbed.mockImplementation((texts: string[]) => {
      const results = texts.map(() => new Float32Array(384).fill(0.1));
      return createAsyncGenerator([results]);
    });

    mockQueryEmbed.mockResolvedValue(new Float32Array(384).fill(0.1));

    mockFlagEmbeddingInit.mockResolvedValue({
      passageEmbed: mockPassageEmbed,
      queryEmbed: mockQueryEmbed,
    });

    mockExistsSync.mockReturnValue(true);
    mockMkdir.mockResolvedValue(undefined);

    embeddings = new FastEmbeddings();
  });

  describe('constructor', () => {
    it('should initialize with correct dimensions', () => {
      expect(embeddings.dimensions).toBe(384);
    });

    it('should start with empty cache', async () => {
      // Access private cache via embed caching behavior
      const result1 = await embeddings.embed('test text');
      const result2 = await embeddings.embed('test text');

      // Both should return same result (from cache on second call)
      expect(result1).toEqual(result2);

      // passageEmbed should only be called once due to caching
      expect(mockPassageEmbed).toHaveBeenCalledTimes(1);
    });
  });

  describe('embed', () => {
    it('should generate embedding for valid text', async () => {
      const result = await embeddings.embed('Hello world');

      expect(result).toBeDefined();
      expect(result.length).toBe(384);
      expect(mockPassageEmbed).toHaveBeenCalledWith(['Hello world']);
    });

    it('should trim whitespace from input', async () => {
      await embeddings.embed('  trimmed text  ');

      expect(mockPassageEmbed).toHaveBeenCalledWith(['trimmed text']);
    });

    it('should throw for empty string', async () => {
      await expect(embeddings.embed('')).rejects.toThrow('Input text must be a non-empty string');
    });

    it('should throw for whitespace-only string', async () => {
      await expect(embeddings.embed('   ')).rejects.toThrow('Input text is empty after trimming');
    });

    it('should throw for non-string input', async () => {
      // @ts-expect-error Testing invalid input
      await expect(embeddings.embed(null)).rejects.toThrow('Input text must be a non-empty string');
      // @ts-expect-error Testing invalid input
      await expect(embeddings.embed(undefined)).rejects.toThrow('Input text must be a non-empty string');
      // @ts-expect-error Testing invalid input
      await expect(embeddings.embed(123)).rejects.toThrow('Input text must be a non-empty string');
    });

    it('should cache embeddings', async () => {
      await embeddings.embed('cached text');
      await embeddings.embed('cached text');
      await embeddings.embed('cached text');

      // Should only call the model once
      expect(mockPassageEmbed).toHaveBeenCalledTimes(1);
    });

    it('should use first 200 chars as cache key', async () => {
      const longText = 'a'.repeat(300);
      await embeddings.embed(longText);
      await embeddings.embed(longText);

      expect(mockPassageEmbed).toHaveBeenCalledTimes(1);
    });

    it('should throw on invalid embedding dimensions', async () => {
      mockPassageEmbed.mockImplementation(() => {
        return createAsyncGenerator([[new Float32Array(100).fill(0.1)]]);
      });

      await expect(embeddings.embed('test')).rejects.toThrow('Invalid embedding: got 100 dimensions, expected 384');
    });

    it('should throw on empty embedding result', async () => {
      mockPassageEmbed.mockImplementation(() => {
        return createAsyncGenerator([[]]);
      });

      await expect(embeddings.embed('test')).rejects.toThrow('Invalid embedding');
    });

    it('should handle model errors', async () => {
      mockPassageEmbed.mockImplementation(() => {
        throw new Error('Model error');
      });

      await expect(embeddings.embed('test')).rejects.toThrow('Model error');
    });
  });

  describe('embedQuery', () => {
    it('should generate query embedding for valid text', async () => {
      const result = await embeddings.embedQuery('search query');

      expect(result).toBeDefined();
      expect(result.length).toBe(384);
      expect(mockQueryEmbed).toHaveBeenCalledWith('search query');
    });

    it('should trim whitespace from input', async () => {
      await embeddings.embedQuery('  query  ');

      expect(mockQueryEmbed).toHaveBeenCalledWith('query');
    });

    it('should throw for empty string', async () => {
      await expect(embeddings.embedQuery('')).rejects.toThrow('Input text must be a non-empty string');
    });

    it('should throw for whitespace-only string', async () => {
      await expect(embeddings.embedQuery('   ')).rejects.toThrow('Input text is empty after trimming');
    });

    it('should throw for non-string input', async () => {
      // @ts-expect-error Testing invalid input
      await expect(embeddings.embedQuery(null)).rejects.toThrow('Input text must be a non-empty string');
    });

    it('should cache query embeddings with prefix', async () => {
      await embeddings.embedQuery('cached query');
      await embeddings.embedQuery('cached query');

      // Should only call the model once
      expect(mockQueryEmbed).toHaveBeenCalledTimes(1);
    });

    it('should use separate cache from passage embeddings', async () => {
      await embeddings.embed('same text');
      await embeddings.embedQuery('same text');

      // Both should be called since they use different cache keys
      expect(mockPassageEmbed).toHaveBeenCalledTimes(1);
      expect(mockQueryEmbed).toHaveBeenCalledTimes(1);
    });

    it('should throw on invalid embedding dimensions', async () => {
      mockQueryEmbed.mockResolvedValue(new Float32Array(100).fill(0.1));

      await expect(embeddings.embedQuery('test')).rejects.toThrow('Invalid query embedding: got 100 dimensions, expected 384');
    });

    it('should handle model errors', async () => {
      mockQueryEmbed.mockRejectedValue(new Error('Query model error'));

      await expect(embeddings.embedQuery('test')).rejects.toThrow('Query model error');
    });
  });

  describe('embedBatch', () => {
    it('should generate embeddings for multiple texts', async () => {
      const texts = ['text one', 'text two', 'text three'];
      const result = await embeddings.embedBatch(texts);

      expect(result).toHaveLength(3);
      result.forEach((embedding) => {
        expect(embedding.length).toBe(384);
      });
    });

    it('should return empty array for empty input', async () => {
      const result = await embeddings.embedBatch([]);

      expect(result).toEqual([]);
      expect(mockPassageEmbed).not.toHaveBeenCalled();
    });

    it('should filter out invalid texts', async () => {
      const texts = ['valid', '', null, '  ', 'also valid', undefined];
      // @ts-expect-error Testing invalid input
      await embeddings.embedBatch(texts);

      // Should only process valid texts
      expect(mockPassageEmbed).toHaveBeenCalledWith(['valid', 'also valid']);
    });

    it('should return empty arrays for all-invalid texts', async () => {
      const texts = ['', null, '  '];
      // @ts-expect-error Testing invalid input
      const result = await embeddings.embedBatch(texts);

      expect(result).toEqual([[], [], []]);
      expect(mockPassageEmbed).not.toHaveBeenCalled();
    });

    it('should handle partial invalid embeddings in batch', async () => {
      mockPassageEmbed.mockImplementation(() => {
        return createAsyncGenerator([
          [
            new Float32Array(384).fill(0.1),
            new Float32Array(100).fill(0.1), // Invalid dimension
            new Float32Array(384).fill(0.2),
          ],
        ]);
      });

      const result = await embeddings.embedBatch(['text1', 'text2', 'text3']);

      expect(result[0].length).toBe(384);
      expect(result[1]).toEqual(new Array(384).fill(0)); // Zero-filled fallback
      expect(result[2].length).toBe(384);
    });

    it('should handle model errors', async () => {
      mockPassageEmbed.mockImplementation(() => {
        throw new Error('Batch model error');
      });

      await expect(embeddings.embedBatch(['text'])).rejects.toThrow('Batch model error');
    });
  });

  describe('initialization', () => {
    it('should lazily initialize model on first use', async () => {
      // Model should not be initialized yet
      expect(mockFlagEmbeddingInit).not.toHaveBeenCalled();

      // First embed call triggers initialization
      await embeddings.embed('test');

      expect(mockFlagEmbeddingInit).toHaveBeenCalledTimes(1);
      expect(mockFlagEmbeddingInit).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'bge-small-en-v1.5',
        })
      );
    });

    it('should only initialize once for multiple calls', async () => {
      await embeddings.embed('test1');
      await embeddings.embed('test2');
      await embeddings.embedQuery('query');
      await embeddings.embedBatch(['batch']);

      expect(mockFlagEmbeddingInit).toHaveBeenCalledTimes(1);
    });

    it('should handle concurrent initialization', async () => {
      // Start multiple operations simultaneously
      const promises = [embeddings.embed('test1'), embeddings.embed('test2'), embeddings.embedQuery('query')];

      await Promise.all(promises);

      // Should only initialize once despite concurrent calls
      expect(mockFlagEmbeddingInit).toHaveBeenCalledTimes(1);
    });

    it('should create cache directory if it does not exist', async () => {
      mockExistsSync.mockReturnValue(false);

      await embeddings.embed('test');

      expect(mockMkdir).toHaveBeenCalledWith(expect.stringContaining('fastembed-cache'), { recursive: true });
    });

    it('should not create cache directory if it exists', async () => {
      mockExistsSync.mockReturnValue(true);

      await embeddings.embed('test');

      expect(mockMkdir).not.toHaveBeenCalled();
    });

    it('should retry initialization on failure', async () => {
      vi.useFakeTimers();

      let attempts = 0;
      mockFlagEmbeddingInit.mockImplementation(async () => {
        attempts++;
        if (attempts < 3) {
          throw new Error('Init failed');
        }
        return {
          passageEmbed: mockPassageEmbed,
          queryEmbed: mockQueryEmbed,
        };
      });

      const embedPromise = embeddings.embed('test');

      // Advance through retry delays (2s, 4s exponential backoff)
      await vi.advanceTimersByTimeAsync(2000);
      await vi.advanceTimersByTimeAsync(4000);

      await embedPromise;

      expect(mockFlagEmbeddingInit).toHaveBeenCalledTimes(3);

      vi.useRealTimers();
    });

    it('should throw after max retries', async () => {
      let attempts = 0;
      mockFlagEmbeddingInit.mockImplementation(async () => {
        attempts++;
        throw new Error('Persistent failure');
      });

      // Mock setTimeout to resolve immediately for retry delays
      vi.spyOn(global, 'setTimeout').mockImplementation((callback: () => void) => {
        callback();
        return 0 as unknown as NodeJS.Timeout;
      });

      await expect(embeddings.embed('test')).rejects.toThrow('Persistent failure');
      expect(attempts).toBe(3);

      vi.restoreAllMocks();
    });
  });

  describe('cache management', () => {
    it('should evict oldest entry when cache exceeds 1000 entries', async () => {
      // Generate unique texts to fill cache
      for (let i = 0; i < 1002; i++) {
        mockPassageEmbed.mockImplementationOnce(() => {
          return createAsyncGenerator([[new Float32Array(384).fill(i * 0.001)]]);
        });
        await embeddings.embed(`unique text ${i}`);
      }

      // All 1002 calls should go through (cache evicts oldest)
      expect(mockPassageEmbed).toHaveBeenCalledTimes(1002);

      // First entry should have been evicted, so re-embedding should call model
      mockPassageEmbed.mockImplementationOnce(() => {
        return createAsyncGenerator([[new Float32Array(384).fill(0.999)]]);
      });
      await embeddings.embed('unique text 0');

      expect(mockPassageEmbed).toHaveBeenCalledTimes(1003);
    });
  });
});
