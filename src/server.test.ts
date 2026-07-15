const { requestHandlers } = vi.hoisted(() => ({
  requestHandlers: [] as Array<(request: { params: { name: string; arguments?: Record<string, unknown> } }) => Promise<unknown>>,
}));

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: class {
    server = {
      setRequestHandler: vi.fn((_schema, handler) => requestHandlers.push(handler)),
      notification: vi.fn().mockResolvedValue(undefined),
      onerror: null,
    };
    connect = vi.fn().mockResolvedValue(undefined);
  },
}));

import { WebDocsServer } from './server.js';

describe('WebDocsServer MCP dispatch', () => {
  it('routes get_indexing_status through the production tool handler', async () => {
    expect(requestHandlers).toEqual([]);
    new WebDocsServer();
    const callToolHandler = requestHandlers[1];

    const response = (await callToolHandler({ params: { name: 'get_indexing_status' } })) as {
      content: Array<{ type: string; text: string }>;
    };

    expect(JSON.parse(response.content[0].text)).toEqual({
      statuses: [],
      instruction: 'All operations complete. No need to poll again.',
    });
  });
});
