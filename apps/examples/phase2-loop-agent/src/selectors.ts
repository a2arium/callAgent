import type { MentalState } from '@a2arium/callagent-core';
import type { Sensory } from './types.js';

export type DecisionView = {
    latestUserText: string;
    askedForDetail: boolean;
    needsDetail: boolean;
};

export function selectDecisionView(state: MentalState<Sensory>): DecisionView {
    const sensory = state.memory?.sensory;
    const latestUserText = sensory?.latestUserText ?? '';
    const askedForDetail = sensory?.askedForDetail ?? false;
    return {
        latestUserText,
        askedForDetail,
        needsDetail: !askedForDetail && /\b(input|ask|prompt|detail)\b/i.test(latestUserText),
    };
}
