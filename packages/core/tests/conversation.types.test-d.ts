import { expectType, expectError } from 'tsd';
import type { TaskContext } from '../src/shared/types/index.js';
import type { SendReceipt, OutboundThreadMessage } from '../src/public-types/conversation/types.js';
import type { Observation } from '../src/loop/oneTurn.js';

declare const ctx: TaskContext;

type ConversationApi = NonNullable<TaskContext['conversation']>;
type StartThreadReturn = Awaited<ReturnType<ConversationApi['startThread']>>;

if (ctx.conversation) {
    expectType<Promise<StartThreadReturn>>(
        ctx.conversation.startThread({
            targetAgentId: 'child',
            message: {
                senderAgentId: 'parent',
                speechAct: 'request',
                content: {},
            },
        })
    );

    expectError(
        ctx.conversation.send(
            { kind: 'thread', id: 't-1' },
            {
                senderAgentId: 'parent',
                recipientAgentId: 'child',
                speechAct: 'system.inject',
                content: {},
            }
        )
    );
}

declare const receipt: SendReceipt;
if (receipt.status === 'accepted') {
    expectType<boolean>(receipt.dedupeHit);
    expectType<number>(receipt.sequenceNumber);
}
if (receipt.status === 'queued') {
    expectError(receipt.messageId);
}

const _msg: OutboundThreadMessage = {
    senderAgentId: 'a',
    recipientAgentId: 'b',
    speechAct: 'inform',
    content: {},
};
expectType<OutboundThreadMessage>(_msg);

const _validObs: Observation = {
    source: 'conversation',
    kind: 'message.received',
    payload: {
        kind: 'message.received',
        message: {
            id: 'm1',
            conversation: { kind: 'thread', id: 't1' },
            senderAgentId: 'a',
            recipientAgentId: 'b',
            speechAct: 'inform',
            content: {},
            sequenceNumber: 1,
            ts: '2020-01-01T00:00:00.000Z',
        },
    },
};
void _validObs;
