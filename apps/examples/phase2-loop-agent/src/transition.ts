import type {
    EnvironmentState,
    ExecOutcome,
    MemoryReader,
    MentalState,
    TransitionOut,
} from '@a2arium/callagent-core';
import type { ExecError, ExecPayload, Sensory } from './types.js';

export function transition(
    _env: EnvironmentState,
    exec: ExecOutcome<ExecPayload, ExecError>,
    _state: MentalState<Sensory>,
    _memory: MemoryReader
): TransitionOut {
    if (exec.result.status === 'error') {
        return {
            kind: 'fail',
            reason: exec.result.error?.code ?? 'execution_error',
            error: exec.result.error,
        };
    }

    if (exec.action.kind === 'prompt_user') {
        return { kind: 'await_input', token: exec.action.token };
    }

    if (exec.action.kind === 'internal' && exec.action.done) {
        return { kind: 'complete', result: exec.result.data };
    }

    return { kind: 'fail', reason: 'unexpected_exec_outcome' };
}
