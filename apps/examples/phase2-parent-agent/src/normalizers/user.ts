import type { Observation } from '@a2arium/callagent-core';
import type { ParentObservation } from '../types.js';

export function normalizeUserObservation(observation: Extract<Observation, { source: 'user' }>): ParentObservation {
    if (observation.kind === 'input.cancelled') {
        return { kind: 'runtime/no_input' };
    }

    const text = extractText(observation.payload.value);
    return text.length > 0
        ? { kind: 'user/input_provided', text }
        : { kind: 'runtime/no_input' };
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
