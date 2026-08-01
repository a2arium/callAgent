import { afterEach, describe, expect, it, vi } from 'vitest';
import { runAgent } from './client';

describe('runAgent', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('starts an agent through streaming RPC and returns the task id without waiting for terminal status', async () => {
    let streamCancelled = false;
    const stream = new ReadableStream({
      cancel: () => {
        streamCancelled = true;
      },
    });
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('crypto', { randomUUID: () => '12345678-1234-1234-1234-123456789abc' });

    const response = await runAgent({
      tenantId: 'tenant-1',
      agentId: 'listing agent',
      payload: { input: { url: 'https://example.test' } },
    });

    expect(response.result).toEqual(expect.objectContaining({
      id: expect.stringMatching(/^listing-agent-\d+-12345678$/),
      status: expect.objectContaining({ state: 'submitted' }),
    }));
    expect(streamCancelled).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();

    const [url, request] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/operator-api/rpc');
    expect(request).toEqual(expect.objectContaining({
      method: 'POST',
      credentials: 'same-origin',
    }));
    const body = JSON.parse(String(request?.body));
    expect(body).toEqual(expect.objectContaining({
      method: 'tasks/sendSubscribe',
      params: expect.objectContaining({
        id: response.result?.id,
        agentId: 'listing agent',
      }),
    }));
  });

  it('preserves an explicit task id from the launch payload', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(new ReadableStream(), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await runAgent({
      tenantId: 'tenant-1',
      agentId: 'listing-agent',
      payload: { id: 'manual-task-id', input: {} },
    });

    expect(response.result?.id).toBe('manual-task-id');
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.params.id).toBe('manual-task-id');
  });
});
