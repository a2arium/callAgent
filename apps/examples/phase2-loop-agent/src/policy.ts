import type { Intent, MemoryReader, MentalState } from '@a2arium/callagent-core';
import { selectDecisionView } from './selectors.js';
import type { Sensory } from './types.js';

export function policy(
    state: MentalState<Sensory>,
    _memory: MemoryReader
): Intent {
    const view = selectDecisionView(state);
    if (view.needsDetail) {
        return {
            kind: 'prompt_user',
            prompt: 'Please provide one extra detail for the Phase 2 durable-loop check.',
        };
    }

    if (view.latestUserText.length > 0) {
        return {
            kind: 'internal',
            intent: 'reply_with_summary',
            data: { text: view.latestUserText },
        };
    }

    return { kind: 'complete', result: { ok: true, reason: 'no_input' } };
}
