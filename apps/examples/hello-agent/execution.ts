import type { TaskContext, MentalState, MemoryReader, Intent } from '@a2arium/callagent-core';
import type { ExecOutcome } from '@a2arium/callagent-core';
import type { ExecError, ExecPayload, Sensory } from './types.js';

export async function execution(
    intent: Intent,
    _ctx: TaskContext,
    _mem: MemoryReader,
    _m: MentalState<Sensory>
): Promise<ExecOutcome<ExecPayload, ExecError>> {
    if (intent.kind === 'complete') {
        return {
            action: { kind: 'internal', done: true },
            result: { status: 'ok', data: intent.result ?? { echoed: true } },
        };
    }
    if (intent.kind === 'wait') {
        return {
            action: { kind: 'internal', done: true },
            result: { status: 'ok', data: { idle: true } },
        };
    }
    return {
        action: { kind: 'internal', done: true },
        result: {
            status: 'error',
            error: { code: 'unsupported_intent', message: 'Unsupported intent for scaffold template' },
        },
    };
}
