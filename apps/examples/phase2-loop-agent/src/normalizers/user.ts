import type { Observation } from '@a2arium/callagent-core';
import type { Phase2Observation } from '../types.js';

type UserObservation = Extract<Observation, { source: 'user' }>;

export function normalizeUserObservation(observation: UserObservation): Phase2Observation {
    if (observation.kind === 'input.cancelled') {
        return { kind: 'runtime/no_input' };
    }

    return {
        kind: 'user/input_provided',
        text: extractText(observation.payload.value),
    };
}

function extractText(value: unknown): string {
    if (typeof value === 'string') {
        return value;
    }
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        const record = value as Record<string, unknown>;
        return extractText(record.text ?? record.input ?? record.value);
    }
    return '';
}
