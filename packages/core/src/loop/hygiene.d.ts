import type { MentalState } from './types.js';
type HygieneConfig = {
    episodicCap?: number;
    ttlDays?: number;
    thoughtsCap?: number;
    decisionsCap?: number;
};
export declare function pruneMentalState(input: MentalState, cfg?: HygieneConfig): MentalState;
export {};
