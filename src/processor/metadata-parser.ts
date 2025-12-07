/**
 * Parses structured metadata (props, code blocks) from markdown content.
 * Used to populate chunk metadata fields for better search results.
 */

import { logger } from '../util/logger.js';

export interface ParsedProp {
  name: string;
  type: string;
  required: boolean;
  defaultValue?: string;
  description: string;
}

export interface ParsedCodeBlock {
  code: string;
  language: string;
  context: string;
}

export interface ParsedMetadata {
  props: ParsedProp[];
  codeBlocks: ParsedCodeBlock[];
  contentType: 'overview' | 'api' | 'example' | 'usage';
}

/**
 * Split a table row by pipe character, handling escaped pipes (\ |)
 */
function splitTableRow(line: string): string[] {
  // Replace escaped pipes with a placeholder
  const placeholder = '\x00PIPE\x00';
  const escaped = line.replace(/\\ \||\\\|/g, placeholder);

  // Split by unescaped pipe
  const cells = escaped.split('|').map((cell) => cell.trim().replace(new RegExp(placeholder, 'g'), '|'));

  // Remove empty first/last cells from | at start/end
  if (cells[0] === '') cells.shift();
  if (cells[cells.length - 1] === '') cells.pop();

  return cells;
}

/**
 * Check if a line is a table separator (|---|---|...)
 */
function isTableSeparator(line: string): boolean {
  return /^\|?[\s-:|]+\|?$/.test(line.trim());
}

/**
 * Parse a markdown table into rows of key-value pairs
 * Handles tables with blank lines between rows and escaped pipes
 */
function parseMarkdownTable(tableLines: string[]): Record<string, string>[] {
  if (tableLines.length < 2) return [];

  // Find header row (first non-empty row with pipes)
  const headerIndex = tableLines.findIndex((l) => l.includes('|') && !isTableSeparator(l));
  if (headerIndex === -1) return [];

  const headers = splitTableRow(tableLines[headerIndex]).map((h) => h.toLowerCase().trim());
  if (headers.length === 0) return [];

  // Find separator (skip it)
  const separatorIndex = tableLines.findIndex((l, i) => i > headerIndex && isTableSeparator(l));

  // Get data rows (everything after separator that contains pipes)
  const dataLines = tableLines.slice(separatorIndex + 1).filter((l) => l.includes('|') && !isTableSeparator(l));

  const results: Record<string, string>[] = [];

  for (const line of dataLines) {
    const cells = splitTableRow(line);
    if (cells.length >= 1) {
      const row: Record<string, string> = {};
      headers.forEach((header, i) => {
        if (header) {
          row[header] = cells[i] || '';
        }
      });
      // Only add if we got at least the name column
      if (row['name'] || row['prop'] || row['property']) {
        results.push(row);
      }
    }
  }

  return results;
}

/**
 * Extract props from markdown content containing a props table
 */
