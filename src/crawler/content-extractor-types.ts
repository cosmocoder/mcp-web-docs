import type { ContentFormat } from '../types.js';

export interface ContentExtractor {
  extractContent(document: Document): Promise<ExtractedContent>;
}

export interface ExtractedContent {
  content: string;
  contentFormat: ContentFormat;
  title?: string;
  metadata: {
    type: 'overview' | 'props' | 'examples' | 'api' | 'usage';
    pattern?: ComponentPattern;
    relationships?: ComponentRelationship[];
    context?: string[];
  };
}

export interface ComponentPattern {
  name: string;
  type: 'component' | 'layout' | 'page';
  description: string;
  usageContexts: string[];
  relatedPatterns: string[];
}

export interface ComponentRelationship {
  sourceComponent: string;
  targetComponent: string;
  type: 'contains' | 'uses' | 'extends' | 'precedes';
  context: string;
}
