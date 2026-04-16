import type { MentalState, MemoryReader, Intent } from '@a2arium/callagent-core';
import type { AgentIntent, Sensory } from './types.js';
import { readPolicyView } from './selectors.js';

export function policy(m: MentalState<Sensory>, mem: MemoryReader): Intent {
    const v = readPolicyView(m, mem).latestUserText;
    if (v) {
        const next: AgentIntent = { kind: 'complete', result: { echoed: v } };
        return next;
    }
    const next: AgentIntent = { kind: 'wait' };
    return next;
}
