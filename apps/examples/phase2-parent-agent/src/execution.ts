import type { ExecOutcome, Intent, MemoryReader, MentalState, TaskContext } from '@a2arium/callagent-core';
import { PHASE2_LOOP_AGENT_ID } from '@a2arium/phase2-loop-agent';
import type { ParentExecError, ParentExecPayload, ParentSensory } from './types.js';

export async function execution(
    intent: Intent,
    ctx: TaskContext,
    _memory: MemoryReader,
    _state: MentalState<ParentSensory>
): Promise<ExecOutcome<ParentExecPayload, ParentExecError>> {
    if (intent.kind === 'internal' && intent.intent === 'delegate_to_phase2_loop') {
        const input = readDelegateInput(intent.data);
        const child = await ctx.sendTaskToAgent(PHASE2_LOOP_AGENT_ID, input, { awaitCompletion: true }) as {
            handle: unknown;
            token: string;
        };
        const handleRecord = child.handle !== null && typeof child.handle === 'object' && !Array.isArray(child.handle)
            ? child.handle as Record<string, unknown>
            : {};
        return {
            action: { kind: 'delegate_to_child', token: child.token },
            result: {
                status: 'ok',
                data: {
                    kind: 'child_delegated',
                    token: child.token,
                    childTaskId: typeof handleRecord.childTaskId === 'string' ? handleRecord.childTaskId : undefined,
                    result: handleRecord.result,
                },
            },
        };
    }

    if (intent.kind === 'internal' && intent.intent === 'reply_with_child_result') {
        const text = summarizeChildResult(intent.data);
        await ctx.reply(`Parent observed child result: ${text}`);
        return {
            action: { kind: 'internal', done: true },
            result: { status: 'ok', data: { kind: 'parent_replied', text } },
        };
    }

    return {
        action: { kind: 'internal', done: true },
        result: { status: 'ok', data: { kind: 'idle_complete' } },
    };
}

function readDelegateInput(data: unknown): { text: string } {
    if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
        const text = (data as Record<string, unknown>).text;
        if (typeof text === 'string' && text.length > 0) {
            return { text };
        }
    }
    return { text: 'phase2 parent delegation check' };
}

function summarizeChildResult(data: unknown): string {
    if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
        const result = (data as Record<string, unknown>).result;
        if (result !== undefined) {
            return summarizeChildResult(result);
        }
        const kind = (data as Record<string, unknown>).kind;
        const text = (data as Record<string, unknown>).text;
        if (typeof kind === 'string' && typeof text === 'string') {
            return `${kind}: ${text}`;
        }
    }
    return 'completed';
}
