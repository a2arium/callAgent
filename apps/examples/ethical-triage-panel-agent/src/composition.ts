import {
    memberId,
    ensureBuiltinTopicProjectionsRegistered,
    getTopicProjectionRegistry,
} from '@a2arium/callagent-core';
import { triagePanelProjection } from './projection.js';
import { ethicalTriageStopPolicies } from './policies.js';

export const MODERATOR_AGENT_ID = 'ethical-triage-moderator-agent' as const;
export const PERSONA_AGENT_ID = 'ethical-triage-persona-agent' as const;

export const MODERATOR_SEAT = memberId('triage#moderator');
export const SEAT_UTILITARIAN = memberId('triage#utilitarian');
export const SEAT_FAIRNESS = memberId('triage#fairness');
export const SEAT_DUTY = memberId('triage#duty');
export const SEAT_PRAGMATIST = memberId('triage#pragmatist');

/** Deterministic participant order used by `round_robin` (participant seats only; owner excluded). */
export const PARTICIPANT_ROUND_ROBIN_ORDER = [
    SEAT_DUTY,
    SEAT_FAIRNESS,
    SEAT_PRAGMATIST,
    SEAT_UTILITARIAN,
] as const;

export const ethicalTriageTopicMembers = [
    { agentId: MODERATOR_AGENT_ID, memberId: MODERATOR_SEAT, role: 'owner' as const },
    { agentId: PERSONA_AGENT_ID, memberId: SEAT_UTILITARIAN, role: 'participant' as const },
    { agentId: PERSONA_AGENT_ID, memberId: SEAT_FAIRNESS, role: 'participant' as const },
    { agentId: PERSONA_AGENT_ID, memberId: SEAT_DUTY, role: 'participant' as const },
    { agentId: PERSONA_AGENT_ID, memberId: SEAT_PRAGMATIST, role: 'participant' as const },
];

export { ethicalTriageStopPolicies };

export function registerEthicalTriageTopicProjection(): void {
    ensureBuiltinTopicProjectionsRegistered();
    getTopicProjectionRegistry().register(triagePanelProjection.definition);
}
