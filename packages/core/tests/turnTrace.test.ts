import { describe, it, expect } from '@jest/globals';
import {
    TurnTraceSchema,
    ManifestSourceSchema,
    TurnTimingsSchema,
    type TurnTrace,
} from '../src/types/turnTrace.js';

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

function minimalTrace(overrides: Partial<TurnTrace> = {}): TurnTrace {
    return {
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
    };
}

describe('TurnTraceSchema', () => {
    it('accepts valid minimal TurnTrace', () => {
        const trace = minimalTrace();
        expect(() => TurnTraceSchema.parse(trace)).not.toThrow();
        const parsed = TurnTraceSchema.parse(trace);
        expect(parsed.turn).toBe(1);
        expect(parsed.turnId).toBe('test-turn-id');
        expect(parsed.agentCardSource).toBe('inline');
        expect(parsed.timings.totalMs).toBe(0);
    });

    it('accepts valid TurnTrace with optional fields', () => {
        const trace = minimalTrace({
            stageAfter: 'running',
            stageTransition: { from: 'idle', to: 'running' },
            intent: { kind: 'call_tool' },
            shield: { action: 'pass' },
            transition: { kind: 'await_tool', token: 't1' },
            correlationId: 'corr-1',
            pendingAfter: { inputTokens: [], toolTokens: [], childTokens: [] },
        });
        expect(() => TurnTraceSchema.parse(trace)).not.toThrow();
    });

    it('accepts llm call contract metadata fields', () => {
        const trace = minimalTrace({
            llmCalls: [{
                model: 'gpt-4o-mini',
                hasOutputContract: true,
                outputContractName: 'GreetingSchema',
                outputContractStatus: 'matched',
            }],
        });
        const parsed = TurnTraceSchema.parse(trace);
        expect(parsed.llmCalls?.[0]?.hasOutputContract).toBe(true);
        expect(parsed.llmCalls?.[0]?.outputContractStatus).toBe('matched');
    });

    it('rejects missing required turn', () => {
        const bad = minimalTrace();
        delete (bad as Partial<TurnTrace>).turn;
        expect(() => TurnTraceSchema.parse(bad)).toThrow();
    });

    it('rejects missing turnId', () => {
        const bad = minimalTrace();
        delete (bad as Partial<TurnTrace>).turnId;
        expect(() => TurnTraceSchema.parse(bad)).toThrow();
    });

    it('rejects invalid ManifestSource', () => {
        expect(() => ManifestSourceSchema.parse('invalid')).toThrow();
        expect(ManifestSourceSchema.parse('defaultPath')).toBe('defaultPath');
        expect(ManifestSourceSchema.parse('pathOverride')).toBe('pathOverride');
        expect(ManifestSourceSchema.parse('inline')).toBe('inline');
    });

    it('rejects timings with missing required fields', () => {
        const trace = minimalTrace();
        const badTimings = { ...validTimings };
        delete (badTimings as Record<string, unknown>).totalMs;
        expect(() => TurnTraceSchema.parse({ ...trace, timings: badTimings })).toThrow();
    });
});
