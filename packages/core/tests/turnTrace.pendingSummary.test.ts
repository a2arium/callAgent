import { describe, it, expect } from '@jest/globals';
import { summarizePending, summarizeInbox } from '../src/telemetry/turnTraceHelpers.js';

describe('turnTraceHelpers', () => {
    describe('summarizePending', () => {
        it('empty pending produces empty arrays', () => {
            const summary = summarizePending({});
            expect(summary.inputTokens).toEqual([]);
            expect(summary.toolTokens).toEqual([]);
            expect(summary.childTokens).toEqual([]);
            expect(summary.stage).toBeUndefined();
        });

        it('single pending input token produces one entry in inputTokens', () => {
            const summary = summarizePending({
                inputs: { 'input-token-1': {} },
            });
            expect(summary.inputTokens).toEqual(['input-token-1']);
        });

        it('multiple pending tool tokens produce entries with tool names', () => {
            const summary = summarizePending({
                tools: {
                    'tool-token-1': { tool: 'fetch' },
                    'tool-token-2': { tool: 'search' },
                },
            });
            expect(summary.toolTokens).toHaveLength(2);
            expect(summary.toolTokens.map((t) => t.token).sort()).toEqual(['tool-token-1', 'tool-token-2']);
            expect(summary.toolTokens.find((t) => t.token === 'tool-token-1')?.tool).toBe('fetch');
        });

        it('pending child tokens include agent IDs when available', () => {
            const summary = summarizePending({
                children: {
                    'child-token-1': { agentId: 'sub-agent-a' },
                    'child-token-2': {},
                },
            });
            expect(summary.childTokens).toHaveLength(2);
            expect(summary.childTokens.find((c) => c.token === 'child-token-1')?.agentId).toBe('sub-agent-a');
        });

        it('includes stage from controlVars when present', () => {
            const summary = summarizePending({
                controlVars: { stage: 'awaiting_tool' },
            });
            expect(summary.stage).toBe('awaiting_tool');
        });
    });

    describe('summarizeInbox', () => {
        it('returns compact summary with source, kind, and token when present', () => {
            const inbox = [
                { source: 'user', kind: 'input', payload: { token: 'tok-1' } },
                { source: 'child', kind: 'child.completed', payload: {} },
            ];
            const summary = summarizeInbox(inbox);
            expect(summary).toHaveLength(2);
            expect(summary[0]).toEqual({ source: 'user', kind: 'input', hasToken: true, token: 'tok-1' });
            expect(summary[1].source).toBe('child');
            expect(summary[1].kind).toBe('child.completed');
        });

        it('handles empty inbox', () => {
            expect(summarizeInbox([])).toEqual([]);
        });

        it('includes conversation message tokenization metadata', () => {
            const inbox = [
                {
                    source: 'conversation',
                    kind: 'message.received',
                    payload: {
                        kind: 'message.received',
                        message: {
                            id: 'msg-1',
                            conversation: { kind: 'thread', id: 'thread-1' },
                            senderAgentId: 'a',
                            recipientAgentId: 'b',
                            speechAct: 'inform',
                            content: {},
                            sequenceNumber: 1,
                            idempotencyKey: 'idem-1',
                            ts: new Date().toISOString(),
                        },
                    },
                },
            ];
            const summary = summarizeInbox(inbox);
            expect(summary).toHaveLength(1);
            expect(summary[0]).toMatchObject({
                source: 'conversation',
                kind: 'message.received',
            });
        });
    });
});
