import { describe, it, expect } from '@jest/globals';
import { applyWakeToSnapshot } from '../../src/runtime/segmentWakeApplicator.js';
import { InboxManager } from '../../src/orchestration/InboxManager.js';

describe('applyWakeToSnapshot', () => {
    const base = {
        meta: { turn: 2, agentId: 'agent-a' },
        pending: {
            inputs: { 'tok-in': { schema: { type: 'string' } } },
            tools: { 'tok-tool': { name: 'search', args: {} } },
        },
        inbox: InboxManager.normalizeInbox(undefined),
    };

    it('start wake passes input through to turn params', () => {
        const prepared = applyWakeToSnapshot(base, { trigger: 'start', input: { q: 'hi' } });
        expect(prepared.trigger).toBe('start');
        expect(prepared.turnParams.input).toEqual({ q: 'hi' });
        expect(prepared.agentId).toBe('agent-a');
    });

    it('resume wake applies input.provided observation and clears pending token', () => {
        const prepared = applyWakeToSnapshot(base, {
            trigger: 'resume',
            event: { kind: 'input', token: 'tok-in', value: 'answer' },
        });
        expect(prepared.trigger).toBe('resume');
        const inbox = prepared.snapshot.inbox as { current: Array<{ kind: string; payload: unknown }> };
        expect(inbox.current[0]?.kind).toBe('input.provided');
        expect((inbox.current[0]?.payload as { value: string }).value).toBe('answer');
        expect((prepared.snapshot.pending as { inputs?: Record<string, unknown> }).inputs?.['tok-in']).toBeUndefined();
    });

    it('tool wake adds tool.completed observation and clears pending tool', () => {
        const prepared = applyWakeToSnapshot(base, {
            trigger: 'tool',
            event: { kind: 'tool', token: 'tok-tool', result: { hits: 1 } },
        });
        expect(prepared.trigger).toBe('tool');
        const inbox = prepared.snapshot.inbox as { current: Array<{ kind: string }> };
        expect(inbox.current[0]?.kind).toBe('tool.completed');
        expect(
            (prepared.snapshot.pending as { tools?: Record<string, unknown> }).tools?.['tok-tool']
        ).toBeUndefined();
    });

    it('child wake adds child.completed observation', () => {
        const prepared = applyWakeToSnapshot(base, {
            trigger: 'child',
            event: {
                kind: 'child',
                token: 'child-tok',
                childTaskId: 'child-1',
                output: { result: { ok: true }, childTaskId: 'child-1' },
            },
        });
        expect(prepared.trigger).toBe('resume');
        const inbox = prepared.snapshot.inbox as { current: Array<{ kind: string }> };
        expect(inbox.current[0]?.kind).toBe('child.completed');
    });
});
