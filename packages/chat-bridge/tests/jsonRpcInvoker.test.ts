import { jest } from '@jest/globals';
import { JsonRpcInvoker } from '../src/clients/jsonRpcInvoker.js';

describe('JsonRpcInvoker', () => {
    const endpoint = 'https://api.example.com/rpc';
    const invoker = new JsonRpcInvoker({ endpoint, headers: { Authorization: 'Bearer test' } });

    beforeEach(() => {
        jest.resetAllMocks();
    });

    it('sends start() request and returns result payload', async () => {
        const fetchMock = jest.spyOn(globalThis as any, 'fetch').mockResolvedValue({
            json: async () => ({ jsonrpc: '2.0', result: { id: 't1', status: 'ok', data: { a: 1 } } })
        } as any);

        const res = await invoker.start({
            id: 't1',
            agentId: 'agent',
            route: { network: 'web', conversationId: 'c1' } as any,
            input: { text: 'hi' } as any
        });

        expect(res).toMatchObject({ id: 't1', status: 'ok' });
        expect(fetchMock).toHaveBeenCalledWith(endpoint, expect.objectContaining({
            method: 'POST',
            headers: expect.objectContaining({ Authorization: 'Bearer test', 'Content-Type': 'application/json' })
        }));
        const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as any).body);
        expect(body).toMatchObject({ method: 'tasks/send', params: { id: 't1', input: { text: 'hi' } } });
    });

    it('maps JSON-RPC error to failed payload in resume()', async () => {
        jest.spyOn(globalThis as any, 'fetch').mockResolvedValue({
            json: async () => ({ jsonrpc: '2.0', error: { code: -1, message: 'boom' }, id: 't2' })
        } as any);

        const res = await invoker.resume({
            id: 't2',
            token: 'tok',
            route: { network: 'web', conversationId: 'c1' } as any,
            input: { text: 'reply' } as any
        });

        expect(res).toEqual({ id: 't2', status: 'failed', error: 'boom' });
    });
});
