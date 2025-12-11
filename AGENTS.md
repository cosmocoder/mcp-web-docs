# MCP Web Docs - Agent Guidelines

This document provides comprehensive guidance for AI coding agents working on this project. It covers architecture, conventions, testing patterns, and best practices.

## Project Overview

**MCP Web Docs** is a self-hosted Model Context Protocol (MCP) server that crawls, indexes, and searches documentation from any website. It provides:

- Universal web crawling with Playwright/Crawlee
- Hybrid search (full-text + semantic/vector search)
- Authentication support for protected documentation sites
- Local embeddings generation using FastEmbed
- Persistent storage with LanceDB (vectors) and SQLite (metadata)

### Tech Stack

- **Runtime**: Node.js >= 22.19.0
- **Language**: TypeScript (ES2022, NodeNext modules)
- **Testing**: Vitest with coverage
- **Linting**: ESLint with TypeScript support
- **Formatting**: Prettier
- **Key Dependencies**:
  - `@modelcontextprotocol/sdk` - MCP server implementation
  - `crawlee` + `playwright` - Web crawling
  - `@lancedb/lancedb` - Vector database
  - `sqlite` + `sqlite3` - Metadata storage
  - `fastembed` - Local embedding generation
  - `zod` - Schema validation

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     MCP Web Docs Server                      │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │   Crawler   │  │  Processor  │  │      Storage        │  │
│  │  (Crawlee)  │  │ (Markdown,  │  │  ┌───────────────┐  │  │
│  │             │  │  HTML, etc) │  │  │   LanceDB     │  │  │
│  │ - Playwright│  │             │  │  │   (Vectors)   │  │  │
│  │ - Auth      │  │ - Chunking  │  │  └───────────────┘  │  │
│  │ - Extractors│  │ - Metadata  │  │  ┌───────────────┐  │  │
│  │             │  │ - Embedding │  │  │    SQLite     │  │  │
│  └─────────────┘  └─────────────┘  │  │  (Metadata)   │  │  │
│                                    │  └───────────────┘  │  │
└────────────────────────────────────┴─────────────────────┴──┘
```

### Data Flow

1. **Crawl**: `DocsCrawler` → `CrawleeCrawler` → yields `CrawlResult`
2. **Process**: `WebDocumentProcessor` → converts to `ProcessedDocument` with chunks
3. **Store**: `DocumentStore` → saves to SQLite (metadata) + LanceDB (vectors)
4. **Search**: Hybrid search combines FTS (full-text) + vector similarity

---

## Directory Structure

```
src/
├── index.ts              # Main MCP server entry point (WebDocsServer class)
├── config.ts             # Configuration loading and constants
├── types.ts              # TypeScript interfaces and types
├── setupTests.ts         # Vitest global test setup
│
├── __mocks__/
│   └── embeddings.ts     # Mock embeddings provider for tests
│
├── crawler/
│   ├── docs-crawler.ts   # High-level crawler orchestration
│   ├── crawlee-crawler.ts # Crawlee/Playwright implementation
│   ├── queue-manager.ts  # URL queue management
│   ├── auth.ts           # Authentication manager (browser login)
│   ├── browser-config.ts # Playwright browser configuration
│   ├── site-rules.ts     # Site-specific crawling rules
│   ├── content-extractors.ts # Extractor registry
│   ├── content-extractor-types.ts # Extractor interfaces
│   ├── default-extractor.ts  # Fallback content extractor
│   ├── storybook-extractor.ts # Storybook-specific extractor
│   ├── github-pages-extractor.ts # GitHub Pages extractor
│   └── github.ts         # GitHub API crawler (for repos)
│
├── processor/
│   ├── processor.ts      # Main document processor
│   ├── content.ts        # HTML content processing
│   ├── markdown.ts       # Markdown processing
│   └── metadata-parser.ts # Metadata extraction
│
├── embeddings/
│   ├── fastembed.ts      # FastEmbed provider implementation
│   └── types.ts          # EmbeddingsProvider interface
│
├── indexing/
│   ├── status.ts         # IndexingStatusTracker
│   └── queue-manager.ts  # IndexingQueueManager (operation coordination)
│
├── storage/
│   └── storage.ts        # DocumentStore (SQLite + LanceDB)
│
└── util/
    ├── logger.ts         # Logging utility
    ├── security.ts       # Security utilities (encryption, validation, etc.)
    ├── docs.ts           # Document ID generation
    └── favicon.ts        # Favicon fetching
