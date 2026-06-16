import { describe, it, expect } from '@jest/globals';
import { buildDriverRunMetadata } from '../src/metadata.js';

describe('buildDriverRunMetadata', () => {
    it('builds composite search keys', () => {
        const metadata = buildDriverRunMetadata({
            outboxRowId: 'row-1',
            eventType: 'task.status',
            tenantId: 'tenant-a',
            taskId: 'task-1',
            traceId: 'trace-1',
            token: 'tok-1',
            agentId: 'agent-1',
        });
        expect(metadata.tenantTaskKey).toBe('tenant-a:task-1');
        expect(metadata.tenantTraceKey).toBe('tenant-a:trace-1');
        expect(metadata.taskTokenKey).toBe('task-1:tok-1');
        expect(metadata.agentId).toBe('agent-1');
        expect(metadata.outboxRowId).toBe('row-1');
    });
});
