import { describe, expect, it } from '@jest/globals';
import { createTestHarness } from '../src/testing/TestHarness.js';
import { recordTurnTraceExtension } from '../src/telemetry/recordTurnTraceExtension.js';
import {
    TurnTraceExtensionSchema,
    TurnTraceSchema,
    type TurnTrace,
} from '../src/types/turnTrace.js';
import type { Intent } from '../src/types/intent.js';

const validTimings = {
    attentionMs: 0,
    perceptionMs: 0,
    learningMs: 0,
    policyMs: 0,
    shieldMs: 0,
    executionMs: 0,
    transitionMs: 0,
    totalMs: 0,
};

const minimalTrace = (overrides: Partial<TurnTrace> = {}): TurnTrace => ({
    turn: 1,
    turnId: 'test-turn-id',
    agentCardSource: 'inline',
    runtimeManifestSource: 'inline',
    agentCardHash: '',
    runtimeManifestHash: '',
    stageBefore: 'idle',
    inboxCurrent: [],
    timings: validTimings,
    ...overrides,
});

describe('TurnTraceExtensionSchema', () => {
    it('accepts omitted extensions on TurnTrace', () => {
        expect(TurnTraceSchema.safeParse(minimalTrace()).success).toBe(true);
        expect(TurnTraceSchema.parse(minimalTrace()).extensions).toBeUndefined();
    });

    it('accepts a compact planning.graph example', () => {
        const ext = {
            namespace: 'planning.graph',
            version: '1',
            data: { planId: 'p1', revision: 0, readySteps: ['A', 'B'] },
        };
        expect(TurnTraceExtensionSchema.safeParse(ext).success).toBe(true);
        expect(TurnTraceSchema.safeParse(minimalTrace({ extensions: [ext] })).success).toBe(true);
    });

    it('accepts nested objects and arrays in data', () => {
        expect(
            TurnTraceExtensionSchema.safeParse({
                namespace: 'retrieval.rag',
                version: '1.1',
                data: { hits: [{ id: 'a' }], counts: { k: 2 } },
            }).success
        ).toBe(true);
    });

    it('rejects non-JSON data, missing namespace, and extra keys', () => {
        expect(
            TurnTraceExtensionSchema.safeParse({
                namespace: 'planning.graph',
                version: '1',
                data: { ts: new Date() },
            }).success
        ).toBe(false);
        expect(
            TurnTraceExtensionSchema.safeParse({
                version: '1',
                data: {},
            }).success
        ).toBe(false);
        expect(
            TurnTraceExtensionSchema.safeParse({
                namespace: 'planning.graph',
                version: '1',
                data: {},
                related: [{ artifactId: 'x' }],
            }).success
        ).toBe(false);
    });

    it('JSON.stringify round-trips a valid extension', () => {
        const ext = TurnTraceExtensionSchema.parse({
            namespace: 'planning.graph',
            version: '1',
            data: { planId: 'p1', readySteps: ['A'] },
        });
        expect(JSON.parse(JSON.stringify(ext))).toEqual(ext);
    });
});

describe('recordTurnTraceExtension', () => {
    it('copies a recorded extension onto lastTrace and does not leak to the next turn', async () => {
        let recorded = false;
        const h = createTestHarness({
            execution: async (_a, ctx) => {
                if (!recorded) {
                    recordTurnTraceExtension(ctx, {
                        namespace: 'planning.graph',
                        version: '1',
                        data: { planId: 'p1', revision: 0, readySteps: ['A'] },
                    });
                    recorded = true;
                }
                return {
                    action: { kind: 'internal', done: false },
                    result: {
                        status: 'ok',
                        ts: Date.now(),
                        data: { intent: 'wait', done: false },
                        toolId: 'internal',
                    },
                };
            },
            policy: () => ({ kind: 'wait' } as Intent),
        });
        await h.runTurn();
        expect(h.lastTrace().extensions).toEqual([
            { namespace: 'planning.graph', version: '1', data: { planId: 'p1', revision: 0, readySteps: ['A'] } },
        ]);

        await h.runTurn();
        expect(h.lastTrace().extensions ?? []).toEqual([]);
    });

    it('records during Execution and drops invalid items without failing the turn', async () => {
        const h = createTestHarness({
            learning: (prev, _a, _o, _mem, _writer) => prev,
            execution: async (_a, ctx) => {
                recordTurnTraceExtension(ctx, {
                    namespace: 'planning.graph',
                    version: '1',
                    data: { ts: new Date() },
                } as never);
                return {
                    action: { kind: 'internal', done: false },
                    result: {
                        status: 'ok',
                        ts: Date.now(),
                        data: { intent: 'wait', done: false },
                        toolId: 'internal',
                    },
                };
            },
            policy: () => ({ kind: 'wait' } as Intent),
        });
        await h.runTurn();
        expect(h.lastTrace().transition?.kind).toBe('continue');
        expect(h.lastTrace().extensions ?? []).toEqual([]);
    });

    it('keeps both notes when the same namespace+version is recorded twice', async () => {
        const h = createTestHarness({
            execution: async (_a, ctx) => {
                recordTurnTraceExtension(ctx, {
                    namespace: 'planning.graph',
                    version: '1',
                    data: { n: 1 },
                });
                recordTurnTraceExtension(ctx, {
                    namespace: 'planning.graph',
                    version: '1',
                    data: { n: 2 },
                });
                return {
                    action: { kind: 'internal', done: false },
                    result: {
                        status: 'ok',
                        ts: Date.now(),
                        data: { intent: 'wait', done: false },
                        toolId: 'internal',
                    },
                };
            },
            policy: () => ({ kind: 'wait' } as Intent),
        });
        await h.runTurn();
        expect(h.lastTrace().extensions?.map((e) => e.data)).toEqual([{ n: 1 }, { n: 2 }]);
    });

    it('omits extensions when Policy records nothing', async () => {
        const h = createTestHarness({
            policy: () => ({ kind: 'wait' } as Intent),
        });
        await h.runTurn();
        expect(h.lastTrace().extensions ?? []).toEqual([]);
    });
});
