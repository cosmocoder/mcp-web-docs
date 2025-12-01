import { EmbeddingsProvider } from "../embeddings/types.js";
import OpenAI from "openai";

export type QueryIntentType =
  | 'overview'          // General overview
  | 'api'              // API documentation
  | 'example'          // Example code
  | 'usage'            // How to use a component
  | 'component_usage'  // Alternative for usage
  | 'concept'          // Conceptual explanation
  | 'troubleshooting'  // Error or problem solving
  | 'general';         // General query

export interface QueryIntent {
  embedding: number[];
  intent: QueryIntentType;
  entities: string[];
  confidence: number;
}

export class QueryProcessor {
  private openai: OpenAI;
  private embeddings: EmbeddingsProvider;

  constructor(apiKey: string, embeddings: EmbeddingsProvider) {
    this.openai = new OpenAI({ apiKey });
    this.embeddings = embeddings;
  }

  async processQuery(query: string): Promise<QueryIntent> {
    // Generate embedding for semantic search
    const embedding = await this.embeddings.embed(query);

    // Classify intent using OpenAI
    const completion = await this.openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content: `You are a query intent classifier for a documentation search system.

          Your task is to analyze the query and return a JSON response with the following fields:
          {
            "intent": "one of: overview, api, example, usage, component_usage, concept, troubleshooting, general",
            "entities": ["array of extracted entities like component names, function names, concepts"],
            "confidence": "number between 0 and 1"
          }

          Intent categories:
          - overview: General overview or introduction to a topic
          - api: API documentation and reference
          - example: Code examples and demonstrations
          - usage: How to use features or components
          - component_usage: Specific component usage (alternative to usage)
          - concept: Conceptual explanations and principles
          - troubleshooting: Error resolution and debugging
          - general: General queries that don't fit other categories`
        },
        {
          role: "user",
          content: query
        }
      ],
      response_format: { type: "json_object" }
    });

    const content = completion.choices[0].message.content;
    if (!content) {
      throw new Error("No content returned from OpenAI");
    }
    const result = JSON.parse(content);

    return {
      embedding,
      intent: result.intent as QueryIntentType,
      entities: result.entities,
      confidence: result.confidence
    };
  }
}
