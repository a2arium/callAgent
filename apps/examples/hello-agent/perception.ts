import type { EnvironmentState, MemoryReader } from '@a2arium/callagent-core';
import type { Obs } from './types.js';

export function perception(env: EnvironmentState, _alpha: unknown, _mem: MemoryReader): Obs {
    const userObs = env.inbox.current.find((o) => o.source === 'user' && o.kind === 'input.provided');
    if (!userObs) {
        return { kind: 'idle' };
    }
    const payload = userObs.payload as { value?: unknown };
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
