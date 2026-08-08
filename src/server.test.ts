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

// Overridden to a value the production message cannot coincidentally match. Asserting against
// the real 2 minutes proved nothing: the test computed the same expression as the code, so
// hardcoding "2 minutes" in the message passed. The tracker class is kept intact - it closes
// over the original constant, so its own expiry behaviour is untouched.
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
    // A refused reindex changes nothing else a client can see, and its status is dropped once
    // the TTL passes - so "nothing tracked" must not read as "it worked". Asserted in full:
    // fragment matching let a message keep the expected phrases and still bolt on a success
    // claim, and the retention window has to track the constant rather than be narrated.
    expect(describeIndexingStatuses([])).toBe(
      `No indexing operations are being tracked. Recently finished operations are dropped after ${COMPLETED_STATUS_TTL_MS / 60_000} minutes, ` +
        'so this does not confirm one succeeded - use list_documentation to check what is actually indexed.'
    );
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
    // A cancel can land after addDocument has already committed the document, so the message
    // must not claim otherwise
    expect(instruction).not.toContain('nothing was stored');
  });

  it('reports a clean success only when every operation succeeded', () => {
    expect(describeIndexingStatuses([statusOf('complete'), statusOf('complete')])).toBe(
      'All operations complete. No need to poll again. Use list_documentation to confirm what is indexed.'
    );
  });

  // Every message an agent can stop on has to point somewhere it can verify: a failure it was
  // told about on an earlier poll ages out of the TTL, so any of these can be the last thing it
  // reads while an earlier failure is already invisible. The in-flight message is excluded on
  // purpose - there is nothing to confirm yet, and it must not read as a reason to stop.
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
    // Polling cadence is this string's own business. How long a finished status survives is
    // COMPLETED_STATUS_TTL_MS, and a copy quoted here goes stale and contradicts
    // describeIndexingStatuses, which the agent reads moments later.
    expect(POLLING_INSTRUCTION).not.toMatch(/\b(minute|hour)s?\b/);
    expect(POLLING_INSTRUCTION).not.toContain('dropped after');
  });

  it('sends the agent to the status response rather than restating it', () => {
    expect(POLLING_INSTRUCTION).toContain('none are tracked');
    expect(POLLING_INSTRUCTION).toContain('follow the instruction in that response');
    expect(POLLING_INSTRUCTION).toContain('Do not ask the user');
  });
});
