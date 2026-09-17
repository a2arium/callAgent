import type { MentalState, MemoryReader, Intent } from '@a2arium/callagent-core';
import type { Sensory } from './types.js';

export function policy(m: MentalState<Sensory>, _mem: MemoryReader): Intent {
    const stage = m.memory?.sensory?.demoStage;
    if (stage === 'want_run') {
        return { kind: 'internal', intent: 'panel_orchestrator_run', data: {} };
    }
    return { kind: 'wait' };
}
