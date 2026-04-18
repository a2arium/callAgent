import { describe, it, expect } from '@jest/globals';
import { createTestHarness } from '../src/testing/TestHarness.js';
import type { MentalState, EnvironmentState, MemoryReader, MemoryWriter } from '../src/loop/types.js';
import type { Intent } from '../src/types/intent.js';
import type { TaskContext } from '../src/shared/types/index.js';
import type { ExecOutcome } from '../src/types/execOutcome.js';
type Sensory = { ran?: boolean };
type Obs = { kind: 'user' } | { kind: 'idle' };
type ExecPayload = Record<string, unknown>;
type ExecError = { code: string; message: string };

describe('TestHarness topic policy registration', () => {
    it('registerTopicSelectorPolicy is used by ctx.conversation.post with selector_policy', async () => {
        const harness = createTestHarness<Sensory>(
            {
                attention: () => undefined as never,
                perception: (env: EnvironmentState) =>
                    env.inbox.current.some((o) => o.source === 'user')
                        ? { kind: 'user' as const }
                        : { kind: 'idle' as const },
                learning: (
                    prev: MentalState<Sensory>,
                    _a: Intent | undefined,
                    obs: Obs,
                    _mem: MemoryReader,
                    _w: MemoryWriter
                ) =>
                    obs.kind === 'user' ? { ...prev, sensory: { ...prev.sensory, ran: true } } : prev,
                policy: (m: MentalState<Sensory>) =>
                    m.sensory?.ran
                        ? { kind: 'internal' as const, intent: 'topic_sel_reg', data: {} }
                        : { kind: 'wait' as const },
                shield: (_m, intent: Intent) => ({ action: 'pass' as const, intent }),
                execution: async (intent: Intent, ctx: TaskContext): Promise<ExecOutcome<ExecPayload, ExecError>> => {
                    if (intent.kind !== 'internal' || intent.intent !== 'topic_sel_reg') {
                        return {
                            action: { kind: 'internal', done: true },
                            result: { status: 'error', error: { code: 'x', message: 'bad' } },
                        };
                    }
                    harness.registerTopicSelectorPolicy({
                        policyId: 'harness-pick-peer',
                        select: (c) => {
                            const peer = c.members.find((m) => m.memberId !== c.senderMemberId);
                            if (!peer) {
                                return {
                                    kind: 'rejected',
                                    error: { type: 'PolicyInternalError', message: 'no peer' },
                                };
                            }
                            return {
                                kind: 'selected',
                                recipients: [peer],
                                nextRotationCursor: null,
                            };
                        },
                    });
                    const topic = { kind: 'topic' as const, id: 'topic-reg-sel' };
                    const c = await ctx.conversation!.createTopic({
                        topicId: topic.id,
                        members: [
                            { agentId: ctx.agentId, role: 'owner' },
                            { agentId: 'peer-reg', role: 'participant' },
                        ],
                        defaultSelector: { kind: 'broadcast' },
                        stopPolicies: [{ kind: 'maxTurns', n: 99 }],
                    });
                    if (c.status !== 'ok') {
                        return {
                            action: { kind: 'internal', done: true },
                            result: { status: 'error', error: { code: 'c', message: 'create' } },
                        };
                    }
                    const post = await ctx.conversation!.post(
                        c.topic,
                        { senderAgentId: ctx.agentId, speechAct: 'inform', content: { n: 1 } },
                        { selector: { kind: 'selector_policy', policyId: 'harness-pick-peer' } }
                    );
                    if (post.status !== 'accepted') {
                        return {
                            action: { kind: 'internal', done: true },
                            result: { status: 'error', error: { code: 'p', message: 'post' } },
                        };
                    }
                    expect(post.deliveries).toHaveLength(1);
                    expect(String(post.deliveries[0]!.memberId)).toBe('peer-reg');
                    return {
                        action: { kind: 'internal', done: true },
                        result: { status: 'ok', data: {} },
                    };
                },
                transition: () => ({ kind: 'complete' as const }),
            },
            {}
        );

        harness.injectUserInput({ text: 'go' });
        await harness.runTurn();
    });

    it('registerStopPolicy is used after post', async () => {
        const harness = createTestHarness<Sensory>(
            {
                attention: () => undefined as never,
                perception: (env: EnvironmentState) =>
                    env.inbox.current.some((o) => o.source === 'user')
                        ? { kind: 'user' as const }
                        : { kind: 'idle' as const },
                learning: (
                    prev: MentalState<Sensory>,
                    _a: Intent | undefined,
                    obs: Obs,
                    _mem: MemoryReader,
                    _w: MemoryWriter
                ) =>
                    obs.kind === 'user' ? { ...prev, sensory: { ...prev.sensory, ran: true } } : prev,
                policy: (m: MentalState<Sensory>) =>
                    m.sensory?.ran
                        ? { kind: 'internal' as const, intent: 'topic_stop_reg', data: {} }
                        : { kind: 'wait' as const },
                shield: (_m, intent: Intent) => ({ action: 'pass' as const, intent }),
                execution: async (intent: Intent, ctx: TaskContext): Promise<ExecOutcome<ExecPayload, ExecError>> => {
                    if (intent.kind !== 'internal' || intent.intent !== 'topic_stop_reg') {
                        return {
                            action: { kind: 'internal', done: true },
                            result: { status: 'error', error: { code: 'x', message: 'bad' } },
                        };
                    }
                    harness.registerStopPolicy({
                        policyId: 'harness-always-stop',
                        evaluate: () => ({ kind: 'stop', reason: 'from-test' }),
                    });
                    const topic = { kind: 'topic' as const, id: 'topic-reg-stop' };
                    const c = await ctx.conversation!.createTopic({
                        topicId: topic.id,
                        members: [
                            { agentId: ctx.agentId, role: 'owner' },
                            { agentId: 'peer2', role: 'participant' },
                        ],
                        defaultSelector: { kind: 'broadcast' },
                        stopPolicies: [{ kind: 'custom', policyId: 'harness-always-stop' }],
                    });
                    if (c.status !== 'ok') {
                        return {
                            action: { kind: 'internal', done: true },
                            result: { status: 'error', error: { code: 'c', message: 'create' } },
                        };
                    }
                    await ctx.conversation!.post(
                        c.topic,
                        { senderAgentId: ctx.agentId, speechAct: 'inform', content: {} },
                        { selector: { kind: 'broadcast' } }
                    );
                    const post2 = await ctx.conversation!.post(
                        c.topic,
                        { senderAgentId: ctx.agentId, speechAct: 'inform', content: {} },
                        { selector: { kind: 'broadcast' } }
                    );
                    expect(post2.status).toBe('rejected');
                    return {
                        action: { kind: 'internal', done: true },
                        result: { status: 'ok', data: {} },
                    };
                },
                transition: () => ({ kind: 'complete' as const }),
            },
            {}
        );

        harness.injectUserInput({ text: 'go' });
        await harness.runTurn();
    });
});
