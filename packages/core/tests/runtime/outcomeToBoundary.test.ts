import { describe, it, expect } from '@jest/globals';
import {
    outcomeToBoundary,
    boundaryToTaskStatus,
} from '../../src/runtime/turnExecutor.js';
import type { TurnOutcome } from '../../src/loop/oneTurn.js';

describe('outcomeToBoundary', () => {
    it('maps await_input and surfaces expiresAt when provided', () => {
        const outcome: TurnOutcome = { kind: 'await_input', token: 'tok-1' };
        expect(outcomeToBoundary(outcome)).toEqual({
            kind: 'await_input',
            token: 'tok-1',
        });
        expect(outcomeToBoundary(outcome, { expiresAt: '2026-01-01T00:00:00.000Z' })).toEqual({
            kind: 'await_input',
            token: 'tok-1',
            expiresAt: '2026-01-01T00:00:00.000Z',
        });
    });

    it('maps await_tool and await_child', () => {
        expect(outcomeToBoundary({ kind: 'await_tool', token: 't' })).toEqual({
            kind: 'await_tool',
            token: 't',
        });
        expect(outcomeToBoundary({ kind: 'await_child', token: 'c' })).toEqual({
            kind: 'await_child',
            token: 'c',
        });
    });

    it('maps complete with result', () => {
        expect(outcomeToBoundary({ kind: 'complete', result: { ok: true } })).toEqual({
            kind: 'complete',
            result: { ok: true },
        });
    });

    it('maps fail, preferring error over reason', () => {
        const err = new Error('boom');
        expect(outcomeToBoundary({ kind: 'fail', reason: 'r', error: err })).toEqual({
            kind: 'fail',
            error: err,
        });
        expect(outcomeToBoundary({ kind: 'fail', reason: 'just-reason' })).toEqual({
            kind: 'fail',
            error: 'just-reason',
        });
    });

    it('maps a returned continue to a paused boundary (budget/latency cutoff)', () => {
        expect(outcomeToBoundary({ kind: 'continue', observations: [] })).toEqual({
            kind: 'paused',
            reason: 'budget_or_latency',
        });
    });
});

describe('boundaryToTaskStatus', () => {
    it('maps each boundary kind to the expected coarse status', () => {
        expect(boundaryToTaskStatus({ kind: 'await_input', token: 't' })).toBe('input-required');
        expect(boundaryToTaskStatus({ kind: 'await_tool', token: 't' })).toBe('working');
        expect(boundaryToTaskStatus({ kind: 'await_child', token: 't' })).toBe('working');
        expect(boundaryToTaskStatus({ kind: 'sleep', token: 't', fireAt: 'x' })).toBe('working');
        expect(boundaryToTaskStatus({ kind: 'paused', reason: 'r' })).toBe('working');
        expect(boundaryToTaskStatus({ kind: 'complete' })).toBe('completed');
        expect(boundaryToTaskStatus({ kind: 'fail', error: 'e' })).toBe('failed');
    });
});
