import type { TurnTrace } from '../types/turnTrace.js';

/**
 * Lightweight in-memory accumulator for TurnTrace records within a process/session.
 * Used by loopRunner for test harness consumption. Not durable session storage.
 */
export class TurnTraceCollector {
    private traces: TurnTrace[] = [];

    push(trace: TurnTrace): void {
        this.traces.push(trace);
    }

    getAll(): ReadonlyArray<TurnTrace> {
        return this.traces;
    }

    getLast(): TurnTrace | undefined {
        return this.traces[this.traces.length - 1];
    }

    getByTurn(turn: number): TurnTrace | undefined {
        return this.traces.find((t) => t.turn === turn);
    }

    clear(): void {
        this.traces = [];
    }
}
