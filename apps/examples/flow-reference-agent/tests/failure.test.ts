import type { EnvironmentState, MentalState, MemoryReader } from '@a2arium/callagent-core';
import type { ExecOutcome } from '@a2arium/callagent-core';
import type { ExecPayload, ExecError, Sensory } from '../types.js';
import { transition } from '../transition.js';

function fakeExecOutcome(): ExecOutcome<ExecPayload, ExecError> {
    return {
        action: { kind: 'internal', done: false },
        result: { status: 'ok', data: { idle: true } },
    };
}

describe('@a2arium/flow-reference-agent — failure paths', () => {
    it('fails on unsupported execution action shape', () => {
        const env = { inbox: { current: [] }, pending: {}, turn: 0 } as unknown as EnvironmentState;
        const m = { memory: { sensory: {} } } as unknown as MentalState<Sensory>;
        const mem = {} as unknown as MemoryReader;
        const out = transition(env, fakeExecOutcome(), m, mem);
        expect(out.kind).toBe('fail');
        expect(out).toBeDefined();
    });
});
