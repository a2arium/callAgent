import { memberId } from '@a2arium/callagent-core';

/** Orchestrator-generated ids use this prefix so seats can recognize panel topics. */
export const PANEL_TOPIC_ID_PREFIX = 'topic-panel-' as const;

export const PANEL_ORCHESTRATOR_AGENT_ID = 'conversation-panel-orchestrator-agent' as const;

/** Single registered agent; Phase 2a uses distinct member seats for critic / dreamer / realist. */
export const PANEL_SEAT_AGENT_ID = 'conversation-panel-persona-agent' as const;

export const SEAT_CRITIC = memberId('conversation-panel-persona-agent#critic');
export const SEAT_DREAMER = memberId('conversation-panel-persona-agent#dreamer');
export const SEAT_REALIST = memberId('conversation-panel-persona-agent#realist');

export type PanelLens = 'critic' | 'dreamer' | 'realist';

export function routingMemberIdFromSessionId(sessionId: string | undefined): string | undefined {
    if (!sessionId || !sessionId.includes(':')) {
        return undefined;
    }
    const tail = sessionId.split(':').pop();
    return tail && tail.length > 0 ? tail : undefined;
}

export function lensFromMemberIdString(mid: string): PanelLens | undefined {
    if (mid.endsWith('#critic')) {
        return 'critic';
    }
    if (mid.endsWith('#dreamer')) {
        return 'dreamer';
    }
    if (mid.endsWith('#realist')) {
        return 'realist';
    }
    return undefined;
}
