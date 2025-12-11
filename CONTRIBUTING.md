# Contributing to MCP Web Docs

Thank you for your interest in contributing to MCP Web Docs! This document provides guidelines and instructions for contributing to the project.

## Table of Contents

- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Code Style](#code-style)
- [Commit Conventions](#commit-conventions)
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

## Commit Conventions

This project uses [semantic-release](https://semantic-release.gitbook.io/) for automated versioning and release notes generation. Your commit messages directly impact the changelog and version bumps, so please follow these conventions carefully.

### Commit Message Format

We follow the [Conventional Commits](https://www.conventionalcommits.org/) specification:

```
<type>(<scope>): <subject>

<body>

<footer>
```

- **type**: The type of change (see below)
- **scope**: Optional, the area of the codebase affected (e.g., `crawler`, `storage`, `auth`)
- **subject**: A short description of the change (imperative mood, no period)
- **body**: Optional, detailed description of the change
- **footer**: Optional, for breaking changes or issue references

### Commit Types and Release Impact

| Type | Description | Release Impact |
|------|-------------|----------------|
| `feat` | A new feature | **Minor** version bump (1.x.0) |
| `fix` | A bug fix | **Patch** version bump (1.0.x) |
| `perf` | Performance improvement | **Patch** version bump |
| `docs` | Documentation only | No release |
| `style` | Code style (formatting, etc.) | No release |
| `refactor` | Code change that neither fixes nor adds | No release |
| `test` | Adding or updating tests | No release |
| `chore` | Maintenance tasks | No release |
| `ci` | CI/CD changes | No release |
| `build` | Build system changes | No release |

### Commit Strategy for Pull Requests

**For feature PRs:**

1. **Primary commit** — Use `feat` prefix for the main feature:
   ```
   feat(auth): add session validation and auth requirement tracking
   ```

2. **Follow-up fixes within the same PR** — Use `chore` or `refactor` for bug fixes or improvements to your new feature:
   ```
   chore(auth): fix typo in session validation logic
   refactor(auth): simplify cookie expiration check
   ```

   This ensures only the main feature appears in release notes, not every small fix you made while developing it.

3. **Unrelated bug fixes** — If you discover and fix a bug unrelated to your feature, use `fix`:
   ```
   fix(storage): handle null values in document metadata
   ```

**For bug fix PRs:**

- Use `fix` prefix for the primary commit:
  ```
  fix(crawler): prevent infinite loop on circular redirects
  ```

**For documentation/maintenance PRs:**

- Use `docs`, `chore`, `refactor`, etc. as appropriate

### Writing Good Commit Bodies

The commit body is included in release notes, so write it for your users! Use it to explain:
- What the change does and why
- Any important details or caveats
- Sub-features or components (use `-` for bullet points)

**Example:**

```
feat(auth): add session validation and auth requirement tracking

Enhanced session validation to detect expired sessions before crawling,
and track authentication requirements in the database for reliable
re-indexing of protected documentation sites.

Session Validation:
- Add fast cookie expiration check before browser-based validation
- Detect expired auth cookies by checking timestamp vs current time
- Clear expired sessions and prompt user to re-authenticate

Auth Requirement Tracking:
- Add requiresAuth and authDomain fields to DocumentMetadata
- Store auth requirements in SQLite when indexing authenticated sites
- Automatically detect and mark sites that have existing sessions
```

### Breaking Changes

For breaking changes, add `BREAKING CHANGE:` in the commit footer:

```
feat(api): change search result format

BREAKING CHANGE: The search results now return an array of objects
instead of a flat array. Update your code to handle the new format.
```

This triggers a **major** version bump (x.0.0).

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