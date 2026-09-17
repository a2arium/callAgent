import type { EnvironmentState, MemoryReader } from '@a2arium/callagent-core';
import type { Obs } from './types.js';
import { normalizeUserObservation } from './normalizers/user.js';
import { normalizeToolObservation } from './normalizers/tool.js';
import { normalizeChildObservation } from './normalizers/child.js';
import { normalizeInternalObservation } from './normalizers/internal.js';

export function perception(env: EnvironmentState, _alpha: unknown, _mem: MemoryReader): Obs {
    for (const obs of env.inbox.current) {
        const u = normalizeUserObservation(obs);
        if (u) {
            return u;
        }
        const t = normalizeToolObservation(obs);
        if (t) {
            return t;
        }
        const c = normalizeChildObservation(obs);
        if (c) {
            return c;
        }
        const i = normalizeInternalObservation(obs);
        if (i) {
            return i;
        }
    }
    return { kind: 'idle' };
}
