// Utility function for cleaning regular content
export function cleanContent(text: string): string {
  return text
    .replace(/\\n/g, '\n') // Convert escaped newlines
    .replace(/\r\n/g, '\n') // Normalize line endings
    .replace(/\t/g, '  ') // Convert tabs to spaces
    .replace(/[^\S\n]+/g, ' ') // Replace multiple spaces with single space (except newlines)
    .split('\n')
    .map((line) => line.trimEnd()) // Only trim trailing whitespace, preserve indentation
    .join('\n')
    .replace(/\n{3,}/g, '\n\n') // Max 2 consecutive newlines
    .trim();
}
