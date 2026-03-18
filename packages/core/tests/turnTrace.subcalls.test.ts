import { describe, it, expect } from '@jest/globals';
import { runLoop } from '../src/loop/loopRunner.js';
import { initialM } from '../src/loop/init.js';
import { normalizeObservationInbox, type EnvironmentState } from '../src/loop/types.js';
import type { ManifestProvenance } from '../src/types/turnTrace.js';

function baseEnv(overrides: Partial<EnvironmentState> = {}): EnvironmentState {
    return {
        time: new Date().toISOString(),
        sessionId: 'subcalls-session',
        turn: 1,
        budget: { maxTurns: 2, latencyMs: 10_000 },
        pending: { inputs: {}, children: {}, tools: {}, groups: {} },
        inbox: normalizeObservationInbox(undefined),
        lastExec: undefined,
        ...overrides,
    };
}

const provenance: ManifestProvenance = {
    agentCardSource: 'inline',
    runtimeManifestSource: 'inline',
    agentCardHash: 'h1',
    runtimeManifestHash: 'h2',
};

describe('TurnTrace collection and subcalls', () => {
    it('runLoop with collectTraces true returns traces array with one entry per turn', async () => {
        const ctx = {
            task: { id: 'trace-task', input: 'hi' },
            telemetry: { nodeId: 'turn-node' },
            reply: () => {},
            requestInput: async () => {},
            sendTaskToAgent: async () => ({ childTaskId: 'c1', result: {} }),
            requestTool: async () => {},
            tools: { invoke: async () => ({ ok: true }) },
        } as unknown as Parameters<typeof runLoop>[0];
        const M = initialM(ctx);
        const env = baseEnv();

        const modules = {
            attention: () => ({}),
            perception: (e: { inbox: { current: unknown[] }; time: string; pending: unknown }) => ({
                inbox: e.inbox.current,
                time: e.time,
                pending: e.pending,
            }),
            learning: async (prev: unknown) => prev,
            policy: () => ({ kind: 'language', content: 'ok' }),
            shield: (_m: unknown, intent: unknown) => ({ action: 'pass' as const, intent }),
            execution: async (intent: unknown) => ({ action: intent, result: { status: 'ok' as const, data: intent } }),
            transition: () => ({ kind: 'complete' as const, observations: [] }),
        };

        const result = await runLoop(ctx, M, env, modules, {
            maxTurns: 2,
            collectTraces: true,
            manifestProvenance: provenance,
        });

        expect(result.traces).toBeDefined();
        expect(Array.isArray(result.traces)).toBe(true);
        expect(result.traces!.length).toBeGreaterThanOrEqual(1);

        const first = result.traces![0];
        expect(first.turn).toBe(1);
        expect(first.turnId).toBeDefined();
        expect(first.agentCardSource).toBe('inline');
        expect(first.runtimeManifestSource).toBe('inline');
        expect(first.agentCardHash).toBe('h1');
        expect(first.runtimeManifestHash).toBe('h2');
        expect(first.stageBefore).toBeDefined();
        expect(first.inboxCurrent).toEqual(expect.any(Array));
        expect(first.timings).toBeDefined();
        expect(first.timings.totalMs).toBeGreaterThanOrEqual(0);
        expect(first.timings.attentionMs).toBeDefined();
        expect(first.timings.executionMs).toBeDefined();
    });

    it('TurnTraceCollector getByTurn returns trace for turn number', async () => {
        const { TurnTraceCollector } = await import('../src/telemetry/TurnTraceCollector.js');
        const collector = new TurnTraceCollector();
        const trace = {
            turn: 3,
            turnId: 'tid-3',
            agentCardSource: 'inline' as const,
            runtimeManifestSource: 'inline' as const,
            agentCardHash: '',
            runtimeManifestHash: '',
            stageBefore: 'idle',
            inboxCurrent: [],
            timings: { attentionMs: 0, perceptionMs: 0, learningMs: 0, policyMs: 0, shieldMs: 0, executionMs: 0, transitionMs: 0, totalMs: 0 },
        };
        collector.push(trace);
        expect(collector.getByTurn(3)).toEqual(trace);
        expect(collector.getByTurn(1)).toBeUndefined();
        expect(collector.getLast()).toEqual(trace);
        collector.clear();
        expect(collector.getAll().length).toBe(0);
    });
});
