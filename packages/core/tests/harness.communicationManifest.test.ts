import { describe, it, expect, afterEach, jest } from '@jest/globals';
import { createTestHarness } from '../src/testing/TestHarness.js';
import type { Intent } from '../src/types/intent.js';
import { EngineLocator } from '../src/orchestration/EngineLocator.js';
import type { TaskEngine } from '../src/orchestration/taskEngine.js';
import { HarnessConfigSchema } from '../src/testing/harnessTypes.js';
import type { MessageLog } from '../src/public-types/messageLog/types.js';
import type { MessageLogAppendResult } from '../src/public-types/messageLog/schemas.js';

describe('TestHarness communication manifest & adapters', () => {
    afterEach(() => {
        EngineLocator.setEngine(null as unknown as TaskEngine);
    });

    it('HarnessConfig aliases __strict__ / strictPolicies to policyPurityStrict', () => {
        const a = HarnessConfigSchema.parse({ __strict__: false });
        expect(a.policyPurityStrict).toBe(false);
        const b = HarnessConfigSchema.parse({ strictPolicies: false });
        expect(b.policyPurityStrict).toBe(false);
        const c = HarnessConfigSchema.parse({});
        expect(c.policyPurityStrict).toBe(true);
    });

    it('setCommunicationManifest supplies topicSweeper when HarnessConfig omits it', async () => {
        const sweep = jest.fn().mockResolvedValue({ archivedTopicIds: [] });
        EngineLocator.setEngine({ triggerTopicLifecycleSweep: sweep } as unknown as TaskEngine);

        let turn = 0;
        const harness = createTestHarness(
            {
                attention: () => undefined as never,
                perception: () => ({ kind: 'idle' as const }),
                learning: (prev) => prev,
                policy: () => ({ kind: 'internal' as const, intent: 'noop', data: {} }),
                shield: (_m, intent: Intent) => ({ action: 'pass' as const, intent }),
                execution: async () => {
                    await new Promise<void>((resolve) => setTimeout(resolve, 25));
                    return {
                        action: { kind: 'internal' as const, done: true },
                        result: { status: 'ok' as const, data: {} },
                    };
                },
                transition: () => {
                    turn++;
                    if (turn < 5) {
                        return {
                            kind: 'continue' as const,
                            observations: [
                                {
                                    source: 'internal' as const,
                                    kind: 'state.noted' as const,
                                    payload: { harnessCommManifestTestTurn: turn },
                                },
                            ],
                        };
                    }
                    return { kind: 'complete' as const };
                },
            },
            { maxTurns: 10 }
        );

        harness.setCommunicationManifest({
            topicSweeper: {
                intervalMs: 20,
                batchSize: 11,
                autoArchiveAfterMs: 99_000,
            },
        });

        await harness.runTurn();

        expect(sweep).toHaveBeenCalled();
        expect(sweep.mock.calls[0]![0]).toMatchObject({
            tenantId: 'test-tenant',
            limit: 11,
            autoArchiveAfterMs: 99_000,
        });
    });

    it('useMessageLogAdapter switches ConversationService message log', async () => {
        const append = jest.fn(
            async (): Promise<MessageLogAppendResult> => ({
                kind: 'appended',
                messageId: 'harness-ml-stub-msg-1',
                sequenceNumber: 1,
                createdAt: new Date().toISOString(),
            })
        );
        const read = jest.fn().mockResolvedValue([]);
        async function* replay() {}
        const findByIdempotency = jest.fn().mockResolvedValue(null);
        const stubLog = { append, read, replay, findByIdempotency };

        const harness = createTestHarness(
            {
                attention: () => undefined as never,
                perception: () => ({ kind: 'user' as const }),
                learning: (prev) => prev,
                policy: () => ({ kind: 'internal' as const, intent: 'thr', data: {} }),
                shield: (_m, intent: Intent) => ({ action: 'pass' as const, intent }),
                execution: async (intent: Intent, ctx) => {
                    if (intent.kind !== 'internal' || intent.intent !== 'thr') {
                        return {
                            action: { kind: 'internal', done: true },
                            result: { status: 'error', error: { code: 'x', message: 'bad' } },
                        };
                    }
                    await ctx.conversation!.startThread({
                        targetAgentId: 'peer-ml',
                        conversationId: 'thr-ml-1',
                        message: {
                            senderAgentId: ctx.agentId,
                            speechAct: 'inform',
                            content: { n: 1 },
                        },
                    });
                    return {
                        action: { kind: 'internal', done: true },
                        result: { status: 'ok', data: {} },
                    };
                },
                transition: () => ({ kind: 'complete' as const }),
            },
            {}
        );

        harness.useMessageLogAdapter(stubLog as unknown as MessageLog);
        harness.injectUserInput({ text: 'x' });
        await harness.runTurn();

        expect(append).toHaveBeenCalled();
    });
});
