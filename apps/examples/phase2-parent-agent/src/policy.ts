import type { Intent, MemoryReader, MentalState } from '@a2arium/callagent-core';
import type { ParentSensory } from './types.js';

export function policy(
    state: MentalState<ParentSensory>,
    _memory: MemoryReader
): Intent {
    const childResult = state.memory.sensory.childResult;
    if (childResult !== undefined) {
        return {
            kind: 'internal',
            intent: 'reply_with_child_result',
            data: childResult,
        };
    }

    const latestUserText = state.memory.sensory.latestUserText;
    if (typeof latestUserText === 'string' && latestUserText.length > 0) {
        return {
            kind: 'internal',
            intent: 'delegate_to_phase2_loop',
            data: { text: latestUserText },
        };
    }

    return { kind: 'complete', result: { ok: true, reason: 'no_input' } };
}
