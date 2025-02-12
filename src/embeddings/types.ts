export interface EmbeddingsProvider {
  embed(text: string): Promise<number[]>;
  dimensions: number;
}