export function extractProps(content: string): ParsedProp[] {
  const props: ParsedProp[] = [];
  const seenNames = new Set<string>();

  // Split content into lines for table detection
  const lines = content.split('\n');

  // Find Props section and extract table
  let inPropsSection = false;
  let tableLines: string[] = [];
  let foundTable = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmedLine = line.trim();

    // Check for Props heading
    if (/^#{1,3}\s*Props\s*$/i.test(trimmedLine)) {
      inPropsSection = true;
      tableLines = [];
      continue;
    }

    // Check for any table with Name column (might not have Props heading)
    if (trimmedLine.startsWith('|') && /\|\s*Name\s*\|/i.test(trimmedLine) && !foundTable) {
      inPropsSection = true;
      tableLines = [trimmedLine];
      continue;
    }

    // If in props section, collect table lines
    if (inPropsSection) {
      // End of props section on new heading
      if (trimmedLine.startsWith('#') && !trimmedLine.toLowerCase().includes('prop')) {
        // Process collected table
        if (tableLines.length >= 2) {
          foundTable = true;
          const rows = parseMarkdownTable(tableLines);
          for (const row of rows) {
            const name = (row['name'] || row['prop'] || row['property'] || '').replace(/[*`"]/g, '').trim();
            const type = (row['type'] || row['types'] || row['description'] || '').replace(/[`"]/g, '').trim();
            const description = row['description'] || row['desc'] || '';
            const defaultVal = row['default'] || row['defaultvalue'] || '';

            if (name && name !== '-' && !seenNames.has(name)) {
              seenNames.add(name);
              props.push({
                name,
                type,
                required: name.includes('*') || type.includes('required'),
                defaultValue: defaultVal && defaultVal !== '-' ? defaultVal.replace(/[`"]/g, '') : undefined,
                description: description.trim(),
              });
            }
          }
        }
        inPropsSection = false;
        tableLines = [];
        continue;
      }

      // Collect table lines (including empty lines within table)
      if (trimmedLine.includes('|') || trimmedLine === '') {
        tableLines.push(trimmedLine);
      }
    }
  }

  // Process any remaining table
  if (tableLines.length >= 2) {
    const rows = parseMarkdownTable(tableLines);
    for (const row of rows) {
      const name = (row['name'] || row['prop'] || row['property'] || '').replace(/[*`"]/g, '').trim();
      const type = (row['type'] || row['types'] || row['description'] || '').replace(/[`"]/g, '').trim();
      const description = row['description'] || row['desc'] || '';
      const defaultVal = row['default'] || row['defaultvalue'] || '';

      if (name && name !== '-' && !seenNames.has(name)) {
        seenNames.add(name);
        props.push({
          name,
          type,
          required: name.includes('*') || type.includes('required'),
          defaultValue: defaultVal && defaultVal !== '-' ? defaultVal.replace(/[`"]/g, '') : undefined,
          description: description.trim(),
        });
      }
    }
  }

  // Fallback: try to extract from inline patterns if no table found
  if (props.length === 0) {
    const inlinePropsRegex = /[`*](\w+)[`*]\s*[-–:]\s*([^(\n]+?)(?:\s*\((?:type[:\s]*)?([^)]+)\))?(?:\n|$)/gi;
    let inlineMatch;
    while ((inlineMatch = inlinePropsRegex.exec(content)) !== null) {
      const name = inlineMatch[1];
      const description = inlineMatch[2].trim();
      const type = inlineMatch[3]?.trim() || '';

      if (name && !seenNames.has(name)) {
        seenNames.add(name);
        props.push({
          name,
          type,
          required: false,
          description,
        });
      }
    }
  }

  logger.debug(`[MetadataParser] Extracted ${props.length} props from content`);
  return props;
}

/**
 * Extract code blocks from markdown content
 */
export function extractCodeBlocks(content: string): ParsedCodeBlock[] {
  const codeBlocks: ParsedCodeBlock[] = [];

  // Match fenced code blocks with optional language
  const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g;

  let match;
  let prevIndex = 0;

  while ((match = codeBlockRegex.exec(content)) !== null) {
    const language = match[1] || 'plaintext';
    const code = match[2].trim();

    // Get context: text before the code block (last heading or paragraph)
    const textBefore = content.slice(Math.max(0, prevIndex), match.index);
    const lines = textBefore
      .trim()
      .split('\n')
      .filter((l) => l.trim());
    let context = '';

    // Find the closest heading or meaningful text
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line.startsWith('#')) {
        context = line.replace(/^#+\s*/, '');
        break;
      } else if (line.length > 10 && !line.startsWith('|')) {
        context = line.slice(0, 100);
        break;
      }
    }

    if (code.length > 0) {
      codeBlocks.push({
        code,
        language,
        context,
      });
    }

    prevIndex = match.index + match[0].length;
  }

  logger.debug(`[MetadataParser] Extracted ${codeBlocks.length} code blocks from content`);
  return codeBlocks;
}

/**
 * Determine the content type based on content analysis
 */
export function determineContentType(content: string): 'overview' | 'api' | 'example' | 'usage' {
  const lowerContent = content.toLowerCase();

  // Check for API documentation patterns
  if (
    lowerContent.includes('props') ||
    lowerContent.includes('parameters') ||
    lowerContent.includes('arguments') ||
    lowerContent.includes('returns') ||
    lowerContent.includes('type:') ||
    /\|\s*name\s*\|.*\|\s*type\s*\|/i.test(content)
  ) {
    return 'api';
  }

  // Check for example patterns
  if (lowerContent.includes('example') || lowerContent.includes('usage example') || (content.match(/```/g)?.length || 0) > 2) {
    return 'example';
  }

  // Check for usage patterns
  if (lowerContent.includes('how to use') || lowerContent.includes('getting started') || lowerContent.includes('installation')) {
    return 'usage';
  }

  return 'overview';
}

/**
 * Parse all metadata from markdown content
 */
export function parseMetadata(content: string): ParsedMetadata {
  return {
    props: extractProps(content),
    codeBlocks: extractCodeBlocks(content),
    contentType: determineContentType(content),
  };
}
