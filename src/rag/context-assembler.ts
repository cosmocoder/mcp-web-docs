import { EnhancedChunk } from "../types/rag.js";
import { ComponentRelationship } from "../crawler/content-extractor-types.js";

export interface AssembledContext {
  hierarchicalContext: EnhancedChunk[];
  relationships: ComponentRelationship[];
  metadata: {
    summary: string;
    topics: string[];
    complexity: 'basic' | 'intermediate' | 'advanced';
    prerequisites: string[];
    frameworks: string[];
    languages: string[];
  };
}

interface ChunkGroup {
  type: 'overview' | 'api' | 'example' | 'usage';
  chunks: EnhancedChunk[];
}

export class ContextAssembler {
  async assembleContext(chunks: EnhancedChunk[]): Promise<AssembledContext> {
    // Group chunks by type
    const groups = this.groupChunksByType(chunks);

    // Extract relationships between chunks
    const relationships = this.extractRelationships(chunks);

    // Build hierarchical context
    const hierarchicalContext = this.buildHierarchy(groups);

    // Consolidate metadata
    const metadata = this.consolidateMetadata(chunks);

    return {
      hierarchicalContext,
      relationships,
      metadata
    };
  }

  private groupChunksByType(chunks: EnhancedChunk[]): Map<string, ChunkGroup> {
    const groups = new Map<string, ChunkGroup>();

    for (const chunk of chunks) {
      const type = chunk.metadata.type || 'overview';
      if (!groups.has(type)) {
        groups.set(type, { type, chunks: [] });
      }
      groups.get(type)!.chunks.push(chunk);
    }

    return groups;
  }

  private extractRelationships(chunks: EnhancedChunk[]): ComponentRelationship[] {
    const relationships: ComponentRelationship[] = [];

    // Collect all relationships from chunks
    for (const chunk of chunks) {
      if (chunk.relationships) {
        relationships.push(...chunk.relationships);
      }
    }

    // Remove duplicates
    return this.deduplicateRelationships(relationships);
  }

  private buildHierarchy(groups: Map<string, ChunkGroup>): EnhancedChunk[] {
    const hierarchy: EnhancedChunk[] = [];

    // Start with overview chunks
    if (groups.has('overview')) {
      hierarchy.push(...groups.get('overview')!.chunks);
    }

    // Add API documentation
    if (groups.has('api')) {
      hierarchy.push(...groups.get('api')!.chunks);
    }

    // Add usage examples
    if (groups.has('usage')) {
      hierarchy.push(...groups.get('usage')!.chunks);
    }

    // Add code examples
    if (groups.has('example')) {
      hierarchy.push(...groups.get('example')!.chunks);
    }

    return hierarchy;
  }

  private consolidateMetadata(chunks: EnhancedChunk[]): AssembledContext['metadata'] {
    const topics = new Set<string>();
    const prerequisites = new Set<string>();
    const frameworks = new Set<string>();
    const languages = new Set<string>();
    let maxComplexity: 'basic' | 'intermediate' | 'advanced' = 'basic';

    for (const chunk of chunks) {
      // Collect topics from semantic tags
      chunk.metadata.semanticTags?.forEach(tag => topics.add(tag));

      // Collect prerequisites
      chunk.metadata.prerequisites?.forEach(prereq => prerequisites.add(prereq));

      // Track frameworks and languages
      if (chunk.metadata.framework) frameworks.add(chunk.metadata.framework);
      if (chunk.metadata.language) languages.add(chunk.metadata.language);

      // Determine highest complexity
      if (chunk.metadata.complexity === 'advanced' ||
         (chunk.metadata.complexity === 'intermediate' && maxComplexity === 'basic')) {
        maxComplexity = chunk.metadata.complexity;
      }
    }

    // Generate a summary based on the most relevant chunks
    const summary = this.generateSummary(chunks);

    return {
      summary,
      topics: Array.from(topics),
      complexity: maxComplexity,
      prerequisites: Array.from(prerequisites),
      frameworks: Array.from(frameworks),
      languages: Array.from(languages)
    };
  }

  private generateSummary(chunks: EnhancedChunk[]): string {
    // Sort chunks by relevance (using sourceReliability as a proxy)
    const sortedChunks = [...chunks].sort((a, b) =>
      (b.metadata.sourceReliability || 0) - (a.metadata.sourceReliability || 0)
    );

    // Take the most relevant chunks' summaries
    const summaries = sortedChunks
      .slice(0, 3)
      .map(chunk => chunk.metadata.contextualSummary || '')
      .filter(Boolean);

    return summaries.join(' ');
  }

  private deduplicateRelationships(relationships: ComponentRelationship[]): ComponentRelationship[] {
    const seen = new Set<string>();
    return relationships.filter(rel => {
      const key = `${rel.sourceComponent}-${rel.targetComponent}-${rel.type}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}
