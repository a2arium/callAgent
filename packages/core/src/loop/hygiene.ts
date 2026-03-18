import type { MentalState } from './types.js';
import { logger } from '@a2arium/callagent-utils';
import { isArtifactMarker } from '@a2arium/callagent-memory-engine';

const log = logger.createLogger({ prefix: 'Hygiene' });

type HygieneConfig = {
    episodicCap?: number; // keep last N events
    ttlDays?: number;     // drop events older than now - ttlDays
    thoughtsCap?: number; // keep last N thoughts
    decisionsCap?: number; // keep last N decisions by insertion order
};

export function pruneMentalState(input: MentalState, cfg: HygieneConfig = {}): MentalState {
    const {
        episodicCap = 256,
        ttlDays = 30,
        thoughtsCap = 64,
        decisionsCap = 100
    } = cfg;

    const M = input; // mutate in place for performance

    // Episodic TTL + cap
    try {
        const now = Date.now();
        const ttlMs = Math.max(0, ttlDays) * 24 * 60 * 60 * 1000;
        const episodic = Array.isArray(M.memory.longTerm.episodic) ? M.memory.longTerm.episodic : [];
        const ttlFiltered = ttlMs > 0 ? episodic.filter(e => typeof (e as any)?.t === 'number' ? ((e as any).t >= now - ttlMs) : true) : episodic;
        const capped = episodicCap > 0 ? ttlFiltered.slice(-episodicCap) : ttlFiltered;
        (M.memory.longTerm as any).episodic = capped;
    } catch { /* noop */ }

    // Thoughts cap
    try {
        const thoughts = Array.isArray((M.memory as any)?.thoughts) ? ((M.memory as any).thoughts as unknown[]) : [];
        const capped = thoughtsCap > 0 ? thoughts.slice(-thoughtsCap) : thoughts;
        (M.memory as any).thoughts = capped as any;
    } catch { /* noop */ }

    // Decisions cap (keep last keys; order approximated by Object.keys order)
    try {
        const decisionsObj = ((M.memory as any)?.decisions || {}) as Record<string, unknown>;
        const entries = Object.entries(decisionsObj);
        const kept = decisionsCap > 0 ? entries.slice(-decisionsCap) : entries;
        (M.memory as any).decisions = Object.fromEntries(kept) as any;
    } catch { /* noop */ }

    return M;
}

/**
 * Recursively prune large strings from the object tree, SKIPPING Artifacts.
 * @param obj Object to prune
 * @param threshold Size threshold in bytes (default: 50KB)
 * @param path Current path for logging
 */
export function pruneSnapshot(obj: any, threshold = 50 * 1024, path = 'root'): any {
    if (!obj) return obj;

    // 1. Skip Artifacts entirely - they are already offloaded safe handles
    if (isArtifactMarker(obj)) {
        return obj;
    }

    if (typeof obj === 'string') {
        if (obj.length > threshold) {
            const msg = `[PRUNE] Truncated field '${path}' (size ${obj.length} > ${threshold}). Use ctx.artifacts.create() to store large data safely.`;
            log.warn(msg);
            console.error(`\n\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n${msg}\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n\n`);
            return obj.substring(0, 1000) + `... [TRUNCATED: Original size ${obj.length} bytes. Use ctx.artifacts.create() for large data!]`;
        }
        return obj;
    }

    if (Array.isArray(obj)) {
        return obj.map((item, i) => pruneSnapshot(item, threshold, `${path}[${i}]`));
    }

    if (typeof obj === 'object') {
        const newObj: any = {};
        for (const [key, val] of Object.entries(obj)) {
            newObj[key] = pruneSnapshot(val, threshold, `${path}.${key}`);
        }
        return newObj;
    }

    return obj;
}
