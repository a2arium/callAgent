import type { EnvironmentState, MemoryReader } from '@a2arium/callagent-core';
import type { Obs } from './types.js';

export function perception(env: EnvironmentState, _alpha: unknown, _mem: MemoryReader): Obs {
    const userObs = env.inbox.current.find((o) => o.source === 'user' && o.kind === 'input.provided');
    if (!userObs) {
        return { kind: 'idle' };
    }
    const payload = userObs.payload as { value?: unknown };
    let v = payload?.value;
    if (v && typeof v === 'object' && v !== null && 'value' in v && !('text' in v)) {
        const inner = (v as { value: unknown }).value;
        if (inner && typeof inner === 'object' && inner !== null && 'text' in inner) {
            v = inner;
        }
    }
    const text =
        typeof v === 'string'
            ? v
            : v && typeof v === 'object' && v !== null && 'text' in v
              ? String((v as { text: unknown }).text)
              : undefined;
    if (!text || text.trim().length === 0) {
        return { kind: 'idle' };
    }
    if (text.trim().toLowerCase() === 'go' || text.trim().toLowerCase() === 'start') {
        return { kind: 'user_message', text: 'go' };
    }
    return { kind: 'idle' };
}
