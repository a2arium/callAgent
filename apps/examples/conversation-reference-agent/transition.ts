import type { EnvironmentState, MentalState, MemoryReader } from '@a2arium/callagent-core';
import type { ExecOutcome, TransitionOut } from '@a2arium/callagent-core';
import { logger } from '@a2arium/callagent-utils';
import type { ExecPayload, ExecError, Sensory } from './types.js';
import { DEMO_CHILD_AGENT_ID, DEMO_THREAD_ID } from './types.js';

const log = logger.createLogger({ prefix: 'conversation-reference-agent' });

export function transition(
    _env: EnvironmentState,
    exec: ExecOutcome<ExecPayload, ExecError>,
    _m: MentalState<Sensory>,
    _mem: MemoryReader
): TransitionOut {
    if (exec.action.kind === 'internal' && exec.action.done && exec.result.status === 'ok') {
        const data = exec.result.data;
        if (data?.phase2DemoComplete === true) {
            return {
                kind: 'complete',
                result: data,
            };
        }
        if (data?.phase2CloseComplete === true) {
            return {
                kind: 'complete',
                result: data,
            };
        }
        if (data?.outgoingSteps === 1) {
            return {
                kind: 'continue',
                observations: [
                    {
                        source: 'internal',
                        kind: 'state.noted',
                        payload: {
                            phase: 'thread_opened',
                            threadId: data.threadId,
                            ...(typeof data.openOutboundMessageId === 'string'
                                ? { openOutboundMessageId: data.openOutboundMessageId }
                                : {}),
                            ...(typeof data.openOutboundSequence === 'number'
                                ? { openOutboundSequence: data.openOutboundSequence }
                                : {}),
                        },
                    },
                ],
            };
        }
        if (data?.lastDedupeHit === true) {
            const threadId = typeof data.threadId === 'string' ? data.threadId : DEMO_THREAD_ID;
            log.info('conversation.follow_up_dedupe_complete', {
                threadId,
                followUpFirstMessageId: data.followUpFirstMessageId,
                followUpReplayMessageId: data.followUpReplayMessageId,
                followUpFirstSequence: data.followUpFirstSequence,
                followUpReplaySequence: data.followUpReplaySequence,
                recipientRoutingSessionId: `${threadId}:${DEMO_CHILD_AGENT_ID}`,
            });
            return {
                kind: 'complete',
                result: {
                    ...data,
                    exchangeWitness: {
                        tenantIdForAudit: 'default',
                        threadId,
                        recipientRoutingSessionId: `${threadId}:${DEMO_CHILD_AGENT_ID}`,
                        followUpFirstMessageId: data.followUpFirstMessageId,
                        followUpReplayMessageId: data.followUpReplayMessageId,
                        followUpFirstSequence: data.followUpFirstSequence,
                        followUpReplaySequence: data.followUpReplaySequence,
                        dedupeReplayHit: true,
                        persistedMessagesCheck: {
                            workspace: '@a2arium/callagent-memory-sql',
                            script: 'print-conversation',
                            tenantId: 'default',
                            conversationId: threadId,
                        },
                    },
                },
            };
        }
        if (data?.awaitingReply === true || data?.idle === true) {
            return { kind: 'complete', result: data };
        }
    }
    if (exec.action.kind === 'internal' && exec.action.done && exec.result.status === 'error') {
        return { kind: 'fail', reason: 'execution_error' };
    }
    return { kind: 'fail', reason: 'unexpected_exec_outcome' };
}
