import { describe, it, expect } from '@jest/globals';
import type { TurnTrace } from '../src/types/turnTrace.js';
import type { TelemetryProvider } from '../src/telemetry/Provider.js';
import type { TelemetryNode } from '../src/telemetry/nodes/TelemetryNode.js';
import { telemetry } from '../src/telemetry/TelemetryCollector.js';
import { ConsoleProvider } from '../src/telemetry/providers/ConsoleProvider.js';

describe('TurnTrace telemetry', () => {
    it('custom provider implementing onTurnTrace receives full TurnTrace exactly once per emit', () => {
        const received: TurnTrace[] = [];
        const mockProvider: TelemetryProvider = {
            name: 'test-turn-trace',
            onNodeStart: () => {},
            onNodeEnd: () => {},
            onNodeFailure: () => {},
            onUsageUpdate: () => {},
            onTurnTrace(trace: TurnTrace) {
                received.push(trace);
            },
        };
        telemetry.addProvider(mockProvider);

        const trace: TurnTrace = {
            turn: 1,
            turnId: 'tid-1',
            agentCardSource: 'inline',
            runtimeManifestSource: 'inline',
            agentCardHash: 'abc',
            runtimeManifestHash: 'def',
            stageBefore: 'idle',
            stageAfter: 'running',
            inboxCurrent: [],
            timings: {
                attentionMs: 1,
                perceptionMs: 2,
                learningMs: 3,
                policyMs: 4,
                shieldMs: 5,
                executionMs: 6,
                transitionMs: 7,
                totalMs: 28,
            },
        };

        telemetry.emitTurnTrace(trace);

        expect(received).toHaveLength(1);
        expect(received[0].turn).toBe(1);
        expect(received[0].turnId).toBe('tid-1');
        expect(received[0].timings.totalMs).toBe(28);
    });

    it('ConsoleProvider has onTurnTrace that builds compact summary', () => {
        const provider = new ConsoleProvider();
        expect(provider.name).toBe('console');
        expect(typeof provider.onTurnTrace).toBe('function');
        const trace: TurnTrace = {
            turn: 2,
            turnId: 'tid-2',
            agentCardSource: 'defaultPath',
            runtimeManifestSource: 'defaultPath',
            agentCardHash: '',
            runtimeManifestHash: '',
            stageBefore: 'idle',
            stageAfter: 'running',
            intent: { kind: 'call_tool' },
            shield: { action: 'pass' },
            transition: { kind: 'await_tool' },
            inboxCurrent: [],
            timings: { attentionMs: 0, perceptionMs: 0, learningMs: 0, policyMs: 0, shieldMs: 0, executionMs: 0, transitionMs: 0, totalMs: 100 },
        };
        expect(() => provider.onTurnTrace(trace)).not.toThrow();
    });

    it('ConsoleProvider onNodeStart/onNodeEnd only log for agent type', () => {
        const provider = new ConsoleProvider();
        const agentNode = { type: 'agent', id: 'agent-1', startTime: 0, endTime: 10, status: 'success' as const } as unknown as TelemetryNode;
        const turnNode = { type: 'turn', id: 'turn-1' } as unknown as TelemetryNode;
        expect(() => provider.onNodeStart(agentNode)).not.toThrow();
        expect(() => provider.onNodeStart(turnNode)).not.toThrow();
        expect(() => provider.onNodeEnd(agentNode)).not.toThrow();
    });
});
