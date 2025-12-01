import { AssembledContext } from "./context-assembler.js";
import { QueryIntent, QueryIntentType } from "./query-processor.js";
import OpenAI from "openai";

export interface GeneratedResponse {
  text: string;
  codeExamples?: string[];
  metadata: {
    sources: string[];
    confidence: number;
    generatedAt: Date;
  };
}

export class ResponseGenerator {
  private openai: OpenAI;

  constructor(apiKey: string) {
    this.openai = new OpenAI({ apiKey });
  }

  async generateResponse(context: AssembledContext, queryIntent: QueryIntent): Promise<GeneratedResponse> {
    // Prepare context for the response
    const contextSummary = this.prepareContext(context, queryIntent);

    // Generate response using OpenAI
    const completion = await this.openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content: `${this.getSystemPrompt(queryIntent.intent)}

          Return your response in JSON format:
          {
            "response": "your detailed response text",
            "codeExamples": ["array of relevant code examples"],
            "metadata": {
              "relevance": "number between 0 and 1 indicating response relevance",
              "sources": ["array of source identifiers used"]
            }
          }`
        },
        {
          role: "user",
          content: `Context:\n${contextSummary}\n\nQuery Intent: ${queryIntent.intent}\nEntities: ${queryIntent.entities.join(", ")}\n\nGenerate a comprehensive response.`
        }
      ],
      temperature: 0.7,
      max_tokens: 1000
    });

    const content = completion.choices[0].message.content;
    if (!content) {
      throw new Error("No content returned from OpenAI");
    }

    const result = JSON.parse(content);
    return {
      text: result.response,
      codeExamples: result.codeExamples || [],
      metadata: {
        sources: this.getSources(context),
        confidence: result.metadata.relevance,
        generatedAt: new Date()
      }
    };
  }

  private prepareContext(context: AssembledContext, queryIntent: QueryIntent): string {
    const relevantChunks = context.hierarchicalContext
      .filter(chunk => this.isRelevantForIntent(chunk.metadata.type, queryIntent.intent))
      .map(chunk => ({
        content: chunk.content,
        type: chunk.metadata.type,
        reliability: chunk.metadata.sourceReliability
      }))
      .sort((a, b) => b.reliability - a.reliability);

    return relevantChunks
      .map(chunk => `[${chunk.type}]\n${chunk.content}`)
      .join('\n\n');
  }

  private getSystemPrompt(intent: QueryIntentType): string {
    const basePrompt = "You are a technical documentation assistant. Generate clear, accurate responses based on the provided context.";

    const intentPrompts: Record<QueryIntentType, string> = {
      overview: `${basePrompt}\nProvide a comprehensive overview of the topic, covering key features and concepts.`,
      api: `${basePrompt}\nProvide detailed API documentation, including parameters, return types, and examples.`,
      example: `${basePrompt}\nCreate practical code examples that demonstrate proper usage and common patterns.`,
      usage: `${basePrompt}\nFocus on explaining how to use components effectively, including props, configurations, and best practices.`,
      component_usage: `${basePrompt}\nFocus on explaining how to use components effectively, including props, configurations, and best practices.`,
      concept: `${basePrompt}\nExplain technical concepts clearly, using analogies and examples where appropriate.`,
      troubleshooting: `${basePrompt}\nHelp diagnose and solve problems, providing step-by-step solutions and common pitfalls to avoid.`,
      general: basePrompt
    };

    return intentPrompts[intent];
  }

  private isRelevantForIntent(chunkType: string, intent: QueryIntentType): boolean {
    const relevanceMap: Record<QueryIntentType, string[]> = {
      overview: ['overview', 'usage', 'api'],
      api: ['api', 'overview', 'example'],
      example: ['example', 'usage', 'api'],
      usage: ['usage', 'overview', 'example'],
      component_usage: ['usage', 'overview', 'example'],
      concept: ['overview', 'api', 'example'],
      troubleshooting: ['example', 'usage', 'api'],
      general: ['overview', 'usage', 'example', 'api']
    };

    return relevanceMap[intent].includes(chunkType);
  }

  private getSources(context: AssembledContext): string[] {
    const sources = new Set<string>();
    for (const chunk of context.hierarchicalContext) {
      if (chunk.metadata.citationInfo.version) {
        sources.add(`${chunk.metadata.citationInfo.version}`);
      }
    }
    return Array.from(sources);
  }
}
