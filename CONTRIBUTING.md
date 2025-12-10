# Contributing to MCP Web Docs

Thank you for your interest in contributing to MCP Web Docs! This document provides guidelines and instructions for contributing to the project.

## Table of Contents

- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Code Style](#code-style)
- [Testing](#testing)
- [Adding New Features](#adding-new-features)
- [Pull Request Process](#pull-request-process)
- [Additional Resources](#additional-resources)

---

## Getting Started

1. **Fork the repository** on GitHub

2. **Clone your fork**
   ```bash
   git clone https://github.com/YOUR-USERNAME/mcp-web-docs.git
   cd mcp-web-docs
   ```

3. **Install dependencies** (automatically installs Playwright browsers)
   ```bash
   npm install
   ```

4. **Create a feature branch**
   ```bash
   git checkout -b feature/amazing-feature
   ```

---

## Development Setup

### Prerequisites

- Node.js >= 22.19.0

### Key Commands

```bash
npm run build         # Build TypeScript
npm run dev           # Watch mode compilation
npm run lint          # Run ESLint
npm run prettier      # Format code
npm run clean         # Remove build artifacts
npm test              # Run tests
npm run test:watch    # Run tests in watch mode
npm run test:coverage # Run tests with coverage report
npm run test:types    # Type check without emitting
```

### Project Structure

```
src/
├── index.ts          # Main MCP server (WebDocsServer class)
├── config.ts         # Configuration loading
├── types.ts          # TypeScript interfaces
├── crawler/          # Web crawling (Playwright/Crawlee)
├── processor/        # Content processing (HTML, Markdown)
├── storage/          # SQLite + LanceDB storage
├── embeddings/       # FastEmbed vector generation
├── indexing/         # Status tracking, queue management
└── util/             # Logger, security, helpers
```

---

## Code Style

### TypeScript Guidelines

- Use TypeScript with strict mode enabled
- **Always use `.js` extensions in imports** (ESM requirement)
  ```typescript
  // ✅ Correct
  import { Something } from './module.js';

  // ❌ Wrong
  import { Something } from './module';
  ```
- Use interfaces for data shapes, types for unions/intersections
- Explicit return types for public APIs
- No unused locals/parameters

### Formatting

- Run `npm run prettier` to format code before committing
- Run `npm run lint` to check for linting issues

### Important Constraints

- **Never log to stdout** - MCP servers use stdio for JSON-RPC communication
- Use the logger from `src/util/logger.ts` (writes to stderr)
- Validate all user inputs with Zod schemas from `src/util/security.ts`
- Use `validatePublicUrl()` for SSRF protection on user-provided URLs

---

## Testing

### Test Framework

We use **Vitest** with global test APIs (`describe`, `it`, `expect`, `vi`).

### Test File Location

Tests are co-located with source files: `*.test.ts` next to the source file.
- Example: `src/config.ts` → `src/config.test.ts`

### Writing Tests

```typescript
describe('ModuleName', () => {
  describe('functionOrMethod', () => {
    it('should do expected behavior', () => {
      // Arrange
      const input = 'test';

      // Act
      const result = functionUnderTest(input);

      // Assert
      expect(result).toBe('expected');
    });
  });
});
```

### Mocking

Use the mock embeddings provider for storage/search tests:
```typescript
import { createMockEmbeddings } from '../__mocks__/embeddings.js';
const mockEmbeddings = createMockEmbeddings();
```

Use `vi.hoisted()` for mocks that need to be configured before imports:
```typescript
const { mockFn } = vi.hoisted(() => ({ mockFn: vi.fn() }));
vi.mock('module', () => ({ default: mockFn }));
```

See [AGENTS.md](AGENTS.md) for detailed mocking strategies.

---

## Adding New Features

### Adding a New Content Extractor

1. Create extractor in `src/crawler/`:
   ```typescript
   // my-extractor.ts
   import type { ContentExtractor, ExtractionResult } from './content-extractor-types.js';

   export const MyExtractor: ContentExtractor = {
     name: 'MyExtractor',

     detect(url: string, $: cheerio.CheerioAPI): boolean {
       return url.includes('my-site.com');
     },

     async extract(url: string, $: cheerio.CheerioAPI): Promise<ExtractionResult> {
       return {
         title: 'Page Title',
         content: 'Extracted markdown content',
       };
     },
   };
   ```

2. Register in `src/crawler/content-extractors.ts`

3. Add to `FORMATTED_CONTENT_EXTRACTORS` in `src/processor/processor.ts`

4. Write tests in `src/crawler/my-extractor.test.ts`

### Adding a New Tool

1. Define input schema in `src/util/security.ts`:
   ```typescript
   export const MyToolArgsSchema = z.object({
     param1: z.string().min(1),
     param2: z.number().optional(),
   });
   ```

2. Add tool definition in `src/index.ts` `setupToolHandlers()`:
   ```typescript
   {
     name: 'my_tool',
     description: 'Tool description',
     inputSchema: { /* JSON Schema */ },
   }
   ```

3. Add handler method and case in switch statement

4. Write tests in `src/index.test.ts`

### Adding a Database Migration

When you need to modify the SQLite schema (e.g., adding new columns), use the migration system in `src/storage/storage.ts`:

1. Add a new entry to the `MIGRATIONS` array with an incremented version number:
   ```typescript
   {
     version: 2, // Next version number
     description: 'Add my_column to documents table',
     sql: `ALTER TABLE documents ADD COLUMN my_column TEXT;`,
   }
   ```

2. Update `DocumentMetadata` in `src/types.ts` if needed

3. Update storage methods (`addDocument`, `getDocument`, `listDocuments`) to handle the new field

4. Write tests to verify the migration works

Migrations run automatically on server startup and are tracked in the `schema_migrations` table.

---

## Pull Request Process

### Before Submitting

Run all checks:
```bash
npm run lint          # Linting passes
npm run prettier      # Code is formatted
npm run build         # TypeScript compiles
npm test              # All tests pass
npm run test:types    # Types check
```

### Checklist

- [ ] Code follows existing patterns and style
- [ ] Tests added for new functionality
- [ ] All tests pass
- [ ] Linting passes
- [ ] Types check
- [ ] Code is formatted with Prettier
- [ ] Documentation updated if needed

### Submitting

1. Push your changes to your fork
2. Create a Pull Request against the main repository
3. Fill in the PR template with a clear description of your changes
4. Wait for review and address any feedback

---

## Additional Resources

- **[AGENTS.md](AGENTS.md)** - Comprehensive guidelines for AI coding agents, includes detailed architecture, testing patterns, and mocking strategies
- **[README.md](README.md)** - Project overview and user documentation

---

## Maintaining Agent Guidelines

When making significant changes to the codebase, ask if the agent instruction files need updating:
- `AGENTS.md`, `CONTRIBUTING.md`, `.cursorrules`, `CLAUDE.md`, `.roo/rules/01-project-rules.md`

---

## Questions?

If you have questions about contributing, feel free to open an issue for discussion.