/**
 * Mock embeddings provider for testing
 */

import type { EmbeddingsProvider } from '../embeddings/types.js';

/**
 * Creates a mock embeddings provider for testing
 * @param dimensions - The number of dimensions for the embeddings (default 384 like FastEmbed)
 */
export function createMockEmbeddings(dimensions: number = 384): EmbeddingsProvider {
  return {
    dimensions,
    embed: async (text: string): Promise<number[]> => {
      // Generate deterministic embedding based on text content hash
      const hash = simpleHash(text);
      return generateDeterministicVector(hash, dimensions);
    },
  };
}

/**
 * Simple hash function for generating deterministic values
 */
function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash);
}

/**
 * Generate a deterministic vector based on a seed
 */
function generateDeterministicVector(seed: number, dimensions: number): number[] {
  const vector: number[] = [];
  let value = seed;
  for (let i = 0; i < dimensions; i++) {
    // Linear congruential generator
    value = (value * 1103515245 + 12345) & 0x7fffffff;
    // Normalize to [-1, 1]
    vector.push((value / 0x7fffffff) * 2 - 1);
  }
  // Normalize vector to unit length
  const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  return vector.map((v) => v / magnitude);
}

/**
 * Mock embeddings provider that returns zero vectors (for error testing)
 */
export function createZeroEmbeddings(dimensions: number = 384): EmbeddingsProvider {
  return {
    dimensions,
    embed: async (): Promise<number[]> => new Array(dimensions).fill(0),
  };
}

/**
 * Mock embeddings provider that throws errors (for error handling testing)
 */
export function createFailingEmbeddings(dimensions: number = 384): EmbeddingsProvider {
  return {
    dimensions,
    embed: async (): Promise<number[]> => {
      throw new Error('Embeddings service unavailable');
    },
  };
}
