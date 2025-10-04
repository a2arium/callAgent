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
export declare function runOfflineReplay(M: MentalState, optimizer: OfflineOptimizer): Promise<OfflineReplayResult>;
