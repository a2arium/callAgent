import { type SafetyOptions } from './effectSafety.js';
export type EffectOptions = SafetyOptions;
export declare function runEffect<T>(fn: () => Promise<T>, opts?: EffectOptions): Promise<T>;
