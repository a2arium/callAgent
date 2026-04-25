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
            const obsA = { source: 'internal', kind: 'state.noted', payload: 'a' };
            const obsB = { source: 'internal', kind: 'state.noted', payload: 'b' };
            const input = { current: [obsA], all: [obsA, obsB] };
            const result = InboxManager.normalizeInbox(input);
            expect(result).toEqual(input);
        });

        it('should wrap array input as current and all', () => {
            const obsA = { source: 'internal', kind: 'state.noted', payload: 'a' };
            const input = [obsA];
            const result = InboxManager.normalizeInbox(input);
            expect(result).toEqual({ current: [obsA], all: [obsA] });
        });

        it('normalizes valid conversation observations without rewriting source', () => {
            const convoObs = {
                source: 'conversation',
                kind: 'message.received',
                payload: {
                    kind: 'message.received',
                    message: {
                        id: 'msg-inbox-1',
                        conversation: { kind: 'thread', id: 'thread-inbox-1' },
                        senderAgentId: 'parent',
                        senderMemberId: 'parent',
                        recipientAgentId: 'child',
                        recipientMemberId: 'mem-child',
                        speechAct: 'inform',
                        content: {},
                        sequenceNumber: 1,
                        ts: new Date().toISOString(),
                    },
                },
            };
            const result = InboxManager.normalizeInbox([convoObs]);
            expect(result.current[0]).toMatchObject({ source: 'conversation', kind: 'message.received' });
            expect((result.current[0] as any).payload.message.conversation.id).toBe('thread-inbox-1');
        });
    });

    describe('addObservationToInbox', () => {
        it('should add observation to both current and all', () => {
            const inbox: any = { current: [], all: [] };
            const obs: any = { source: 'internal', kind: 'state.noted', payload: {} };
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
            const obs: any = { source: 'internal', kind: 'state.noted', payload: { id: 1 } };
            const predicate = (o: any) => o.payload?.id === 1;

            const result = InboxManager.addObservationToInboxIfMissing(inbox, obs, predicate);
            expect(result.all).toContain(obs);
            expect(result.current).toContain(obs);
        });

        it('should revive in current if already in all but not current', () => {
            const obs: any = { source: 'internal', kind: 'state.noted', payload: { id: 1 } };
            const inbox: any = { current: [], all: [obs] };
            const predicate = (o: any) => o.payload?.id === 1;

            const result = InboxManager.addObservationToInboxIfMissing(inbox, obs, predicate);
            expect(result.all.length).toBe(1);
            expect(result.current).toHaveLength(1); // Revived
            expect(result.current).toContain(obs);
        });
    });

    describe('mergeInboxes', () => {
        it('should merge remote child completion observations logic', () => {
            const localInbox: any = { current: [], all: [] };
            const remoteObs: any = { source: 'child', kind: 'child.completed', payload: { token: 'child-1', result: 'foo' } };
            const remoteInbox: any = { current: [], all: [remoteObs] };
            const pendingChildren = { 'child-1': true };

            const result = InboxManager.mergeInboxes(localInbox, remoteInbox, pendingChildren);

            expect(result.all).toContain(remoteObs);
            expect(result.current).toContain(remoteObs);
        });

        it('should NOT merge if child is not pending', () => {
            const localInbox: any = { current: [], all: [] };
            const remoteObs: any = { source: 'child', kind: 'child.completed', payload: { token: 'child-1' } };
            const remoteInbox: any = { current: [], all: [remoteObs] };
            const pendingChildren = {}; // empty

            const result = InboxManager.mergeInboxes(localInbox, remoteInbox, pendingChildren);

            expect(result.all).toHaveLength(0);
        });

        it('should NOT merge if already in local', () => {
            const obs: any = { source: 'child', kind: 'child.completed', payload: { token: 'child-1' } };
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
