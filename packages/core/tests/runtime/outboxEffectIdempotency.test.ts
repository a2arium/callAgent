import { describe, expect, it } from '@jest/globals';
import { InMemorySessionManager } from '../../src/orchestration/InMemorySessionManager.js';
import { SessionManager, type OutboxEnqueuedRef } from '../../src/orchestration/SessionManager.js';

describe('outbox effect idempotency', () => {
    it('returns the existing outbox row for duplicate idempotency keys', async () => {
        const store = new InMemorySessionManager();
        const first = await store.enqueueOutbox({
            tenantId: 'tenant-1',
            topic: 'task.status',
            key: 'task-1',
            payload: { taskId: 'task-1' },
            idempotencyKey: 'task-1:start:outbox:task.status:1',
        });
        const second = await store.enqueueOutbox({
            tenantId: 'tenant-1',
            topic: 'task.status',
            key: 'task-1',
            payload: { taskId: 'task-1' },
            idempotencyKey: 'task-1:start:outbox:task.status:1',
        });

        expect(second.id).toBe(first.id);
    });
});

describe('outbox dispatch metadata enrichment', () => {
    it('threads agentId from the stored session snapshot', async () => {
        const store = new InMemorySessionManager();
        const sessionManager = new SessionManager(store);
        const refs: OutboxEnqueuedRef[] = [];
        sessionManager.setOnOutboxEnqueued((ref) => {
            refs.push(ref);
        });

        await sessionManager.saveSnapshot({
            tenantId: 'tenant-1',
            sessionId: 'task-1',
            agentId: 'agent-1',
            expectedWmVersion: BigInt(0),
            snapshot: { meta: { agentId: 'agent-1' } },
        });
        await sessionManager.enqueueOutbox('tenant-1', 'task.status', 'task-1', {
            taskId: 'task-1',
        });

        expect(refs[0]?.agentId).toBe('agent-1');
    });
});
