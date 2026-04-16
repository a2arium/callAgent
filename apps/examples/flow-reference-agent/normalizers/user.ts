import type { Observation } from '@a2arium/callagent-core';
import type { Obs } from '../types.js';

/** Normalize user inbox rows into agent Obs. */
export function normalizeUserObservation(obs: Observation): Obs | null {
    if (obs.source !== 'user' || obs.kind !== 'input.provided') {
        return null;
    }
    const payload = obs.payload as { value?: unknown };
    const v = payload?.value;
    const text =
        typeof v === 'string'
            ? v
            : v && typeof v === 'object' && v !== null && 'text' in v
              ? String((v as { text: unknown }).text)
              : undefined;
    if (!text) {
        return { kind: 'idle' };
    }
    return { kind: 'user_message', text };
}
