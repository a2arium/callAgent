import type { TopicStopPolicyRule } from '@a2arium/callagent-core';

/**
 * Signal-based stop is listed first so a deliberate closure signal wins before the round budget.
 * `maxRounds` is a high safety net only: with five seats, `totalRounds = floor(messages/5)` grows quickly,
 * so a small `n` can close the topic mid-deliberation — and `readProjection` requires the topic to stay open.
 */
export const ethicalTriageStopPolicies: TopicStopPolicyRule[] = [
    {
        kind: 'signalBased',
        signals: ['x-triage.decision-finalized'],
        requiredCount: 1,
    },
    { kind: 'maxRounds', n: 500 },
];
