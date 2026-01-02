# MCP Web Docs

[![npm version](https://img.shields.io/npm/v/@cosmocoder/mcp-web-docs.svg)](https://www.npmjs.com/package/@cosmocoder/mcp-web-docs)
[![npm downloads](https://img.shields.io/npm/dm/@cosmocoder/mcp-web-docs.svg)](https://www.npmjs.com/package/@cosmocoder/mcp-web-docs)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.19.0-brightgreen.svg)](https://nodejs.org/)
[![CI](https://github.com/cosmocoder/mcp-web-docs/actions/workflows/release.yml/badge.svg)](https://github.com/cosmocoder/mcp-web-docs/actions/workflows/release.yml)

**Index Any Documentation. Search Locally. Stay Private.**

A self-hosted Model Context Protocol (MCP) server that crawls, indexes, and searches documentation from *any* website. Unlike remote MCP servers limited to GitHub repos or pre-indexed libraries, web-docs gives you full control over what gets indexed — including private documentation behind authentication.

[Features](#-features) • [Installation](#-installation) • [Quick Start](#-quick-start) • [Tools](#-available-tools) • [Tips](#-tips) • [Troubleshooting](#-troubleshooting) • [Contributing](#-contributing)

---

## ❌ The Problem

AI assistants struggle with documentation:

- ❌ **Remote MCP servers** only work with GitHub or pre-indexed libraries
- ❌ **Private docs** behind authentication can't be accessed
- ❌ **Outdated indexes** don't reflect your team's latest documentation
- ❌ **No control** over what gets indexed or when

## ✅ The Solution

**MCP Web Docs** crawls and indexes documentation from ANY website locally:

- ✅ **Any website** - Docusaurus, Storybook, GitBook, custom sites, internal wikis
- ✅ **Private docs** - Interactive browser login for authenticated sites
- ✅ **Always fresh** - Re-index anytime with one command
- ✅ **Your data, your machine** - No API keys, no cloud, full privacy

---

## ✨ Features

- **🌐 Universal Crawler** - Works with any documentation site, not just GitHub
- **🔍 Hybrid Search** - Combines full-text search (FTS) with semantic vector search
- **🏷️ Tags & Categories** - Organize docs with tags and filter searches by project, team, or category
- **📦 Version Support** - Index multiple versions of the same package (e.g., React 18 and 19)
- **🔐 Authentication Support** - Crawl private/protected docs with interactive browser login (auto-detects your default browser)
- **📊 Smart Extraction** - Automatically extracts code blocks, props tables, and structured content
- **⚡ Local Embeddings** - Uses FastEmbed for fast, private embedding generation (no API keys)
- **🗄️ Persistent Storage** - LanceDB for vectors, SQLite for metadata
- **🔄 Real-time Progress** - Track indexing status with progress updates

---

## 🚀 Installation

### Prerequisites

- Node.js >= 22.19.0

### Option 1: Install from NPM (Recommended)

```bash
npm install -g @cosmocoder/mcp-web-docs
```

### Option 2: Run with npx

No installation required - just configure your MCP client to use npx (see below).

### Option 3: Build from Source

```bash
# Clone the repository
git clone https://github.com/cosmocoder/mcp-web-docs.git
cd mcp-web-docs

# Install dependencies (automatically installs Playwright browsers)
npm install

# Build
npm run build
```

### Configure Your MCP Client

<details>
<summary><b>Cursor</b></summary>

Add to your Cursor MCP settings (`~/.cursor/mcp.json`):

**Using npx (no install required):**
```json
{
  "mcpServers": {
    "web-docs": {
      "command": "npx",
      "args": ["-y", "@cosmocoder/mcp-web-docs"]
    }
  }
}
```

**Using global install:**
```json
{
  "mcpServers": {
    "web-docs": {
      "command": "mcp-web-docs"
    }
  }
}
```

**Using local build:**
```json
{
  "mcpServers": {
    "web-docs": {
      "command": "node",
      "args": ["/path/to/mcp-web-docs/build/index.js"]
    }
  }
}
```

</details>

<details>
<summary><b>Claude Desktop</b></summary>

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

**Using npx:**
```json
{
  "mcpServers": {
    "web-docs": {
      "command": "npx",
      "args": ["-y", "@cosmocoder/mcp-web-docs"]
    }
  }
}
```

**Using global install:**
```json
{
  "mcpServers": {
    "web-docs": {
      "command": "mcp-web-docs"
    }
  }
}
```

</details>

<details>
<summary><b>VS Code</b></summary>

Add to `.vscode/mcp.json` in your workspace:

**Using npx:**
```json
{
  "servers": {
    "web-docs": {
      "command": "npx",
      "args": ["-y", "@cosmocoder/mcp-web-docs"]
    }
  }
}
```

**Using global install:**
```json
{
  "servers": {
    "web-docs": {
      "command": "mcp-web-docs"
    }
  }
}
```

</details>

<details>
<summary><b>Windsurf</b></summary>

Add to `~/.codeium/windsurf/mcp_config.json`:

**Using npx:**
```json
{
  "mcpServers": {
    "web-docs": {
      "command": "npx",
      "args": ["-y", "@cosmocoder/mcp-web-docs"]
    }
  }
}
```

**Using global install:**
```json
{
  "mcpServers": {
    "web-docs": {
      "command": "mcp-web-docs"
    }
  }
}
```

</details>

<details>
<summary><b>Cline</b></summary>

Add to `~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`:

**Using npx:**
```json
{
  "mcpServers": {
    "web-docs": {
      "command": "npx",
      "args": ["-y", "@cosmocoder/mcp-web-docs"],
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

**Using global install:**
```json
{
  "mcpServers": {
    "web-docs": {
      "command": "mcp-web-docs",
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

</details>

<details>
<summary><b>RooCode</b></summary>

**Global configuration:** Open RooCode → Click MCP icon → "Edit Global MCP"

**Project-level configuration:** Create `.roo/mcp.json` at your project root

**Using npx:**
```json
{
  "mcpServers": {
    "web-docs": {
      "command": "npx",
      "args": ["-y", "@cosmocoder/mcp-web-docs"]
    }
  }
}
```

**Using global install:**
```json
{
  "mcpServers": {
    "web-docs": {
      "command": "mcp-web-docs"
    }
  }
}
```

</details>

---

## ⚡ Quick Start

### 1. Index public documentation

```
Index the LanceDB documentation from https://lancedb.com/docs/
```

The AI assistant will call `add_documentation` and begin crawling.

### 2. Search for information

```
How do I create a table in LanceDB?
```

The AI will use `search_documentation` to find relevant content.

### 3. For private docs, authenticate first

```
I need to index private documentation at https://internal.company.com/docs/
It requires authentication.
```

A browser window will open for you to log in. The session is saved for future crawls.

---

## 🔨 Available Tools

### `add_documentation`

Add a new documentation site for indexing.

```typescript
add_documentation({
  url: "https://docs.example.com/",
  title: "Example Docs",              // Optional
  id: "example-docs",                 // Optional custom ID
  tags: ["frontend", "mycompany"],    // Optional tags for categorization
  version: "2.0",                     // Optional version for versioned packages
  auth: {                             // Optional authentication
    requiresAuth: true,
    // browser auto-detected from OS settings if omitted
    loginTimeoutSecs: 300
  }
})
```

### `search_documentation`

Search through indexed documentation using hybrid search (FTS + semantic).

```typescript
search_documentation({
  query: "how to configure authentication",
  url: "https://docs.example.com/",    // Optional: filter to specific site
  tags: ["frontend", "mycompany"],     // Optional: filter by tags
  limit: 10                            // Optional: max results
})
```

### `authenticate`

Open a browser window for interactive login to protected sites. Your default browser is automatically detected from OS settings.

```typescript
authenticate({
  url: "https://private-docs.example.com/",
  // browser auto-detected from OS settings - only specify to override
  loginTimeoutSecs: 300         // Optional: timeout in seconds
})
```

### `list_documentation`

List all indexed documentation sites with their metadata including tags.

### `set_tags`

Set or update tags for a documentation site. Tags help categorize and filter documentation.

```typescript
set_tags({
  url: "https://docs.example.com/",
  tags: ["frontend", "react", "mycompany"]  // Replaces existing tags
})
```

### `list_tags`

List all available tags with usage counts. Useful to see what tags exist across your indexed docs.

### `reindex_documentation`

Re-crawl and re-index a specific documentation site.

### `get_indexing_status`

Get the current status of indexing operations.

### `delete_documentation`

Delete an indexed documentation site and all its data.

### `clear_auth`

Clear saved authentication session for a domain.

---

## 💡 Tips

### Crafting Better Search Queries

The search uses hybrid full-text and semantic search. For best results:

1. **Be specific** - Include unique terms from what you're looking for
   - Instead of: `"Button props"`
   - Try: `"Button props onClick disabled loading"`

2. **Use exact phrases** - Wrap in quotes for exact matching
   - `"authentication middleware"` finds that exact phrase

3. **Include context** - Add related terms to narrow results
   - API docs: `"GET /users endpoint authentication headers"`
   - Config: `"webpack config entry output plugins"`

### Auto-Invoke with Rules

To avoid typing search instructions in every prompt, add a rule to your MCP client:

**Cursor** (`Cursor Settings > Rules`):
```
When I ask about library documentation or need code examples,
use the web-docs MCP server to search indexed documentation.
```

**Windsurf** (`.windsurfrules`):
```
Always use web-docs search_documentation when I ask about
API references, configuration, or library usage.
```

### Scoping Searches

If you have multiple sites indexed, filter by URL or tags:

```typescript
// Filter by specific site URL
search_documentation({
  query: "routing",
  url: "https://nextjs.org/docs/"
})

// Filter by tags (searches all docs with matching tags)
search_documentation({
  query: "Button component",
  tags: ["frontend", "mycompany"]  // Only docs tagged with BOTH tags
})
```

### Organizing with Tags

Tags help organize documentation when you have multiple related sites. Add tags when indexing:

```typescript
// Index frontend package docs
add_documentation({
  url: "https://docs.mycompany.com/ui-components/",
  tags: ["frontend", "mycompany", "react"]
})

// Index backend API docs
add_documentation({
  url: "https://docs.mycompany.com/api/",
  tags: ["backend", "mycompany", "api"]
})
```

Later, search across all frontend docs:
```typescript
search_documentation({
  query: "authentication",
  tags: ["frontend"]  // Searches all frontend-tagged docs
})
```

You can also add tags to existing documentation with `set_tags`.

### Versioning Package Documentation

When indexing documentation for versioned packages (React, Vue, Python libraries, etc.), you can specify the version to track which version you've indexed:

```typescript
// Index React 18 docs
add_documentation({
  url: "https://18.react.dev/",
  title: "React 18 Docs",
  version: "18"
})

// Index React 19 docs (different URL)
add_documentation({
  url: "https://react.dev/",
  title: "React 19 Docs",
  version: "19"
})
```

The version is displayed in `list_documentation` output and preserved when re-indexing. Version formats are flexible — use whatever makes sense for your package (e.g., `"18"`, `"v6.4"`, `"3.11"`, `"latest"`).

**Note:** Version is optional and mainly useful for software packages with multiple versions. For internal documentation, wikis, or single-version products, you can skip the version field.

---

## 🚨 Troubleshooting

<details>
<summary><b>"Failed to parse document content"</b></summary>

The content extractor couldn't process the page. Try:
- Re-indexing the documentation
- Checking if the site uses JavaScript rendering (should work with Playwright)
- Looking at the crawled data in `~/.mcp-web-docs/crawlee/datasets/`

</details>

<details>
<summary><b>Authentication not working</b></summary>

- Make sure you call `authenticate` before `add_documentation`
- The browser window needs to stay open until login is detected
- For OAuth sites, complete the full flow manually
- Your default browser is auto-detected; specify a different one with `browser: "firefox"`, for example, if needed

</details>

<details>
<summary><b>Search not returning expected results</b></summary>

- Try more specific queries with unique terms
- Use quotes for exact phrase matching
- Filter by URL to search within a specific documentation site
- Re-index if the documentation has been updated

</details>

<details>
<summary><b>Playwright browser issues</b></summary>

If browsers aren't installed, run:
```bash
npx playwright install
```

</details>

---

### Data Storage

All data is stored locally in `~/.mcp-web-docs/`:

```
~/.mcp-web-docs/
├── docs.db           # SQLite database for document metadata
├── vectors/          # LanceDB vector database
├── sessions/         # Saved authentication sessions
└── crawlee/          # Crawlee datasets (cached crawl data)
```
---

## 📄 License

MIT License - see [LICENSE](LICENSE) for details.

---

## 🙏 Acknowledgments

- [Model Context Protocol](https://modelcontextprotocol.io/) - The protocol specification
- [Crawlee](https://crawlee.dev/) - Web scraping and browser automation
- [LanceDB](https://lancedb.com/) - Vector database
- [FastEmbed](https://github.com/Anush008/fastembed) - Local embedding generation
- [Playwright](https://playwright.dev/) - Browser automation
