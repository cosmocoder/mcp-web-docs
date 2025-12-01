import { GeneratedResponse } from "./response-generator.js";

export interface CachedResponse {
  query: string;
  response: GeneratedResponse;
}

export class RAGCache {
  private cache: Map<string, CachedResponse> = new Map();

  async getCachedResponse(query: string): Promise<CachedResponse | null> {
    return this.cache.get(query) || null;
  }

  async cacheResponse(query: string, response: GeneratedResponse): Promise<void> {
    this.cache.set(query, { query, response });
  }
}
