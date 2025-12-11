# MCP Web Docs - Project Rules

This is a TypeScript MCP (Model Context Protocol) server project for crawling and indexing web documentation.

## Quick Reference

For comprehensive guidelines, see **AGENTS.md** in the project root.

## Project Context

- **Type**: MCP Server (stdio-based JSON-RPC)
- **Language**: TypeScript with ES2022/NodeNext modules
- **Runtime**: Node.js >= 22.19.0
- **Testing**: Vitest with global test APIs

## Essential Rules

### Code Style
- Use TypeScript with strict mode enabled
- **Always use `.js` extensions in imports** (ESM requirement)
- Follow existing patterns in the codebase
- Run `npm run lint` and `npm run prettier` before committing

### Testing
- Tests are co-located: `*.test.ts` next to source files
- Use Vitest globals: `describe`, `it`, `expect`, `vi`
- Mock embeddings: `createMockEmbeddings()` from `src/__mocks__/embeddings.ts`
- Use `vi.hoisted()` for mocks that need to be configured before imports

### Critical Constraints
- **Never log to stdout** - MCP servers use stdio for JSON-RPC communication
- Use the logger from `src/util/logger.ts` (writes to stderr)
- Validate all user inputs with Zod schemas from `src/util/security.ts`
- Use `validatePublicUrl()` for SSRF protection on user-provided URLs

### Key Commands
```bash
npm test              # Run tests
npm run build         # Build TypeScript
npm run lint          # Run ESLint
npm run prettier      # Format code
npm run test:coverage # Test with coverage
npm run test:types    # Type check without emit
```

### Architecture Overview
```
src/
├── index.ts          # Main MCP server (WebDocsServer class)
├── crawler/          # Web crawling (Playwright/Crawlee)
├── processor/        # Content processing (HTML, Markdown)
├── storage/          # SQLite + LanceDB storage
├── embeddings/       # FastEmbed vector generation
├── indexing/         # Status tracking, queue management
└── util/             # Logger, security, helpers
```

### When Adding Features
1. Add Zod schema for input validation in `src/util/security.ts`
2. Add tool definition in `src/index.ts` `setupToolHandlers()`
3. Write tests in corresponding `*.test.ts` file
4. Run full test suite before submitting

### Commit Conventions
This project uses **semantic-release** for automated versioning. Follow [Conventional Commits](https://www.conventionalcommits.org/):

- `feat`: New feature → Minor version bump
- `fix`: Bug fix → Patch version bump
- `chore`, `refactor`, `docs`, `test`: No release

**For feature PRs**: Use `feat` for the main commit, `chore`/`refactor` for follow-up fixes within the same PR (keeps release notes focused on the feature, not every small fix).

Commit bodies are included in release notes—use `-` bullet points for sub-features.

### Database Migrations
When modifying the SQLite schema, add migrations to `DocumentStore.MIGRATIONS` in `src/storage/storage.ts`. Migrations run automatically on startup. See **AGENTS.md** for details.

### Updating Agent Guidelines
When making significant changes (new features, patterns, migrations), ask the user if they want to update the agent instruction files: `AGENTS.md`, `CONTRIBUTING.md`, `.cursorrules`, `CLAUDE.md`, `.roo/rules/01-project-rules.md`.

### Common Mocking Patterns
```typescript
// Hoisted mocks (configured before imports)
const { mockFn } = vi.hoisted(() => ({ mockFn: vi.fn() }));
vi.mock('module', () => ({ default: mockFn }));

// Mock embeddings for storage/search tests
import { createMockEmbeddings } from '../__mocks__/embeddings.js';
const mockEmbeddings = createMockEmbeddings();

// Temporary directories for file-based tests
let tempDir: string;
beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'test-'));
});
afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});
```

See **AGENTS.md** for detailed architecture, testing patterns, and mocking strategies.