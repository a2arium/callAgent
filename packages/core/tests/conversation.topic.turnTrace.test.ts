import { createTestHarness } from '../src/testing/TestHarness.js';
import type { MentalState, EnvironmentState, MemoryReader, MemoryWriter } from '../src/loop/types.js';
import type { Intent } from '../src/types/intent.js';
import type { TaskContext } from '../src/shared/types/index.js';
import type { ExecOutcome } from '../src/types/execOutcome.js';
import { TurnTraceSchema } from '../src/types/turnTrace.js';

type Sensory = { run?: boolean };
type Obs = { kind: 'user' } | { kind: 'idle' };
type ExecPayload = Record<string, unknown>;
type ExecError = { code: string; message: string };

describe('TurnTrace topic fan-out stamping', () => {
    it('stamps topicSelectorDecision and fanoutSummary on topic post', async () => {
        const harness = createTestHarness<Sensory>(
            {
                attention: () => undefined as never,
                perception: (env: EnvironmentState) => {
                    const hasUser = env.inbox.current.some((o) => o.source === 'user');
                    return hasUser ? { kind: 'user' as const } : { kind: 'idle' as const };
                },
                learning: (
                    prev: MentalState<Sensory>,
                    _a: Intent | undefined,
                    obs: Obs,
                    _mem: MemoryReader,
                    _w: MemoryWriter
                ) =>
                    obs.kind === 'user'
                        ? { ...prev, sensory: { ...prev.sensory, run: true } }
                        : prev,
                policy: (m: MentalState<Sensory>) => {
                    if (m.sensory?.run) {
                        return { kind: 'internal' as const, intent: 'topic_post_stamp', data: {} };
                    }
                    return { kind: 'wait' as const };
                },
                shield: (_m, intent: Intent) => ({ action: 'pass' as const, intent }),
                execution: async (intent: Intent, ctx: TaskContext): Promise<ExecOutcome<ExecPayload, ExecError>> => {
                    if (intent.kind !== 'internal' || intent.intent !== 'topic_post_stamp') {
                        return {
                            action: { kind: 'internal', done: true },
                            result: { status: 'error', error: { code: 'x', message: 'bad' } },
                        };
                    }
                    const topic = { kind: 'topic' as const, id: 'topic-trace-fanout' };
                    const c = await ctx.conversation!.createTopic({
                        topicId: topic.id,
                        members: [
                            { agentId: ctx.agentId, role: 'owner' },
                            { agentId: 'fanout-peer', role: 'participant' },
                        ],
                        defaultSelector: { kind: 'broadcast' },
                    });
                    if (c.status !== 'ok') {
                        return {
                            action: { kind: 'internal', done: true },
                            result: { status: 'error', error: { code: 'c', message: 'create' } },
                        };
                    }
                    await ctx.conversation!.post(
                        c.topic,
                        { senderAgentId: ctx.agentId, speechAct: 'inform', content: { n: 1 } },
                        { selector: { kind: 'broadcast' } }
                    );
                    return {
                        action: { kind: 'internal', done: true },
                        result: { status: 'ok', data: {} },
                    };
                },
                transition: () => ({ kind: 'complete' as const }),
            },
            {}
        );

        harness.injectUserInput({ text: 'run' });
        await harness.runTurn();

        const trace = TurnTraceSchema.parse(harness.lastTrace());
        expect(trace.conversation?.kind).toBe('topic');
        expect(trace.topicSelectorDecision?.kind).toBe('broadcast');
        expect(trace.topicSelectorDecision?.resolvedMembers).toEqual([
            { memberId: 'fanout-peer', agentId: 'fanout-peer' },
        ]);
        expect(trace.fanoutSummary?.accepted).toBe(1);
        expect(trace.fanoutSummary?.rejected).toBe(0);
    });
});
