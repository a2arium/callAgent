import { createTestHarness } from '../src/testing/TestHarness.js';
import type { MentalState, EnvironmentState, MemoryReader, MemoryWriter } from '../src/loop/types.js';
import type { Intent } from '../src/types/intent.js';
import type { TaskContext } from '../src/shared/types/index.js';
import type { ExecOutcome } from '../src/types/execOutcome.js';
import { TurnTraceSchema } from '../src/types/turnTrace.js';

type Sensory = { sawUser?: boolean };
type Obs = { kind: 'user' } | { kind: 'idle' };
type ExecPayload = Record<string, unknown>;
type ExecError = { code: string; message: string };

describe('TurnTrace conversation stamping', () => {
    it('includes conversation summaries when ctx.conversation is used', async () => {
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
                        ? { ...prev, sensory: { ...prev.sensory, sawUser: true } }
                        : prev,
                policy: (m: MentalState<Sensory>) => {
                    if (m.sensory?.sawUser) {
                        return { kind: 'internal' as const, intent: 'conv_stamp_open', data: {} };
                    }
                    return { kind: 'wait' as const };
                },
                shield: (_m, intent: Intent) => ({ action: 'pass' as const, intent }),
                execution: async (intent: Intent, ctx: TaskContext): Promise<ExecOutcome<ExecPayload, ExecError>> => {
                    if (intent.kind !== 'internal' || intent.intent !== 'conv_stamp_open') {
                        return {
                            action: { kind: 'internal', done: true },
                            result: { status: 'error', error: { code: 'x', message: 'bad' } },
                        };
                    }
                    const r = await ctx.conversation!.startThread({
                        targetAgentId: 'child-x',
                        conversationId: 'thread-trace-stamp-1',
                        message: {
                            senderAgentId: ctx.agentId,
                            speechAct: 'inform',
                            content: { n: 1 },
                        },
                    });
                    if (r.receipt.status !== 'accepted') {
                        return {
                            action: { kind: 'internal', done: true },
                            result: { status: 'error', error: { code: 'c', message: 'open' } },
                        };
                    }
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

        const trace = harness.lastTrace();
        const parsed = TurnTraceSchema.parse(trace);
        expect(parsed.conversation?.id).toBe('thread-trace-stamp-1');
        expect(parsed.conversation?.kind).toBe('thread');
        expect(parsed.outgoingMessages?.length).toBeGreaterThanOrEqual(1);
        expect(parsed.messageSequenceNumber).toBeDefined();
        expect(parsed.dedupeHit).not.toBe(true);
    });

    it('omits conversation fields on turns without conversation traffic', async () => {
        const harness = createTestHarness<Sensory>(
            {
                attention: () => undefined as never,
                perception: () => ({ kind: 'user' as const }),
                learning: (prev) => ({ ...prev, sensory: { sawUser: true } }),
                policy: () => ({ kind: 'internal' as const, intent: 'noop_plain', data: {} }),
                shield: (_m, intent: Intent) => ({ action: 'pass' as const, intent }),
                execution: async (intent: Intent): Promise<ExecOutcome<ExecPayload, ExecError>> => {
                    if (intent.kind === 'internal' && intent.intent === 'noop_plain') {
                        return {
                            action: { kind: 'internal', done: true },
                            result: { status: 'ok', data: {} },
                        };
                    }
                    return {
                        action: { kind: 'internal', done: true },
                        result: { status: 'error', error: { code: 'x', message: 'unexpected' } },
                    };
                },
                transition: () => ({ kind: 'complete' as const }),
            },
            {}
        );

        harness.injectUserInput({ text: 'x' });
        await harness.runTurn();

        const trace = TurnTraceSchema.parse(harness.lastTrace());
        expect(trace.conversation).toBeUndefined();
        const incoming = trace.incomingMessages ?? [];
        const outgoing = trace.outgoingMessages ?? [];
        expect(incoming).toHaveLength(0);
        expect(outgoing).toHaveLength(0);
    });
});
