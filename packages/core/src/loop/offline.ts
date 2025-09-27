import type { MentalState, EpisodicEvent } from './types.js';

export type OptimizerPatch = {
    policyParamsPatch?: Partial<MentalState['policyParams']>;
    rewardParamsPatch?: Partial<MentalState['rewardParams']>;
};

export type OfflineOptimizer = {
    onEpisode: (events: EpisodicEvent[], M: MentalState) => Promise<OptimizerPatch | void> | (OptimizerPatch | void);
};

export type OfflineReplayResult = {
    M: MentalState;
    applied: OptimizerPatch;
    eventCount: number;
};

export async function runOfflineReplay(M: MentalState, optimizer: OfflineOptimizer): Promise<OfflineReplayResult> {
    const events = Array.isArray(M?.memory?.longTerm?.episodic) ? (M.memory.longTerm.episodic as EpisodicEvent[]) : [];
    const patch = (await optimizer.onEpisode(events, M)) || {};
    const applied: OptimizerPatch = { policyParamsPatch: {}, rewardParamsPatch: {} };
    try {
        if (patch.policyParamsPatch && typeof patch.policyParamsPatch === 'object') {
            M.policyParams = { ...(M.policyParams || {} as any), ...(patch.policyParamsPatch as any) };
            applied.policyParamsPatch = patch.policyParamsPatch;
        }
    } catch { /* noop */ }
    try {
        if (patch.rewardParamsPatch && typeof patch.rewardParamsPatch === 'object') {
            M.rewardParams = { ...(M.rewardParams || {} as any), ...(patch.rewardParamsPatch as any) } as any;
            applied.rewardParamsPatch = patch.rewardParamsPatch;
        }
    } catch { /* noop */ }
    return { M, applied, eventCount: events.length };
}


