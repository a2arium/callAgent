import type { EnvironmentState, ExecOutcome, MemoryReader, MentalState, TransitionOut } from '@a2arium/callagent-core';
import type { ParentExecError, ParentExecPayload, ParentSensory } from './types.js';

export function transition(
    _env: EnvironmentState,
    exec: ExecOutcome<ParentExecPayload, ParentExecError>,
    _state: MentalState<ParentSensory>,
    _memory: MemoryReader
): TransitionOut {
    if (exec.result.status === 'error') {
        return {
            kind: 'fail',
            reason: exec.result.error?.code ?? 'execution_error',
            error: exec.result.error,
        };
    }

    if (exec.action.kind === 'delegate_to_child') {
        return { kind: 'complete', result: exec.result.data };
    }

    if (exec.action.kind === 'internal' && exec.action.done) {
        return { kind: 'complete', result: exec.result.data };
    }

    return { kind: 'fail', reason: 'unexpected_exec_outcome' };
}
