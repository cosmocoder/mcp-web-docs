# Claude Code Guidelines for MCP Web Docs

This is a TypeScript MCP (Model Context Protocol) server project for crawling and indexing web documentation.

## Quick Reference

For comprehensive guidelines, see **AGENTS.md** in the project root.

## Project Overview

MCP Web Docs is a self-hosted MCP server that crawls, indexes, and searches documentation from any website. It provides:
- Universal web crawling with Playwright/Crawlee
- Hybrid search (full-text + semantic/vector)
- Authentication support for protected documentation
- Local embeddings with FastEmbed (no API keys needed)

## Tech Stack

- **Runtime**: Node.js >= 22.19.0
- **Language**: TypeScript (ES2022, NodeNext modules)
- **Testing**: Vitest
- **Storage**: SQLite (metadata) + LanceDB (vectors)

## Essential Rules

### Code Style
- TypeScript with strict mode
- **Always use `.js` extensions in imports** (ESM requirement)
- Follow existing patterns in the codebase

### Testing
- Tests are co-located: `*.test.ts` next to source files
- Use Vitest globals: `describe`, `it`, `expect`, `vi`
- Mock embeddings: `createMockEmbeddings()` from `src/__mocks__/embeddings.ts`
- Use `vi.hoisted()` for mocks configured before imports

### Critical Constraints
- **Never log to stdout** - MCP servers use stdio for JSON-RPC
- Use logger from `src/util/logger.ts` (writes to stderr)
- Validate inputs with Zod schemas from `src/util/security.ts`
- Use `validatePublicUrl()` for SSRF protection

### Key Commands
```bash
npm test              # Run tests
npm run build         # Build TypeScript
npm run lint          # Run ESLint
npm run prettier      # Format code
npm run test:coverage # Test with coverage
npm run test:types    # Type check
```

### Architecture
```
src/
├── index.ts          # Main MCP server (WebDocsServer)
├── crawler/          # Web crawling (Playwright/Crawlee)
├── processor/        # Content processing
├── storage/          # SQLite + LanceDB
├── embeddings/       # FastEmbed vectors
├── indexing/         # Status tracking
└── util/             # Logger, security, helpers
```

### When Making Changes
1. Check existing patterns in the codebase first
2. Add Zod schema for new inputs in `src/util/security.ts`
3. Write tests for new functionality
4. Run `npm test` before completing

### Database Migrations
When modifying the SQLite schema, add migrations to `DocumentStore.MIGRATIONS` in `src/storage/storage.ts`. Migrations run automatically on startup. See **AGENTS.md** for details.

See **AGENTS.md** for detailed architecture, testing patterns, and mocking strategies.