import { AssembledContext } from "./context-assembler.js";
import { EnhancedChunk } from "../types/rag.js";
import semver from "semver";

export interface VersionedContext {
  compatibleChunks: EnhancedChunk[];
  versionedExamples: {
    version: string;
    examples: string[];
    compatibility: {
      minVersion: string;
      maxVersion?: string;
      deprecatedIn?: string;
      removedIn?: string;
    };
  }[];
}

interface VersionInfo {
  version: string;
  minVersion?: string;
  maxVersion?: string;
  deprecatedIn?: string;
  removedIn?: string;
}

export class VersionManager {
  async getVersionedContext(context: AssembledContext, version: string): Promise<VersionedContext> {
    // Extract version information from chunks
    const versionedChunks = this.filterCompatibleChunks(context.hierarchicalContext, version);

    // Group examples by version
    const versionedExamples = this.extractVersionedExamples(versionedChunks);

    // Sort examples by version compatibility
    const sortedExamples = this.sortExamplesByVersion(versionedExamples, version);

    return {
      compatibleChunks: versionedChunks,
      versionedExamples: sortedExamples
    };
  }

  private filterCompatibleChunks(chunks: EnhancedChunk[], targetVersion: string): EnhancedChunk[] {
    return chunks.filter(chunk => {
      const versionInfo = this.extractVersionInfo(chunk);
      return this.isVersionCompatible(versionInfo, targetVersion);
    });
  }

  private extractVersionedExamples(chunks: EnhancedChunk[]): VersionedContext['versionedExamples'] {
    const examples = new Map<string, {
      examples: string[];
      compatibility: VersionInfo;
    }>();

    for (const chunk of chunks) {
      if (chunk.metadata.type === 'example') {
        const versionInfo = this.extractVersionInfo(chunk);
        const key = versionInfo.version;

        if (!examples.has(key)) {
          examples.set(key, {
            examples: [],
            compatibility: versionInfo
          });
        }

        examples.get(key)!.examples.push(chunk.content);
      }
    }

    return Array.from(examples.entries()).map(([version, data]) => ({
      version,
      examples: data.examples,
      compatibility: {
        minVersion: data.compatibility.minVersion || version,
        maxVersion: data.compatibility.maxVersion,
        deprecatedIn: data.compatibility.deprecatedIn,
        removedIn: data.compatibility.removedIn
      }
    }));
  }

  private extractVersionInfo(chunk: EnhancedChunk): VersionInfo {
    const citationInfo = chunk.metadata.citationInfo;
    return {
      version: citationInfo.version,
      minVersion: citationInfo.version, // Default to current version as minimum
      maxVersion: undefined, // No upper bound by default
      deprecatedIn: undefined,
      removedIn: undefined
    };
  }

  private isVersionCompatible(versionInfo: VersionInfo, targetVersion: string): boolean {
    // If no version information is available, consider it compatible
    if (!versionInfo.version) return true;

    try {
      // Check if the version is removed
      if (versionInfo.removedIn && semver.gte(targetVersion, versionInfo.removedIn)) {
        return false;
      }

      // Check version range compatibility
      const minVersion = versionInfo.minVersion || versionInfo.version;
      if (!semver.gte(targetVersion, minVersion)) {
        return false;
      }

      if (versionInfo.maxVersion && semver.gt(targetVersion, versionInfo.maxVersion)) {
        return false;
      }

      return true;
    } catch (error) {
      // If version comparison fails, default to compatible
      console.warn(`Version comparison failed for ${targetVersion}:`, error);
      return true;
    }
  }

  private sortExamplesByVersion(examples: VersionedContext['versionedExamples'], targetVersion: string): VersionedContext['versionedExamples'] {
    return examples.sort((a, b) => {
      // Prioritize non-deprecated examples
      const aDeprecated = a.compatibility.deprecatedIn && semver.gte(targetVersion, a.compatibility.deprecatedIn);
      const bDeprecated = b.compatibility.deprecatedIn && semver.gte(targetVersion, b.compatibility.deprecatedIn);

      if (aDeprecated && !bDeprecated) return 1;
      if (!aDeprecated && bDeprecated) return -1;

      // Sort by version proximity to target
      const aDistance = Math.abs(semver.compare(targetVersion, a.version));
      const bDistance = Math.abs(semver.compare(targetVersion, b.version));

      return aDistance - bDistance;
    });
  }
}
