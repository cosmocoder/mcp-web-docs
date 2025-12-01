import { GeneratedResponse } from "./response-generator.js";
import { AssembledContext } from "./context-assembler.js";
import OpenAI from "openai";

export interface ValidationResult {
  factCheck: boolean;
  codeCheck: boolean;
  consistencyCheck: boolean;
  details: {
    factCheckDetails: string[];
    codeCheckDetails: string[];
    consistencyCheckDetails: string[];
  };
}

export class ResponseValidator {
  private openai: OpenAI;

  constructor(apiKey: string) {
    this.openai = new OpenAI({ apiKey });
  }

  async validateResponse(response: GeneratedResponse, context: AssembledContext): Promise<ValidationResult> {
    const [factCheck, codeCheck, consistencyCheck] = await Promise.all([
      this.validateFacts(response, context),
      this.validateCode(response),
      this.validateConsistency(response, context)
    ]);

    return {
      factCheck: factCheck.valid,
      codeCheck: codeCheck.valid,
      consistencyCheck: consistencyCheck.valid,
      details: {
        factCheckDetails: factCheck.details,
        codeCheckDetails: codeCheck.details,
        consistencyCheckDetails: consistencyCheck.details
      }
    };
  }

  private async validateFacts(response: GeneratedResponse, context: AssembledContext): Promise<{ valid: boolean; details: string[] }> {
    const completion = await this.openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content: `You are a fact-checking assistant. Compare the generated response against the source documentation and identify any factual inconsistencies or inaccuracies. Focus on technical accuracy and completeness.

          Return a JSON response in this format:
          {
            "isAccurate": true/false,
            "issues": ["array of identified issues or inconsistencies"]
          }`
        },
        {
          role: "user",
          content: `Source Documentation:\n${this.formatContext(context)}\n\nGenerated Response:\n${response.text}\n\nVerify the factual accuracy of the response.`
        }
      ],
      response_format: { type: "json_object" }
    });

    const result = JSON.parse(completion.choices[0].message.content || "{}");
    return {
      valid: result.isAccurate || false,
      details: result.issues || []
    };
  }

  private async validateCode(response: GeneratedResponse): Promise<{ valid: boolean; details: string[] }> {
    if (!response.codeExamples?.length) {
      return { valid: true, details: [] };
    }

    const issues: string[] = [];
    for (const example of response.codeExamples) {
      try {
        // Basic syntax validation
        Function(`"use strict";${example}`);

        // Check for common issues
        const commonIssues = this.checkCommonCodeIssues(example);
        issues.push(...commonIssues);
      } catch (error) {
        issues.push(`Syntax error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return {
      valid: issues.length === 0,
      details: issues
    };
  }

  private async validateConsistency(response: GeneratedResponse, context: AssembledContext): Promise<{ valid: boolean; details: string[] }> {
    const completion = await this.openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content: `You are a consistency checker. Verify that the response maintains consistency with the documentation context, uses consistent terminology, and provides a coherent explanation.

          Return a JSON response in this format:
          {
            "isConsistent": true/false,
            "issues": ["array of identified consistency issues"]
          }`
        },
        {
          role: "user",
          content: `Context:\n${this.formatContext(context)}\n\nResponse:\n${response.text}\n\nCheck for consistency issues.`
        }
      ],
      response_format: { type: "json_object" }
    });

    const result = JSON.parse(completion.choices[0].message.content || "{}");
    return {
      valid: result.isConsistent || false,
      details: result.issues || []
    };
  }

  private formatContext(context: AssembledContext): string {
    return context.hierarchicalContext
      .map(chunk => `[${chunk.metadata.type}]\n${chunk.content}`)
      .join('\n\n');
  }

  private checkCommonCodeIssues(code: string): string[] {
    const issues: string[] = [];

    // Check for undefined variables
    const undefinedVarRegex = /\b(?:let|const|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?:;|$)/;
    const matches = code.match(new RegExp(undefinedVarRegex, 'g'));
    if (matches) {
      const vars = matches.map(m => m.match(undefinedVarRegex)![1]);
      const unusedVars = vars.filter(v => !code.includes(v));
      if (unusedVars.length > 0) {
        issues.push(`Unused variables: ${unusedVars.join(', ')}`);
      }
    }

    // Check for missing error handling
    if (code.includes('async') && !code.includes('try') && !code.includes('catch')) {
      issues.push('Missing error handling in async code');
    }

    // Check for hardcoded values
    if (code.match(/(['"])(?:https?:\/\/|www\.)[^\s'"]+\1/)) {
      issues.push('Contains hardcoded URLs');
    }

    return issues;
  }
}
