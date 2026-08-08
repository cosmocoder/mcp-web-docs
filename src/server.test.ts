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
import { COMPLETED_STATUS_TTL_MS } from './indexing/status.js';
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

    // Compared against the function rather than a literal, so the handler cannot stop routing
    // through it and still pass by hardcoding the same wording
    expect(JSON.parse(response.content[0].text)).toEqual({
      statuses: [],
      instruction: describeIndexingStatuses([]),
    });
  });
});

describe('describeIndexingStatuses', () => {
  it('does not report an empty list as success', () => {
    // A refused reindex changes nothing else a client can see, and its status is dropped
    // after a couple of minutes - so "nothing tracked" must not read as "it worked"
    const instruction = describeIndexingStatuses([]);

    // Asserted positively: a reworded success claim would slip past `not.toContain('complete')`
    expect(instruction).toContain('does not confirm one succeeded');
    expect(instruction).toContain('list_documentation');
  });

  it('names the TTL the tracker actually uses', () => {
    expect(describeIndexingStatuses([])).toContain(`dropped after ${COMPLETED_STATUS_TTL_MS / 60_000} minutes`);
  });

  it('asks the caller to keep polling while work is in flight', () => {
    expect(describeIndexingStatuses([statusOf('complete'), statusOf('indexing')])).toContain('still in progress');
  });

  it('keeps polling while an operation is queued but not yet started', () => {
    expect(describeIndexingStatuses([statusOf('pending')])).toContain('still in progress');
  });

  it('still surfaces failures while another operation is in flight', () => {
    // The failed entry ages out of the TTL on its own, so if this message swallows it the
    // caller never hears about it at all
    const instruction = describeIndexingStatuses([statusOf('indexing'), statusOf('failed')]);

    expect(instruction).toContain('still in progress');
    expect(instruction).toContain('1 of the tracked operations already did not succeed');
  });

  it('calls out operations that did not succeed', () => {
    const instruction = describeIndexingStatuses([statusOf('complete'), statusOf('failed'), statusOf('cancelled')]);

    expect(instruction).toContain('2 did not succeed');
    expect(instruction).toContain('list_documentation');
  });

  it('does not claim nothing was stored for an operation that did not succeed', () => {
    // A cancel can land after addDocument has already committed the document
    expect(describeIndexingStatuses([statusOf('cancelled')])).not.toContain('nothing was stored');
  });

  it('reports a clean success only when every operation succeeded', () => {
    expect(describeIndexingStatuses([statusOf('complete'), statusOf('complete')])).toBe('All operations complete. No need to poll again.');
  });
});
