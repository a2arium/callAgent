import type { EnvironmentState, MentalState, MemoryReader, ExecOutcome, TransitionOut } from '@a2arium/callagent-core';
import type { ExecPayload, ExecError, Sensory } from './types.js';

export function transition(
    _env: EnvironmentState,
    exec: ExecOutcome<ExecPayload, ExecError>,
    _m: MentalState<Sensory>,
    _mem: MemoryReader
): TransitionOut {
    if (exec.action.kind === 'internal' && exec.action.done && exec.result.status === 'ok') {
        const data = exec.result.data;
        if (data && typeof data === 'object' && 'replyOutbound' in data && data.replyOutbound === true) {
            const threadId = typeof data.threadId === 'string' ? data.threadId : undefined;
            if (threadId) {
                return {
                    kind: 'continue',
                    observations: [
                        {
                            source: 'internal',
                            kind: 'state.noted',
                            payload: { phase: 'responder_reply_sent', threadId },
                        },
                    ],
                };
            }
        }
        return { kind: 'complete', result: exec.result.data };
    }
    if (exec.action.kind === 'internal' && exec.action.done && exec.result.status === 'error') {
        return { kind: 'fail', reason: 'execution_error' };
    }
    return { kind: 'fail', reason: 'unexpected_exec_outcome' };
}
