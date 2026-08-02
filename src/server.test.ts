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

import type { IndexingStatus } from './types.js';
import { describeIndexingStatuses, WebDocsServer } from './server.js';

const statusOf = (status: IndexingStatus['status']): IndexingStatus => ({
  operationId: 'o',
  documentId: 'd',
  id: 'd',
  url: 'https://example.com',
  title: 'T',
  status,
  progress: 1,
  description: '',
});

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
      instruction: expect.stringContaining('No indexing operations are being tracked'),
    });
  });
});

describe('describeIndexingStatuses', () => {
  it('does not report an empty list as success', () => {
    // A refused reindex changes nothing else a client can see, and its status is dropped
    // after a couple of minutes - so "nothing tracked" must not read as "it worked"
    const instruction = describeIndexingStatuses([]);

    expect(instruction).not.toContain('complete');
    expect(instruction).toContain('list_documentation');
  });

  it('asks the caller to keep polling while work is in flight', () => {
    expect(describeIndexingStatuses([statusOf('complete'), statusOf('indexing')])).toContain('still in progress');
  });

  it('calls out operations that did not succeed', () => {
    const instruction = describeIndexingStatuses([statusOf('complete'), statusOf('failed'), statusOf('cancelled')]);

    expect(instruction).toContain('2 did not succeed');
    expect(instruction).toContain('nothing was stored');
  });

  it('reports a clean success only when every operation succeeded', () => {
    expect(describeIndexingStatuses([statusOf('complete'), statusOf('complete')])).toBe('All operations complete. No need to poll again.');
  });
});
