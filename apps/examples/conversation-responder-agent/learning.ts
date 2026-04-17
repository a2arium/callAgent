import type { MentalState, MemoryReader, MemoryWriter, Intent } from '@a2arium/callagent-core';
import type { Obs, Sensory } from './types.js';

export function learning(
    prev: MentalState<Sensory>,
    _prevAction: Intent | undefined,
    obs: Obs,
    _mem: MemoryReader,
    _writer: MemoryWriter
): MentalState<Sensory> {
    if (obs.kind === 'idle') {
        return prev;
    }
    if (obs.kind === 'reply_sent') {
        return {
            ...prev,
            memory: {
                ...prev.memory,
                sensory: {
                    ...prev.memory.sensory,
                    replied: true,
                },
            },
        };
    }
    if (obs.kind === 'topic_join') {
        return {
            ...prev,
            memory: {
                ...prev.memory,
                sensory: {
                    ...prev.memory.sensory,
                    pendingInviteToken: obs.token,
                },
            },
        };
    }
    if (obs.kind === 'topic_joined') {
        return {
            ...prev,
            memory: {
                ...prev.memory,
                sensory: {
                    ...prev.memory.sensory,
                    topicJoined: true,
                    pendingInviteToken: undefined,
                },
            },
        };
    }
    if (obs.kind === 'topic_reply_done') {
        return {
            ...prev,
            memory: {
                ...prev.memory,
                sensory: {
                    ...prev.memory.sensory,
                    topicReplied: true,
                },
            },
        };
    }
    if (obs.kind === 'topic_left_done') {
        return {
            ...prev,
            memory: {
                ...prev.memory,
                sensory: {
                    ...prev.memory.sensory,
                    topicLeft: true,
                    wantLeaveTopic: false,
                },
            },
        };
    }
    if (obs.kind === 'leave_topic') {
        return {
            ...prev,
            memory: {
                ...prev.memory,
                sensory: {
                    ...prev.memory.sensory,
                    wantLeaveTopic: true,
                },
            },
        };
    }
    if (obs.kind === 'topic_message') {
        return {
            ...prev,
            memory: {
                ...prev.memory,
                sensory: {
                    ...prev.memory.sensory,
                    topicMessageSeq: obs.sequenceNumber,
                    topicMessageId: obs.inboundMessageId,
                    topicReplied: false,
                },
            },
        };
    }
    if (obs.kind === 'conversation') {
        return {
            ...prev,
            memory: {
                ...prev.memory,
                sensory: {
                    ...prev.memory.sensory,
                    latestThreadId: obs.threadId,
                    latestSequence: obs.sequenceNumber,
                    latestInboundMessageId: obs.inboundMessageId,
                    replied: false,
                },
            },
        };
    }
    return prev;
}
