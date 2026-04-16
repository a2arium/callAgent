import type { TaskContext, MentalState, MemoryReader, Intent } from '@a2arium/callagent-core';
import type { ExecOutcome } from '@a2arium/callagent-core';
import type { ExecError, ExecPayload, Sensory } from './types.js';

async function handleWaitIntent(ctx: TaskContext): Promise<ExecOutcome<ExecPayload, ExecError>> {
    const handle = await ctx.requestInput('Please provide input');
    return {
        action: { kind: 'prompt_user', token: handle.token },
        result: { status: 'ok', data: { idle: true } },
    };
}

function handleCompleteIntent(intent: Intent): ExecOutcome<ExecPayload, ExecError> {
    return {
        action: { kind: 'internal', done: true },
        result: { status: 'ok', data: intent.kind === 'complete' ? intent.result ?? { echoed: true } : { echoed: true } },
    };
}

export async function execution(
    intent: Intent,
    _ctx: TaskContext,
    _mem: MemoryReader,
    _m: MentalState<Sensory>
): Promise<ExecOutcome<ExecPayload, ExecError>> {
    if (intent.kind === 'complete') {
        return handleCompleteIntent(intent);
    }
    if (intent.kind === 'wait') {
        return handleWaitIntent(_ctx);
    }
    return {
        action: { kind: 'internal', done: true },
        result: {
            status: 'error',
            error: { code: 'unsupported_intent', message: 'Unsupported intent for scaffold template' },
        },
    };
}
