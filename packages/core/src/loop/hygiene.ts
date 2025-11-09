import type { MentalState } from './types.js';
import { logger } from '@a2arium/callagent-utils';

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
    try {
        const beforeVars = Object.keys((((M as any)?.memory as any)?.vars) || {});
        log.debug('Mental state pruning started', { varsBefore: Object.keys(beforeVars) });
    } catch { /* noop */ }

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

    try {
        const afterVars = Object.keys((((M as any)?.memory as any)?.vars) || {});
        log.debug('Mental state pruning completed', { varsAfter: Object.keys(afterVars) });
    } catch { /* noop */ }

    return M;
}


