import { CrawlResult, DocumentChunk, DocumentProcessor, ProcessedDocument } from '../types.js';
import { EmbeddingsProvider } from '../embeddings/types.js';
import { processHtmlContent } from './content.js';
import { processMarkdownContent, processExtractedContent } from './markdown.js';
import { isMarkdownPath } from '../config.js';
import { logger } from '../util/logger.js';
import { parseMetadata } from './metadata-parser.js';

// Extractors that return already-formatted or plain text content (not raw HTML)
const FORMATTED_CONTENT_EXTRACTORS = [
  'StorybookExtractor',
  'GithubPagesExtractor',
  'DefaultExtractor', // Crawlee's default extractor returns plain text, not HTML
  // Add more extractors here as they're implemented
];

/**
 * Create a DocumentChunk with parsed metadata from the content
 */
function createChunkWithMetadata(
  content: string,
  baseMetadata: { url: string; title: string; path: string },
  startLine: number,
  endLine: number,
  vector: number[]
): DocumentChunk {
  const parsed = parseMetadata(content);

  return {
    content,
    startLine,
    endLine,
    vector,
    url: baseMetadata.url,
    title: baseMetadata.title,
    path: baseMetadata.path,
    metadata: {
      type: parsed.contentType,
      props: parsed.props.length > 0 ? parsed.props : undefined,
      codeBlocks: parsed.codeBlocks.length > 0 ? parsed.codeBlocks : undefined
    }
  };
}

async function* semanticChunker(
  content: string,
  maxChunkSize: number,
  embeddings: EmbeddingsProvider,
  metadata: {
    url: string;
    title: string;
    path: string;
  }
): AsyncGenerator<DocumentChunk> {
  if (content.trim().length === 0) {
    return;
  }

  // Split content into semantic sections (paragraphs, lists, code blocks)
  const sections = content.split(/(?:\r?\n){2,}/);
  let currentChunk = '';
  let startLine = 0;
  let currentLine = 0;
  let tokenCount = 0;

  for (const section of sections) {
    const sectionLines = section.split('\n');
    const sectionText = section.trim();

    if (sectionText.length === 0) {
      currentLine += sectionLines.length;
      continue;
    }

    // Estimate token count (rough approximation: 4 chars per token)
    const sectionTokens = Math.ceil(sectionText.length / 4);

    // If section alone is too large, split it further
    if (sectionTokens > maxChunkSize) {
      // First yield current chunk if not empty
      if (currentChunk.trim().length > 0) {
        const vector = await embeddings.embed(currentChunk);
        yield createChunkWithMetadata(currentChunk.trim(), metadata, startLine, currentLine - 1, vector);
        currentChunk = '';
      }

      // Split large section by sentences
      const sentences = sectionText.match(/[^.!?]+[.!?]+/g) || [sectionText];
      let sentenceChunk = '';
      let sentenceTokens = 0;

      for (const sentence of sentences) {
        const nextTokens = Math.ceil(sentence.length / 4);

        if (sentenceTokens + nextTokens > maxChunkSize - 5) {
          if (sentenceChunk.trim().length > 0) {
            const vector = await embeddings.embed(sentenceChunk);
            yield createChunkWithMetadata(
              sentenceChunk.trim(),
              metadata,
              currentLine,
              currentLine + sentenceChunk.split('\n').length - 1,
              vector
            );
          }
          sentenceChunk = sentence;
          sentenceTokens = nextTokens;
        } else {
          sentenceChunk += ' ' + sentence;
          sentenceTokens += nextTokens;
        }
      }

      // Yield remaining sentence chunk
      if (sentenceChunk.trim().length > 0) {
        const vector = await embeddings.embed(sentenceChunk);
        yield createChunkWithMetadata(
          sentenceChunk.trim(),
          metadata,
          currentLine,
          currentLine + sentenceChunk.split('\n').length - 1,
          vector
        );
      }
    }
    // If adding section would exceed limit, yield current chunk and start new one
    else if (tokenCount + sectionTokens > maxChunkSize - 5) {
      if (currentChunk.trim().length > 0) {
        const vector = await embeddings.embed(currentChunk);
        yield createChunkWithMetadata(currentChunk.trim(), metadata, startLine, currentLine - 1, vector);
      }
      currentChunk = sectionText;
      tokenCount = sectionTokens;
      startLine = currentLine;
    }
    // Otherwise add section to current chunk
    else {
      if (currentChunk.length > 0) {
        currentChunk += '\n\n';
      }
      currentChunk += sectionText;
      tokenCount += sectionTokens;
    }

    currentLine += sectionLines.length;
  }

  // Yield final chunk if not empty
  if (currentChunk.trim().length > 0) {
    const vector = await embeddings.embed(currentChunk);
    yield createChunkWithMetadata(currentChunk.trim(), metadata, startLine, currentLine - 1, vector);
  }
}

