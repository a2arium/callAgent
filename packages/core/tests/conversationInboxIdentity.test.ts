import { describe, it, expect } from '@jest/globals';
import {
    conversationInboxDeliveryKey,
    conversationInboxDeliveryKeyFromTurnSummary,
    filterInboxCurrentByConversationDeliveryKeys,
    inboxAllHasConversationDeliveryKey,
    preserveConversationInboxForSnapshot,
    readConsumedConversationDeliveryKeysFromMeta,
    writeConsumedConversationDeliveryKeysToMeta,
} from '../src/loop/conversationInboxIdentity.js';
import { normalizeObservationInbox } from '../src/loop/types.js';
import { InMemorySessionManager } from '../src/orchestration/InMemorySessionManager.js';
import { SessionManager } from '../src/orchestration/SessionManager.js';
import { readLoopBudgetsFromSnapshotMeta } from '../src/orchestration/loopOptsFromSnapshotMeta.js';
import type { Observation } from '../src/types/observation.js';

function topicMessage(id: string, recipientMemberId = 'orchestrator'): Observation {
    return {
        source: 'conversation',
        kind: 'topic.message.received',
        payload: {
            kind: 'topic.message.received',
            message: {
                id,
                conversation: { kind: 'topic', id: 'topic-1' },
                senderAgentId: 'participant-agent',
                senderMemberId: 'skeptical_fact_checker',
                recipientAgentId: 'owner-agent',
                recipientMemberId,
                speechAct: 'answer',
                content: { body: { phase: 'suite_agent_contribution', phaseId: 'synthesis' } },
                sequenceNumber: 23,
                ts: '2020-01-01T00:00:00.000Z',
            },
            topic: { kind: 'topic', id: 'topic-1' },
            selector: { kind: 'explicit_recipient', recipient: { by: 'memberId', memberId: recipientMemberId } },
            recipient: { memberId: recipientMemberId, agentId: 'owner-agent' },
        },
    } as Observation;
}

