import OpenAI from 'openai';
import { EmbeddingsProvider } from './types.js';

export class OpenAIEmbeddings implements EmbeddingsProvider {
  private openai: OpenAI;
  private cache: Map<string, number[]>;
  readonly dimensions = 1536; // text-embedding-3-small dimensions

  constructor(apiKey: string) {
    if (!apiKey) {
      throw new Error('OpenAI API key is required');
    }
    this.openai = new OpenAI({ apiKey });
    this.cache = new Map();
  }

  async embed(text: string): Promise<number[]> {
    // Ensure input is a string and not empty
    if (!text || typeof text !== 'string') {
      throw new Error('Input text must be a non-empty string');
    }

    // Check cache first
    const cacheKey = text.slice(0, 1000); // Limit cache key size
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    try {
      const cleanText = text.trim();
      if (!cleanText) {
        throw new Error('Input text is empty after trimming');
      }

      const response = await this.openai.embeddings.create({
        model: "text-embedding-3-small",
        input: cleanText,
        dimensions: this.dimensions
      });

      if (!response.data?.[0]?.embedding) {
        throw new Error('No embedding returned from OpenAI');
      }

      const embedding = response.data[0].embedding;

      // Cache the result
      this.cache.set(cacheKey, embedding);

      // Limit cache size to prevent memory issues
      if (this.cache.size > 1000) {
        const firstKey = this.cache.keys().next().value;
        if (firstKey) {
          this.cache.delete(firstKey);
        }
      }

      return embedding;
    } catch (error) {
      console.error('Error generating embedding:', error);
      throw error;
    }
  }
}