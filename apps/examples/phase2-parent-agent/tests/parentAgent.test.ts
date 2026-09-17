import { describe, expect, it } from '@jest/globals';
import type { EnvironmentState, ExecOutcome, MemoryReader, MentalState, Observation } from '@a2arium/callagent-core';
import { normalizeUserObservation } from '../src/normalizers/user.js';
import { transition } from '../src/transition.js';
import type { ParentExecError, ParentExecPayload, ParentSensory } from '../src/types.js';

describe('phase2-parent-agent', () => {
    it('reads loop-mode user input from observation payload value', () => {
        const observation = {
            source: 'user',
            kind: 'input.provided',
            payload: { value: { text: 'validate parent child operator dag' } },
        } as unknown as Extract<Observation, { source: 'user' }>;

        expect(normalizeUserObservation(observation)).toEqual({
            kind: 'user/input_provided',
            text: 'validate parent child operator dag',
        });
    });

    it('completes after an awaited child delegation', () => {
        const exec: ExecOutcome<ParentExecPayload, ParentExecError> = {
            action: { kind: 'delegate_to_child', token: 'child-token' },
            result: {
                status: 'ok',
                data: {
                    kind: 'child_delegated',
                    token: 'child-token',
                    childTaskId: 'child-task',
                    result: { kind: 'summary_replied', text: 'done' },
                },
            },
        };

        expect(transition(
            {} as unknown as EnvironmentState,
            exec,
            {} as unknown as MentalState<ParentSensory>,
            {} as unknown as MemoryReader
        )).toEqual({
            kind: 'complete',
            result: exec.result.data,
        });
    });
});
