import { applyObservation } from '../reducers.js';
import type { MentalState } from '@a2arium/callagent-core';
import type { Sensory } from '../types.js';

describe('@a2arium/flow-reference-agent — invariants', () => {
    it('idle observation keeps mental state unchanged', () => {
        const prev: MentalState<Sensory> = { memory: { sensory: {} } };
        const next = applyObservation(prev, { kind: 'idle' });
        expect(next).toBe(prev);
        expect(next.memory.sensory).toEqual({});
    });
});
