import {
    ensureTaskReplyDeliveryMode,
    readTaskReplyDeliveryMode,
    TaskReplyDeliveryModeConflictError,
    taskReplyDeliveryModeFromStreaming,
} from '../src/context/taskReplyDelivery.js';

describe('task reply delivery mode', () => {
    it('persists streaming and buffered modes without replacing other metadata', () => {
        const streaming = ensureTaskReplyDeliveryMode(
            { meta: { agentId: 'agent-a' } },
            taskReplyDeliveryModeFromStreaming(true)
        );
        const buffered = ensureTaskReplyDeliveryMode(
            { meta: { agentId: 'agent-b' } },
            taskReplyDeliveryModeFromStreaming(false)
        );

        expect(streaming.changed).toBe(true);
        expect(streaming.snapshot).toEqual({
            meta: { agentId: 'agent-a', replyDeliveryMode: 'stream' },
        });
        expect(buffered.snapshot).toEqual({
            meta: { agentId: 'agent-b', replyDeliveryMode: 'buffer' },
        });
    });

    it('treats an identical retry as a no-op', () => {
        const snapshot = { meta: { replyDeliveryMode: 'stream' } };
        const result = ensureTaskReplyDeliveryMode(snapshot, 'stream');

        expect(result.changed).toBe(false);
        expect(result.snapshot).toBe(snapshot);
        expect(readTaskReplyDeliveryMode(result.snapshot)).toBe('stream');
    });

    it('rejects changing the mode of an existing task', () => {
        expect(() => ensureTaskReplyDeliveryMode(
            { meta: { replyDeliveryMode: 'buffer' } },
            'stream'
        )).toThrow(expect.objectContaining({
            code: 'TASK_REPLY_DELIVERY_MODE_CONFLICT',
        }) as TaskReplyDeliveryModeConflictError);
    });

    it('returns undefined for historical snapshots without the metadata', () => {
        expect(readTaskReplyDeliveryMode({ meta: { agentId: 'legacy-agent' } }))
            .toBeUndefined();
    });
});
