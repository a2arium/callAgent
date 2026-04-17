import type { EnvironmentState, MentalState, MemoryReader } from '@a2arium/callagent-core';
import type { ExecOutcome, TransitionOut } from '@a2arium/callagent-core';
import type { ExecPayload, ExecError, Sensory } from './types.js';

export function transition(
    _env: EnvironmentState,
    exec: ExecOutcome<ExecPayload, ExecError>,
    _m: MentalState<Sensory>,
    _mem: MemoryReader
): TransitionOut {
    if (exec.action.kind === 'internal' && exec.action.done && exec.result.status === 'ok') {
        const data = exec.result.data;
        if (typeof data?.voiced === 'boolean') {
            return { kind: 'complete', result: data };
        }
    }
    if (exec.action.kind === 'internal' && exec.action.done && exec.result.status === 'error') {
        return { kind: 'fail', reason: 'execution_error' };
    }
    return { kind: 'fail', reason: 'unexpected_exec_outcome' };
}
