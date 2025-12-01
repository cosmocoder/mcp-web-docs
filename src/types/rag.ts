export interface RAGMetadata {
  sourceReliability: number;
  lastVerified: Date;
  citationInfo: {
    version: string;
    commitHash?: string;
    documentVersion?: string;
  };
  contextualSummary: string;
  prerequisites: string[];
  validationRules: {
    constraints: string[];
    requirements: string[];
  };
  semanticTags: string[];
  complexity: 'basic' | 'intermediate' | 'advanced';
  type: 'overview' | 'api' | 'example' | 'usage';
  framework?: string;
  language?: string;
}

export interface EnhancedChunk {
  id: string;
  content: string;
  embedding: number[];
  metadata: RAGMetadata;
  relationships: any[]; // Placeholder for component relationships; refine as needed
}