export class WebDocumentProcessor implements DocumentProcessor {
  constructor(
    private readonly embeddings: EmbeddingsProvider,
    private readonly maxChunkSize: number = 1000
  ) {}

  async process(crawlResult: CrawlResult): Promise<ProcessedDocument> {
    logger.debug(`[WebDocumentProcessor] Processing ${crawlResult.url}`);
    logger.debug(`[WebDocumentProcessor] Content length: ${crawlResult.content.length} bytes`);
    logger.debug(`[WebDocumentProcessor] Extractor used: ${crawlResult.extractorUsed || 'unknown'}`);

    try {
      // Determine content type and process accordingly
      let processedContent;

      // Check if content was extracted by a formatter that outputs markdown
      const isFormattedContent = crawlResult.extractorUsed &&
        FORMATTED_CONTENT_EXTRACTORS.includes(crawlResult.extractorUsed);

      if (isFormattedContent) {
        // Content is already formatted markdown from a custom extractor
        logger.debug(`[WebDocumentProcessor] Using extracted content processor for ${crawlResult.extractorUsed}`);
        processedContent = await processExtractedContent(crawlResult);
      } else if (isMarkdownPath(crawlResult.path)) {
        // Raw markdown file
        logger.debug(`[WebDocumentProcessor] Using markdown processor for ${crawlResult.path}`);
        processedContent = await processMarkdownContent(crawlResult);
      } else {
        // Raw HTML - needs parsing
        logger.debug(`[WebDocumentProcessor] Using HTML processor for ${crawlResult.path}`);
        processedContent = await processHtmlContent(crawlResult);
      }

      if (!processedContent) {
        logger.error(`[WebDocumentProcessor] Failed to parse document content for ${crawlResult.url}`);
        throw new Error('Failed to parse document content');
      }

      logger.debug(`[WebDocumentProcessor] Successfully processed content for ${crawlResult.url}`);
      logger.debug(`[WebDocumentProcessor] Found ${processedContent.article.components.length} components`);
      logger.debug(`[WebDocumentProcessor] Creating chunks for ${processedContent.article.title}`);

      const chunks: DocumentChunk[] = [];
      let totalChunks = 0;

      const metadata = {
        url: processedContent.article.url,
        title: processedContent.article.title,
        path: processedContent.article.path
      };

      // Process each component separately
      for (const component of processedContent.article.components) {
        logger.debug(`[WebDocumentProcessor] Processing component: ${component.title}`);
        logger.debug(`[WebDocumentProcessor] Component body length: ${component.body.length} bytes`);

        const componentContent = `${component.title}\n\n${component.body}`;
        for await (const chunk of semanticChunker(componentContent, this.maxChunkSize, this.embeddings, metadata)) {
          chunks.push(chunk);
          totalChunks++;
        }
      }

      logger.debug(`[WebDocumentProcessor] Created ${totalChunks} chunks`);

      if (chunks.length === 0) {
        logger.warn(`[WebDocumentProcessor] No valid chunks were created for ${crawlResult.url}`);
        logger.warn(`[WebDocumentProcessor] Original content length: ${crawlResult.content.length}`);
        logger.warn(`[WebDocumentProcessor] Processed content length: ${processedContent.content.length}`);
        throw new Error('No valid chunks were created');
      }

      logger.debug(`[WebDocumentProcessor] Successfully processed ${crawlResult.url}`);
      return {
        metadata: {
          url: crawlResult.url,
          title: processedContent.article.title,
          lastIndexed: new Date()
        },
        chunks
      };
    } catch (error) {
      logger.error(`[WebDocumentProcessor] Error processing ${crawlResult.url}:`, error);
      logger.error(`[WebDocumentProcessor] Error details:`, error instanceof Error ? error.stack : error);
      throw error;
    }
  }
}
