import { projectRuntimeStreamChat, type RuntimeStreamEvent } from '@a2arium/callagent-core';
import type { ResultPayload, RuntimeStreamSink } from '../../types.js';
import { createStreamForwardState, forwardChatProjectionEvent } from './chatProjectionForwarder.js';

export async function consumeRuntimeStreamAsResult(params: {
    taskId: string;
    events: AsyncIterable<RuntimeStreamEvent>;
    sink?: RuntimeStreamSink;
}): Promise<ResultPayload> {
    const state = createStreamForwardState();

    for await (const event of params.events) {
        await params.sink?.(event);
        for (const chatEvent of projectRuntimeStreamChat([event])) {
            const result = await forwardChatProjectionEvent({
                sender: { async sendMessage() { } },
                route: { network: 'stream', conversationId: params.taskId },
                state,
                event: chatEvent,
            });
            if (result.kind === 'input_required') {
                return { id: params.taskId, status: 'input_required', token: result.token, prompt: result.prompt };
            }
            if (result.kind === 'failed') {
                return { id: params.taskId, status: 'failed', error: result.error };
            }
            if (result.kind === 'completed') {
                return { id: params.taskId, status: 'completed', output: result.output };
            }
        }
    }

    return { id: params.taskId, status: 'failed', error: 'Runtime stream ended before terminal task status' };
}