```

---

## Module Responsibilities

### `src/index.ts` - WebDocsServer
The main MCP server class handling:
- Tool registration (`add_documentation`, `search_documentation`, etc.)
- Request handling and validation
- Progress notifications
- Background indexing orchestration

### `src/crawler/` - Web Crawling
- **`docs-crawler.ts`**: High-level crawler that delegates to `CrawleeCrawler` or `GitHubCrawler`
- **`crawlee-crawler.ts`**: Playwright-based crawler implementation
- **`auth.ts`**: `AuthManager` for interactive browser login and session persistence
- **`queue-manager.ts`**: URL queue management with deduplication
- **Extractors**: Site-specific content extraction (Storybook, GitHub Pages, etc.)

### `src/processor/` - Content Processing
- **`processor.ts`**: `WebDocumentProcessor` - converts `CrawlResult` to `ProcessedDocument`
- **`content.ts`**: HTML parsing with Cheerio, content extraction
- **`markdown.ts`**: Markdown-to-structured-content conversion

### `src/storage/` - Data Persistence
- **`storage.ts`**: `DocumentStore` class
  - SQLite for document metadata
  - LanceDB for vector storage and search
  - Hybrid search (FTS + semantic)
  - LRU cache for search results
  - Database migration system for schema changes

### `src/embeddings/` - Vector Generation
- **`fastembed.ts`**: `FastEmbeddings` provider using the `fastembed` library
- **`types.ts`**: `EmbeddingsProvider` interface

### `src/util/` - Utilities
- **`security.ts`**: Critical security functions:
  - `validatePublicUrl()` - SSRF protection
  - `encryptData()`/`decryptData()` - Session encryption
  - `detectPromptInjection()` - Content scanning
  - `validateToolArgs()` - Zod schema validation
  - `sanitizeErrorMessage()` - Error message redaction
- **`logger.ts`**: Logging with level control
- **`docs.ts`**: `generateDocId()` for stable document IDs

---

## Testing Patterns

### Test File Naming
- Tests are co-located with source files: `*.test.ts`
- Example: `src/config.ts` → `src/config.test.ts`

### Test Framework
- **Vitest** with global test APIs (`describe`, `it`, `expect`, `vi`)
- Configuration in `vitest.config.ts`
- Global setup in `src/setupTests.ts`

### Test Structure
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

    it('should handle edge case', () => {
      // ...
    });
  });
});
```

### Async Testing
```typescript
it('should handle async operations', async () => {
  const result = await asyncFunction();
  expect(result).toBeDefined();
});
```

### Test Isolation
- Each test file runs in isolation
- `beforeEach`/`afterEach` for setup/cleanup
- Temporary directories for file-based tests:
```typescript
let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'test-prefix-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});
```

---

## Mocking Strategies

### 1. Global Mocks (setupTests.ts)
Mocks applied to all tests:
```typescript
// Mock logger to prevent console output
vi.mock('./util/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock cli-progress
vi.mock('cli-progress', () => ({
  SingleBar: class MockSingleBar { /* ... */ },
  MultiBar: class MockMultiBar { /* ... */ },
}));
```

### 2. Module Mocks with vi.mock()
For external dependencies:
```typescript
vi.mock('playwright', () => ({
  chromium: { launch: vi.fn() },
  firefox: { launch: vi.fn() },
}));
```

### 3. Hoisted Mocks
When mock needs to be configured before import:
```typescript
const { mockFunction } = vi.hoisted(() => ({
  mockFunction: vi.fn(),
}));

vi.mock('some-module', () => ({
  default: mockFunction,
}));

// Later in tests:
mockFunction.mockResolvedValue('value');
```

