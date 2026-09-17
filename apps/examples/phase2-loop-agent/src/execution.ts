import type {
    ExecOutcome,
    Intent,
    MemoryReader,
    MentalState,
    TaskContext,
} from '@a2arium/callagent-core';
import { markDetailRequested } from './reducers.js';
import type { ExecError, ExecPayload, Sensory } from './types.js';

export async function execution(
    intent: Intent,
    ctx: TaskContext,
    _memory: MemoryReader,
    state: MentalState<Sensory>
): Promise<ExecOutcome<ExecPayload, ExecError>> {
    if (intent.kind === 'prompt_user') {
        const handle = await ctx.requestInput(intent.prompt, { schema: intent.schema });
        markDetailRequested(state);
        return {
            action: { kind: 'prompt_user', token: handle.token },
            result: { status: 'ok', data: { kind: 'detail_requested', token: handle.token } },
        };
    }

    if (intent.kind === 'internal' && intent.intent === 'reply_with_summary') {
        const text = extractSummaryText(intent.data);
        await ctx.reply(`Phase 2 durable loop observed: ${text}`);
        return {
            action: { kind: 'internal', done: true },
            result: { status: 'ok', data: { kind: 'summary_replied', text } },
        };
    }

    return {
        action: { kind: 'internal', done: true },
        result: { status: 'ok', data: { kind: 'idle_complete' } },
    };
}

function extractSummaryText(data: unknown): string {
    if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
        const text = (data as Record<string, unknown>).text;
        return typeof text === 'string' ? text : 'ok';
    }
    return 'ok';
}
