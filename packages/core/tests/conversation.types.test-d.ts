import { expectType, expectError } from 'tsd';
import type { TaskContext } from '../src/shared/types/index.js';
import type {
    InviteToken,
    SendReceipt,
    TopicDeclineReceipt,
    OutboundThreadMessage,
    OutboundTopicMessage,
    ThreadRef,
    TopicRef,
    ConversationError,
    ArchiveConversationReceipt,
} from '../src/public-types/conversation/types.js';
import type { Observation } from '../src/loop/oneTurn.js';
import type { ThreadStatus, CloseReason } from '../src/public-types/conversation/types.js';
import type { MessageLogAppendResult } from '../src/public-types/messageLog/types.js';
import type { ChildCallTrace } from '../src/types/turnTrace.js';

declare const ctx: TaskContext;
declare const threadRef: ThreadRef;
declare const topicRef: TopicRef;

type ConversationApi = NonNullable<TaskContext['conversation']>;
type StartThreadReturn = Awaited<ReturnType<ConversationApi['startThread']>>;

if (ctx.conversation) {
    expectType<Promise<ArchiveConversationReceipt>>(ctx.conversation.archive(topicRef, {}));
    expectError(
        ctx.conversation.join(
            topicRef,
            {
                inviteToken: 'raw-token',
            }
        )
    );

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
        ctx.conversation.startThread({
            targetAgentId: 'child',
            awaitMode: 'default',
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

    const topicMsg: OutboundTopicMessage = {
        senderAgentId: 'a',
        speechAct: 'inform',
        content: {},
    };
    expectError(ctx.conversation.post(threadRef, topicMsg));
    const threadMsg: OutboundThreadMessage = {
        senderAgentId: 'a',
        recipientAgentId: 'b',
        speechAct: 'inform',
        content: {},
    };
    expectError(ctx.conversation.send(topicRef, threadMsg));

    const invite: InviteToken = 'abc' as InviteToken;
    expectType<Promise<TopicDeclineReceipt>>(
        ctx.conversation.decline(topicRef, { inviteToken: invite })
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

const _validObs = {
    source: 'conversation',
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
} as Observation;
void _validObs;

/** Phase 2b: no producer-only invite error branches (see types-rules / 5.2b spec). */
type IsNever<T> = [T] extends [never] ? true : false;
const _noInviteRevoked: true = {} as IsNever<Extract<ConversationError, { type: 'InviteRevoked' }>>;
const _noInviteDeliveryFailed: true = {} as IsNever<
    Extract<ConversationError, { type: 'InviteDeliveryFailed' }>
>;
const _noInviteeNotReachable: true = {} as IsNever<
    Extract<ConversationError, { type: 'InviteeNotReachable' }>
>;
void _noInviteRevoked;
void _noInviteDeliveryFailed;
void _noInviteeNotReachable;

const _statusOk: ThreadStatus = 'open';
void _statusOk;
// @ts-expect-error — closed literal union
const _badStatus: ThreadStatus = 'weird';

const _closeOk: CloseReason = 'explicit';
void _closeOk;
// @ts-expect-error — closed literal union
const _badClose: CloseReason = 'expired';

function exhaustConversationError(e: ConversationError): string {
    switch (e.type) {
        case 'ThreadBusy':
        case 'NoEligibleRecipients':
        case 'ConversationClosed':
        case 'QueueFull':
        case 'Forbidden':
        case 'Unsupported':
        case 'NotFound':
        case 'ConversationNotFound':
        case 'PluginMissing':
        case 'ActivationFailed':
        case 'RunTurnFailed':
        case 'TopicNotFound':
        case 'NotAMember':
        case 'AlreadyMember':
        case 'SelectorUnsupported':
        case 'RecipientNotMember':
        case 'RecipientAmbiguous':
        case 'SenderAmbiguous':
        case 'RecipientNotResolvable':
        case 'InviteRequired':
        case 'InviteNotFound':
        case 'InviteExpired':
        case 'InviteAlreadyConsumed':
        case 'InviteTargetMismatch':
        case 'TopicCapacityExceeded':
        case 'SelectorPolicyNotRegistered':
        case 'PolicyParamsInvalid':
        case 'PolicyInternalError':
        case 'StopPolicyNotRegistered':
        case 'StopPolicyParamsInvalid':
        case 'StopPolicyInternalError':
        case 'ConversationNotClosed':
        case 'ThreadExpired':
        case 'ConversationTimeout':
            return e.type;
        default: {
            const _x: never = e;
            return _x;
        }
    }
}
void exhaustConversationError;

const _childCall: ChildCallTrace = {
    token: 't',
    agentId: 'a',
    status: 'completed',
    childAgentNodeId: 'n1',
    childTraceId: 'tr1',
};
void _childCall;
expectType<string | undefined>(_childCall.childAgentNodeId);
expectType<string | undefined>(_childCall.childTraceId);

function exhaustMessageLogAppend(r: MessageLogAppendResult): string {
    switch (r.kind) {
        case 'appended':
            return r.messageId;
        case 'dedupeHit':
            return r.messageId;
        default: {
            const _n: never = r;
            return _n;
        }
    }
}
void exhaustMessageLogAppend;

expectError(ctx.sendTaskToAgent('child', {}, { conversation: topicRef }));
