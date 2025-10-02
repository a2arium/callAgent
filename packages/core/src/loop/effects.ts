import { withSafety, type SafetyOptions } from './effectSafety.js';

export type EffectOptions = SafetyOptions;

export async function runEffect<T>(fn: () => Promise<T>, opts: EffectOptions = {}): Promise<T> {
    return withSafety(fn, opts);
}


