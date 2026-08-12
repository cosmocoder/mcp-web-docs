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

// Deliberately not the real value: asserting against 2 minutes cannot tell a derived message
// from one that hardcodes today's number. Spread keeps the real tracker, which closes over the
// original constant and so still expires on the real TTL.
vi.mock('./indexing/status.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./indexing/status.js')>()),
  COMPLETED_STATUS_TTL_MS: 7 * 60 * 1000,
}));

import type { IndexingStatus } from './types.js';
import { COMPLETED_STATUS_TTL_MS } from './indexing/status.js';
import { describeIndexingStatuses, POLLING_INSTRUCTION, WebDocsServer } from './server.js';

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

    // Against the function, not a literal: a handler that stopped calling it would still pass
    expect(JSON.parse(response.content[0].text)).toEqual({
      statuses: [],
      instruction: describeIndexingStatuses([]),
    });
  });
});

describe('describeIndexingStatuses', () => {
  it('does not report an empty list as success', () => {
    // Asserted in full: fragment matching passes a message that keeps the expected phrases and
    // bolts a success claim on the end
    expect(describeIndexingStatuses([])).toBe(
      `No indexing operations are being tracked. Recently finished operations are dropped after ${COMPLETED_STATUS_TTL_MS / 60_000} minutes, ` +
        'so this does not confirm one succeeded - use list_documentation to check what is actually indexed.'
    );
  });

  it('asks the caller to keep polling while work is in flight', () => {
    expect(describeIndexingStatuses([statusOf('complete'), statusOf('indexing')])).toContain('still in progress');
  });

  it('still surfaces failures while another operation is in flight', () => {
    // The failed entry ages out on its own, so a message that swallows it loses it for good
    const instruction = describeIndexingStatuses([statusOf('indexing'), statusOf('failed')]);

    expect(instruction).toContain('still in progress');
    expect(instruction).toContain('1 of the tracked operations already did not succeed');
  });

  it('calls out operations that did not succeed', () => {
    const instruction = describeIndexingStatuses([statusOf('complete'), statusOf('failed'), statusOf('cancelled')]);

    expect(instruction).toContain('2 did not succeed');
    expect(instruction).toContain('list_documentation');
    // A cancel can land after addDocument has committed
    expect(instruction).not.toContain('nothing was stored');
  });

  it('reports a clean success only when every operation succeeded', () => {
    expect(describeIndexingStatuses([statusOf('complete'), statusOf('complete')])).toBe(
      'All operations complete. No need to poll again. Use list_documentation to confirm what is indexed.'
    );
  });

  // An operation can succeed and still be missing pages. Telling the agent there is nothing left to
  // do sends it past the entry that says what is missing and how to fix it.
  it.each([
    ['pages it could not fetch', { pagesFailed: 2 }],
    ['pages that asked for a password', { loginPagesSkipped: 1 }],
  ])('does not report a clean success when an operation finished with %s', (_label, missing) => {
    const instruction = describeIndexingStatuses([statusOf('complete'), { ...statusOf('complete'), ...missing }]);

    expect(instruction).not.toContain('No need to poll again');
    expect(instruction).toContain('1 did not index everything');
    expect(instruction).toContain('status entries');
  });

  // Any of these can be the last thing an agent reads while an earlier failure has already aged
  // out, so each has to point somewhere it can verify. The in-flight message is exempt below.
  it.each([
    ['empty', []],
    ['some unsuccessful', [statusOf('complete'), statusOf('failed')]],
    ['all successful', [statusOf('complete')]],
  ])('points the terminal %s message at list_documentation', (_name, statuses) => {
    expect(describeIndexingStatuses(statuses)).toContain('list_documentation');
  });

  it('does not send the caller off to verify while work is still running', () => {
    expect(describeIndexingStatuses([statusOf('indexing')])).not.toContain('list_documentation');
  });
});

describe('POLLING_INSTRUCTION', () => {
  it('does not narrate the retention window', () => {
    // Cadence is this string's own business, hence no ban on "seconds". Retention belongs to
    // COMPLETED_STATUS_TTL_MS, and a copy quoted here goes stale.
    expect(POLLING_INSTRUCTION).not.toMatch(/\b(minute|hour)s?\b/);
    expect(POLLING_INSTRUCTION).not.toContain('dropped after');
  });

  it('sends the agent to the status response rather than restating it', () => {
    expect(POLLING_INSTRUCTION).toContain('none are tracked');
    expect(POLLING_INSTRUCTION).toContain('follow the instruction in that response');
    expect(POLLING_INSTRUCTION).toContain('Do not ask the user');
  });
});