### 4. Mock Embeddings Provider
Located in `src/__mocks__/embeddings.ts`:
```typescript
import { createMockEmbeddings, createFailingEmbeddings } from '../__mocks__/embeddings.js';

// For normal tests
const mockEmbeddings = createMockEmbeddings();

// For error handling tests
const failingEmbeddings = createFailingEmbeddings();
```

Features:
- Deterministic vectors based on content hash
- Configurable dimensions (default 384)
- Variants for error testing

### 5. Partial Mocks
When you need real implementation with some mocks:
```typescript
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    scryptSync: (password, salt, keylen) => {
      // Fast implementation for tests
    },
  };
});
```

### 6. Inline Mocks
For test-specific behavior:
```typescript
it('should handle specific case', async () => {
  mockFunction.mockResolvedValueOnce(specificValue);
  // Test runs with this specific mock
});
```

### 7. Spy Functions
For tracking calls without replacing:
```typescript
const listener = vi.fn();
tracker.addStatusListener(listener);
tracker.startIndexing('id', 'url', 'title');
expect(listener).toHaveBeenCalledWith(expect.objectContaining({ id: 'id' }));
```

---

## Code Style Guidelines

### TypeScript
- Strict mode enabled
- No unused locals/parameters
- Explicit return types for public APIs
- Use interfaces for data shapes, types for unions/intersections

### Imports
- Use `.js` extensions in imports (ESM requirement)
- Group imports: external deps, then internal modules
```typescript
import { Something } from 'external-package';
import { Internal } from './internal.js';
```

### Error Handling
- Use custom error classes when appropriate
- Sanitize error messages before exposing to users
- Log errors with context but redact sensitive data

### Async/Await
- Prefer async/await over raw promises
- Use `AsyncGenerator` for streaming results (crawler)

### Security Practices
- Validate all tool arguments with Zod schemas
- Use `validatePublicUrl()` for SSRF protection
- Encrypt sensitive session data
- Detect and flag prompt injection patterns
- Sanitize error messages to prevent information leakage

---

## Common Development Tasks

### Running Tests
```bash
npm test              # Run all tests once
npm run test:watch    # Watch mode
npm run test:coverage # With coverage report
npm run test:ui       # Vitest UI
```

### Building
```bash
npm run build    # Compile TypeScript
npm run dev      # Watch mode compilation
```

### Linting and Formatting
```bash
npm run lint     # Run ESLint
npm run prettier # Format with Prettier
```

### Adding a New Content Extractor

