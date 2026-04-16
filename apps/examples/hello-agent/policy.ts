import type { MentalState, MemoryReader, Intent } from '@a2arium/callagent-core';
import type { Sensory } from './types.js';

export function policy(m: MentalState<Sensory>, _mem: MemoryReader): Intent {
    const t = m.memory?.sensory?.latestUserText;
    if (t) {
        return { kind: 'complete', result: { echoed: t } };
    }
    return { kind: 'wait' };
}
