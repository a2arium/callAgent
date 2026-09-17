import { createHash } from 'node:crypto';

/**
 * Deterministic JSON for hashing: sort object keys recursively, omit `undefined` keys.
 */
function toCanonical(value: unknown): unknown {
    if (value === null || typeof value !== 'object') {
        return value;
    }
    if (Array.isArray(value)) {
        return value.map(toCanonical);
    }
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const out: Record<string, unknown> = {};
    for (const k of keys) {
        const v = obj[k];
        if (v !== undefined) {
            out[k] = toCanonical(v);
        }
    }
    return out;
}

export function canonicalJsonStringify(value: unknown): string {
    return JSON.stringify(toCanonical(value));
}

/** SHA-256 hex digest of canonical JSON; `undefined` when `params` is `undefined`. */
export function paramsHashFromJsonValue(params: unknown): string | undefined {
    if (params === undefined) {
        return undefined;
    }
    return createHash('sha256').update(canonicalJsonStringify(params), 'utf8').digest('hex');
}
