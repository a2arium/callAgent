import { jest } from '@jest/globals';
import { logger } from '@a2arium/callagent-utils';

// Mock dependencies
await jest.unstable_mockModule('@a2arium/callagent-utils', () => ({
    logger: {
        createLogger: jest.fn(() => ({
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
        })),
    },
}));

// Import after mocking
const { InboxManager } = await import('../src/orchestration/InboxManager.js');

describe('InboxManager', () => {
    describe('normalizeInbox', () => {
        it('should return a valid inbox structure from null', () => {
            const result = InboxManager.normalizeInbox(null);
            expect(result).toEqual({ current: [], all: [] });
        });

        it('should return a valid inbox structure from undefined', () => {
            const result = InboxManager.normalizeInbox(undefined);
            expect(result).toEqual({ current: [], all: [] });
        });

        it('should return the inbox if valid', () => {
            const input = { current: ['a'], all: ['a', 'b'] };
            const result = InboxManager.normalizeInbox(input);
            expect(result).toEqual(input);
        });

        it('should wrap array input as current and all', () => {
            const input = ['a'];
            const result = InboxManager.normalizeInbox(input);
            expect(result).toEqual({ current: ['a'], all: ['a'] });
        });
    });

    describe('addObservationToInbox', () => {
        it('should add observation to both current and all', () => {
            const inbox: any = { current: [], all: [] };
            const obs: any = { kind: 'test', payload: {} };
            const result = InboxManager.addObservationToInbox(inbox, obs);
            expect(result.current).toContain(obs);
            expect(result.all).toContain(obs);
            expect(result.current.length).toBe(1);
            expect(result.all.length).toBe(1);
        });
    });

    describe('addObservationToInboxIfMissing', () => {
        it('should add observation if not present', () => {
            const inbox: any = { current: [], all: [] };
            const obs: any = { kind: 'test', id: 1 };
            const predicate = (o: any) => o.id === 1;

            const result = InboxManager.addObservationToInboxIfMissing(inbox, obs, predicate);
            expect(result.all).toContain(obs);
            expect(result.current).toContain(obs);
        });

        it('should revive in current if already in all but not current', () => {
            const obs: any = { kind: 'test', id: 1 };
            const inbox: any = { current: [], all: [obs] };
            const predicate = (o: any) => o.id === 1;

            const result = InboxManager.addObservationToInboxIfMissing(inbox, obs, predicate);
            expect(result.all.length).toBe(1);
            expect(result.current).toHaveLength(1); // Revived
            expect(result.current).toContain(obs);
        });
    });

    describe('mergeInboxes', () => {
        it('should merge remote child completion observations logic', () => {
            const localInbox: any = { current: [], all: [] };
            const remoteObs: any = { kind: 'child.completed', payload: { token: 'child-1', result: 'foo' } };
            const remoteInbox: any = { current: [], all: [remoteObs] };
            const pendingChildren = { 'child-1': true };

            const result = InboxManager.mergeInboxes(localInbox, remoteInbox, pendingChildren);

            expect(result.all).toContain(remoteObs);
            expect(result.current).toContain(remoteObs);
        });

        it('should NOT merge if child is not pending', () => {
            const localInbox: any = { current: [], all: [] };
            const remoteObs: any = { kind: 'child.completed', payload: { token: 'child-1' } };
            const remoteInbox: any = { current: [], all: [remoteObs] };
            const pendingChildren = {}; // empty

            const result = InboxManager.mergeInboxes(localInbox, remoteInbox, pendingChildren);

            expect(result.all).toHaveLength(0);
        });

        it('should NOT merge if already in local', () => {
            const obs: any = { kind: 'child.completed', payload: { token: 'child-1' } };
            const localInbox: any = { current: [], all: [obs] };
            const remoteInbox: any = { current: [], all: [obs] };
            const pendingChildren = { 'child-1': true };

            const result = InboxManager.mergeInboxes(localInbox, remoteInbox, pendingChildren);

            expect(result.all).toHaveLength(1); // No duplicate
            // And current shouldn't change if it wasn't there?
            // Implementation checks `alreadyHasInCurrent`.
        });
    });
});