1. Create extractor in `src/crawler/`:
```typescript
// my-extractor.ts
import type { ContentExtractor, ExtractionResult } from './content-extractor-types.js';

export const MyExtractor: ContentExtractor = {
  name: 'MyExtractor',

  detect(url: string, $: cheerio.CheerioAPI): boolean {
    // Return true if this extractor should handle the page
    return url.includes('my-site.com');
  },

  async extract(url: string, $: cheerio.CheerioAPI): Promise<ExtractionResult> {
    // Extract and return formatted content
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

The project uses a versioned migration system in `src/storage/storage.ts` to handle SQLite schema changes. Migrations are applied automatically when the server starts.

1. Add a new migration to the `MIGRATIONS` array in `DocumentStore`:
```typescript
private static readonly MIGRATIONS: Array<{
  version: number;
  description: string;
  sql: string;
}> = [
  // Existing migrations...
  {
    version: 2, // Increment from last version
    description: 'Add new_column to documents table',
    sql: `
      ALTER TABLE documents ADD COLUMN new_column TEXT;
    `,
  },
];
```

2. Update the `DocumentMetadata` interface in `src/types.ts` if adding new fields

3. Update the `addDocument`, `getDocument`, and `listDocuments` methods to handle the new field

4. Write tests to verify the migration and new functionality

**Migration Guidelines:**
- Use `ALTER TABLE ... ADD COLUMN` for new columns (SQLite limitation: no `IF NOT EXISTS` for columns)
- Each migration runs in a try-catch - failures for already-applied changes are expected and ignored
- Migrations are tracked in the `schema_migrations` table
- Always increment the version number
- Keep migrations idempotent where possible

---

## Key Interfaces

### CrawlResult
```typescript
interface CrawlResult {
  url: string;
  path: string;
  content: string;  // HTML or markdown content
  title: string;
  extractorUsed?: string;
}
```

### ProcessedDocument
```typescript
interface ProcessedDocument {
  metadata: DocumentMetadata;
  chunks: DocumentChunk[];
}
```

### DocumentChunk
```typescript
interface DocumentChunk {
  content: string;
  url: string;
  title: string;
  path: string;
  startLine: number;
  endLine: number;
  vector: number[];  // Embedding vector
  metadata: {
    type: 'overview' | 'api' | 'example' | 'usage';
    version?: string;
    framework?: string;
    language?: string;
    codeBlocks?: { code: string; language: string; context: string; }[];
    props?: { name: string; type: string; required: boolean; description: string; }[];
  };
}
```

### EmbeddingsProvider
```typescript
interface EmbeddingsProvider {
  embed(text: string): Promise<number[]>;
  dimensions: number;
}
```

---

## Important Notes

### MCP Server Output
- MCP servers communicate via JSON-RPC over stdio
- **Never log to stdout** - use the logger which writes to stderr
- Crawlee/Apify logging is suppressed via environment variables

### Embedding Dimensions
- FastEmbed produces 384-dimensional vectors
- Mock embeddings should match this dimension

### Storage Paths
- Default data directory: `~/.mcp-web-docs/`
- SQLite database: `docs.db`
- Vector storage: `vectors/`
- Auth sessions: `sessions/`
- Crawl cache: `crawlee/`

### Test Environment
- Tests set `MCP_WEB_DOCS_SECRET` for encryption tests
- Fetch is mocked globally via `vitest-fetch-mock`
- Logger is mocked to prevent console noise

---

## Debugging Tips

1. **Test failures**: Check if mocks are properly hoisted
2. **Import errors**: Ensure `.js` extensions in imports
3. **Async issues**: Use `await vi.advanceTimersByTimeAsync()` with fake timers
4. **Mock not working**: Verify mock path matches actual import path
5. **Type errors**: Check `tsconfig.json` for proper type definitions

---

## Commit Conventions

This project uses **semantic-release** for automated versioning. Commit messages directly impact releases and changelogs.

### Commit Message Format
```
<type>(<scope>): <subject>

<body>

<footer>
```

### Commit Types and Release Impact
| Type | Release Impact |
|------|----------------|
| `feat` | Minor version bump (1.x.0) |
| `fix` | Patch version bump (1.0.x) |
| `perf` | Patch version bump |
| `docs`, `style`, `refactor`, `test`, `chore`, `ci`, `build` | No release |

### Commit Strategy for PRs
- **Feature PRs**: Use `feat` for the primary commit. Use `chore`/`refactor` for follow-up fixes to the same feature (keeps release notes clean).
- **Bug fix PRs**: Use `fix` for the primary commit.
- **Unrelated bugs**: If you find an unrelated bug while working, use `fix`.

### Writing Commit Bodies
The commit body appears in release notes. Include:
- What the change does and why
- Sub-features using `-` bullet points (rendered as nested lists)

**Example:**
```
feat(auth): add session validation

Session Validation:
- Add cookie expiration check
- Clear expired sessions automatically

Auth Tracking:
- Store auth requirements in database
```

See **CONTRIBUTING.md** for detailed commit guidelines.

---

## Contributing Checklist

- [ ] Code follows existing patterns and style
- [ ] Tests added for new functionality
- [ ] Tests pass: `npm test`
- [ ] Linting passes: `npm run lint`
- [ ] Types check: `npm run test:types`
- [ ] Code formatted: `npm run prettier`
- [ ] Commit messages follow conventional commits format
- [ ] Documentation updated if needed

---

## Maintaining Agent Guidelines

When making significant changes to the codebase (new features, architectural changes, new patterns, database migrations, etc.), **ask the user if they want to update the agent instruction files**. These files help AI agents understand the project:

- `AGENTS.md` - Comprehensive guidelines (primary reference)
- `CONTRIBUTING.md` - Contributor guidelines
- `.cursorrules` - Cursor IDE rules
- `CLAUDE.md` - Claude Code guidelines
- `.roo/rules/01-project-rules.md` - Roo/Cline rules

Keep all these files in sync when updating documentation.