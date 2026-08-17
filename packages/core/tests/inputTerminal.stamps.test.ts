import { describe, expect, it } from '@jest/globals';
import { applyInputProvided } from '../src/orchestration/DurableHandlerRegistry.js';

describe('input pending tombstones', () => {
    it('copies plan stamps onto inputTerminals when pending is deleted', () => {
        const snapshot = {
            meta: { turn: 1 },
            pending: {
                inputs: {
                    'tok-in': {
                        schema: { type: 'string' },
                        planId: 'p1',
                        stepId: 'A',
                        advanceCursor: false,
                    },
                },
            },
            inbox: { current: [], all: [] },
        };

        const { next } = applyInputProvided(snapshot, 'tok-in', 'hello');
        const pending = (next as {
            pending: {
                inputs: Record<string, unknown>;
                inputTerminals: Record<string, unknown>;
            };
        }).pending;

        expect(pending.inputs['tok-in']).toBeUndefined();
        expect(pending.inputTerminals['tok-in']).toEqual(
            expect.objectContaining({
                kind: 'provided',
                planId: 'p1',
                stepId: 'A',
                advanceCursor: false,
            })
        );
    });
});