describe('conversationInboxIdentity', () => {
    it('matches observation key to turn summary key for thread message.received', () => {
        const obs: Observation = {
            source: 'conversation',
            payload: {
                kind: 'message.received',
                message: {
                    id: 'mid-1',
                    conversation: { kind: 'thread', id: 'th-1' },
                    senderAgentId: 'a1',
                    senderMemberId: 'a1',
                    recipientAgentId: 'a2',
                    recipientMemberId: 'a2',
                    speechAct: 'inform',
                    content: {},
                    sequenceNumber: 1,
                    ts: '2020-01-01T00:00:00.000Z',
                },
            },
        } as Observation;
        const fromObs = conversationInboxDeliveryKey(obs);
        const fromSummary = conversationInboxDeliveryKeyFromTurnSummary({
            id: 'mid-1',
            conversationId: 'th-1',
            kind: 'thread',
            senderAgentId: 'a1',
            recipientAgentId: 'a2',
            senderMemberId: 'a1',
            recipientMemberId: 'a2',
            speechAct: 'inform',
            sequenceNumber: 1,
        });
        expect(fromObs).toBe(fromSummary);
        expect(fromObs).toBe('message.received|mid-1|th-1|thread|a2');
    });

    it('matches observation key to turn summary for topic.message.received', () => {
        const obs: Observation = {
            source: 'conversation',
            payload: {
                kind: 'topic.message.received',
                message: {
                    id: 'mid-2',
                    conversation: { kind: 'topic', id: 'tp-1' },
                    senderAgentId: 'owner',
                    senderMemberId: 'owner',
                    recipientAgentId: 'p1',
                    recipientMemberId: 'util',
                    speechAct: 'inform',
                    content: {},
                    sequenceNumber: 2,
                    ts: '2020-01-01T00:00:00.000Z',
                },
            },
        } as Observation;
        const fromSummary = conversationInboxDeliveryKeyFromTurnSummary({
            id: 'mid-2',
            conversationId: 'tp-1',
            kind: 'topic',
            senderAgentId: 'owner',
            recipientAgentId: 'p1',
            senderMemberId: 'owner',
            recipientMemberId: 'util',
            speechAct: 'inform',
            sequenceNumber: 2,
        });
        expect(conversationInboxDeliveryKey(obs)).toBe(fromSummary);
    });

    it('inboxAllHasConversationDeliveryKey detects duplicate', () => {
        const o: Observation = {
            source: 'conversation',
            payload: {
                kind: 'message.received',
                message: {
                    id: 'x',
                    conversation: { kind: 'thread', id: 't' },
                    senderAgentId: 'a',
                    senderMemberId: 'a',
                    recipientAgentId: 'b',
                    recipientMemberId: 'b',
                    speechAct: 'inform',
                    content: {},
                    sequenceNumber: 1,
                    ts: '2020-01-01T00:00:00.000Z',
                },
            },
        } as Observation;
        const inbox = normalizeObservationInbox({ current: [o], all: [o] });
        const k = conversationInboxDeliveryKey(o)!;
        expect(inboxAllHasConversationDeliveryKey(inbox, k)).toBe(true);
    });

    it('filters consumed conversation deliveries out of current only', () => {
        const o: Observation = {
            source: 'conversation',
            payload: {
                kind: 'message.received',
                message: {
                    id: 'consumed',
                    conversation: { kind: 'thread', id: 't' },
                    senderAgentId: 'a',
                    senderMemberId: 'a',
                    recipientAgentId: 'b',
                    recipientMemberId: 'b',
                    speechAct: 'inform',
                    content: {},
                    sequenceNumber: 1,
                    ts: '2020-01-01T00:00:00.000Z',
                },
            },
        } as Observation;
        const internalObs = { source: 'internal', kind: 'state.noted', payload: {} } as Observation;
        const key = conversationInboxDeliveryKey(o);
        expect(key).toBeDefined();
        if (key === undefined) {
            return;
        }
        const filtered = filterInboxCurrentByConversationDeliveryKeys(
            normalizeObservationInbox({ current: [o, internalObs], all: [o, internalObs] }),
            new Set([key])
        );
        expect(filtered.current).toEqual([internalObs]);
        expect(filtered.all).toHaveLength(2);
        expect(conversationInboxDeliveryKey(filtered.all[0] as Observation)).toBe(key);
        expect(filtered.all[1]).toEqual(internalObs);
    });

    it('round-trips consumed delivery keys through metadata', () => {
        const meta = writeConsumedConversationDeliveryKeysToMeta(
            { existing: true },
            new Set(['k1', 'k2'])
        );
        expect([...readConsumedConversationDeliveryKeysFromMeta(meta)]).toEqual(['k1', 'k2']);
        expect(meta.existing).toBe(true);
    });

    it('preserves remote conversation deliveries when a stale snapshot candidate lacks them', () => {
        const delivered = topicMessage('msg-preserve');
        const merged = preserveConversationInboxForSnapshot(
            {
                inbox: { current: [], all: [] },
                meta: { local: true },
            },
            {
                inbox: { current: [delivered], all: [delivered] },
                meta: { remote: true },
            }
        );
        const inbox = normalizeObservationInbox(merged.inbox);
        expect(inbox.all.map((obs) => (obs as any).payload?.message?.id)).toContain('msg-preserve');
        expect(inbox.current.map((obs) => (obs as any).payload?.message?.id)).toContain('msg-preserve');
    });

    it('preserves consumed conversation deliveries in all but not current', () => {
        const delivered = topicMessage('msg-consumed');
        const key = conversationInboxDeliveryKey(delivered);
        expect(key).toBeDefined();
        if (!key) return;

        const merged = preserveConversationInboxForSnapshot(
            {
                inbox: { current: [], all: [] },
                meta: writeConsumedConversationDeliveryKeysToMeta({}, new Set([key])),
            },
            {
                inbox: { current: [delivered], all: [delivered] },
                meta: {},
            }
        );
        const inbox = normalizeObservationInbox(merged.inbox);
        expect(inbox.all.map((obs) => (obs as any).payload?.message?.id)).toContain('msg-consumed');
        expect(inbox.current.map((obs) => (obs as any).payload?.message?.id)).not.toContain('msg-consumed');
    });

    it('SessionManager.saveSnapshot preserves routed conversation delivery from stale candidate with fresh expected version', async () => {
        const store = new InMemorySessionManager();
        const sessionManager = new SessionManager(store);
        const tenantId = 'tenant-preserve';
        const sessionId = 'owner-session';
        const agentId = 'owner-agent';
        const staleBase = {
            inbox: { current: [], all: [] },
            meta: { agentId },
            M: { memory: { sensory: { stage: 'phase_requested' } } },
        };

        const first = await sessionManager.saveSnapshot({
            tenantId,
            sessionId,
            agentId,
            expectedWmVersion: BigInt(0),
            snapshot: staleBase,
        });
        const routed = topicMessage('msg-routed');
        await sessionManager.saveSnapshot({
            tenantId,
            sessionId,
            agentId,
            expectedWmVersion: first?.newVersion ?? BigInt(1),
            snapshot: {
                ...staleBase,
                inbox: { current: [routed], all: [routed] },
            },
        });
        const current = await sessionManager.load(tenantId, sessionId);

        await sessionManager.saveSnapshot({
            tenantId,
            sessionId,
            agentId,
            expectedWmVersion: current?.wmVersion ?? BigInt(2),
            snapshot: {
                ...staleBase,
                M: { memory: { sensory: { stage: 'phase_complete' } } },
            },
        });

        const after = await sessionManager.load(tenantId, sessionId);
        const inbox = normalizeObservationInbox((after?.snapshot as any)?.inbox);
        expect(inbox.all.map((obs) => (obs as any).payload?.message?.id)).toContain('msg-routed');
        expect(inbox.current.map((obs) => (obs as any).payload?.message?.id)).toContain('msg-routed');
    });
});

describe('readLoopBudgetsFromSnapshotMeta', () => {
    it('prefers meta.budgets over legacy meta.maxTurns', () => {
        expect(
            readLoopBudgetsFromSnapshotMeta({ budgets: { maxTurns: 80, latencyMs: 5000 } })
        ).toEqual({ maxTurns: 80, latencyMs: 5000 });
    });

    it('falls back to top-level maxTurns when budgets absent', () => {
        expect(readLoopBudgetsFromSnapshotMeta({ maxTurns: 12, latencyMs: 100 })).toEqual({
            maxTurns: 12,
            latencyMs: 100,
        });
    });

    it('returns undefined when no budgets', () => {
        expect(readLoopBudgetsFromSnapshotMeta({})).toBeUndefined();
    });
});
