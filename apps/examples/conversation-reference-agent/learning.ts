import type { MentalState, MemoryReader, MemoryWriter } from '@a2arium/callagent-core';
import type { Intent } from '@a2arium/callagent-core';
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
    if (obs.kind === 'user_message' && obs.text === 'go') {
        return {
            ...prev,
            memory: {
                ...prev.memory,
                sensory: {
                    ...prev.memory.sensory,
                    userText: obs.text,
                    demoStage: 'want_open',
                },
            },
        };
    }
    if (obs.kind === 'conversation_delivery') {
        return {
            ...prev,
            memory: {
                ...prev.memory,
                sensory: {
                    ...prev.memory.sensory,
                    demoStage: 'want_followup',
                    userText: prev.memory.sensory?.userText,
                    ...(obs.inboundMessageId
                        ? {
                              lastInboundMessageId: obs.inboundMessageId,
                              lastInboundSequence: obs.sequenceNumber,
                          }
                        : {}),
                },
            },
        };
    }
    if (obs.kind === 'thread_opened') {
        return {
            ...prev,
            memory: {
                ...prev.memory,
                sensory: {
                    ...prev.memory.sensory,
                    demoStage: 'want_followup',
                    ...(obs.openOutboundMessageId
                        ? { openOutboundMessageId: obs.openOutboundMessageId }
                        : {}),
                    ...(obs.openOutboundSequence !== undefined
                        ? { openOutboundSequence: obs.openOutboundSequence }
                        : {}),
                },
            },
        };
    }
    return prev;
}
