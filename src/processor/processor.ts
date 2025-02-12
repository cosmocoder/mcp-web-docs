import { CrawlResult, DocumentChunk, DocumentProcessor, ProcessedDocument } from '../types.js';
import { EmbeddingsProvider } from '../embeddings/types.js';
import { processHtmlContent } from './content.js';
import { processMarkdownContent } from './markdown.js';
import { isMarkdownPath } from '../config.js';

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
        yield {
          content: currentChunk.trim(),
          startLine,
          endLine: currentLine - 1,
          vector,
          url: metadata.url,
          title: metadata.title,
          path: metadata.path,
          metadata: {
            type: 'overview'
          }
        };
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
            yield {
              content: sentenceChunk.trim(),
              startLine: currentLine,
              endLine: currentLine + sentenceChunk.split('\n').length - 1,
              vector,
              url: metadata.url,
              title: metadata.title,
              path: metadata.path,
              metadata: {
                type: 'overview'
              }
            };
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
        yield {
          content: sentenceChunk.trim(),
          startLine: currentLine,
          endLine: currentLine + sentenceChunk.split('\n').length - 1,
          vector,
          url: metadata.url,
          title: metadata.title,
          path: metadata.path,
          metadata: {
            type: 'overview'
          }
        };
      }
    }
    // If adding section would exceed limit, yield current chunk and start new one
    else if (tokenCount + sectionTokens > maxChunkSize - 5) {
      if (currentChunk.trim().length > 0) {
        const vector = await embeddings.embed(currentChunk);
        yield {
          content: currentChunk.trim(),
          startLine,
          endLine: currentLine - 1,
          vector,
          url: metadata.url,
          title: metadata.title,
          path: metadata.path,
          metadata: {
            type: 'overview'
          }
        };
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
    yield {
      content: currentChunk.trim(),
      startLine,
      endLine: currentLine - 1,
      vector,
      url: metadata.url,
      title: metadata.title,
      path: metadata.path,
      metadata: {
        type: 'overview'
      }
    };
  }
}

export class WebDocumentProcessor implements DocumentProcessor {
  constructor(
    private readonly embeddings: EmbeddingsProvider,
    private readonly maxChunkSize: number = 1000
  ) {}

  async process(crawlResult: CrawlResult): Promise<ProcessedDocument> {
    console.debug(`[WebDocumentProcessor] Processing ${crawlResult.url}`);
    console.debug(`[WebDocumentProcessor] Content length: ${crawlResult.content.length} bytes`);

    try {
      // Determine content type and process accordingly
      const processedContent = isMarkdownPath(crawlResult.path)
        ? await processMarkdownContent(crawlResult)
        : await processHtmlContent(crawlResult);

      if (!processedContent) {
        console.error(`[WebDocumentProcessor] Failed to parse document content for ${crawlResult.url}`);
        throw new Error('Failed to parse document content');
      }

      console.debug(`[WebDocumentProcessor] Successfully processed content for ${crawlResult.url}`);
      console.debug(`[WebDocumentProcessor] Found ${processedContent.article.components.length} components`);
      console.debug(`[WebDocumentProcessor] Creating chunks for ${processedContent.article.title}`);

      const chunks: DocumentChunk[] = [];
      let totalChunks = 0;

      const metadata = {
        url: processedContent.article.url,
        title: processedContent.article.title,
        path: processedContent.article.path
      };

      // Process each component separately
      for (const component of processedContent.article.components) {
        console.debug(`[WebDocumentProcessor] Processing component: ${component.title}`);
        console.debug(`[WebDocumentProcessor] Component body length: ${component.body.length} bytes`);

        const componentContent = `${component.title}\n\n${component.body}`;
        for await (const chunk of semanticChunker(componentContent, this.maxChunkSize, this.embeddings, metadata)) {
          chunks.push(chunk);
          totalChunks++;
        }
      }

      console.debug(`[WebDocumentProcessor] Created ${totalChunks} chunks`);

      if (chunks.length === 0) {
        console.error(`[WebDocumentProcessor] No valid chunks were created for ${crawlResult.url}`);
        console.debug(`[WebDocumentProcessor] Original content length: ${crawlResult.content.length}`);
        console.debug(`[WebDocumentProcessor] Processed content length: ${processedContent.content.length}`);
        throw new Error('No valid chunks were created');
      }

      console.debug(`[WebDocumentProcessor] Successfully processed ${crawlResult.url}`);
      return {
        metadata: {
          url: crawlResult.url,
          title: processedContent.article.title,
          lastIndexed: new Date()
        },
        chunks
      };
    } catch (error) {
      console.error(`[WebDocumentProcessor] Error processing ${crawlResult.url}:`, error);
      console.debug(`[WebDocumentProcessor] Error details:`, error instanceof Error ? error.stack : error);
      throw error;
    }
  }
}
