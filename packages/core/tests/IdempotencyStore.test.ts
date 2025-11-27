import { jest } from '@jest/globals';
import { getIdempotent, setIdempotent } from '../src/api/rpc/IdempotencyStore.js';

describe('IdempotencyStore', () => {
    const tenant = 't';
    const task = 'task';
    const token = 'tok';

    it('returns undefined when key not set', () => {
        expect(getIdempotent(tenant, task, token, 'k1')).toBeUndefined();
    });

    it('stores and retrieves idempotent result', () => {
        const result = { jsonrpc: '2.0', id: '1', result: { ok: true } };
        setIdempotent(tenant, task, token, 'k1', result);
        expect(getIdempotent(tenant, task, token, 'k1')).toEqual(result);
    });

    it('expires entries after TTL', () => {
        const result = { jsonrpc: '2.0', id: '2', result: { ok: true } };
        const nowSpy = jest.spyOn(Date, 'now');
        nowSpy.mockReturnValue(1000);
        setIdempotent(tenant, task, token, 'k2', result);
        nowSpy.mockReturnValue(1000 + 11 * 60_000); // beyond default 10m
        expect(getIdempotent(tenant, task, token, 'k2')).toBeUndefined();
        nowSpy.mockRestore();
    });
});
