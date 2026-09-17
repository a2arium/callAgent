import type { TransitionOut, ShieldOutcome } from '../loop/oneTurn.js';
import type { Intent } from '../types/intent.js';
import type { TurnTrace } from '../types/turnTrace.js';
import type { TurnAssertionContext } from './harnessTypes.js';

export class HarnessAssertionError extends Error {
    constructor(
        public readonly field: string,
        public readonly expected: unknown,
        public readonly actual: unknown,
        public readonly turn: number
    ) {
        super(`Turn ${turn}: expected ${field} to be ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
        this.name = 'HarnessAssertionError';
    }
}

export function createTurnAssertionContext(trace: TurnTrace): TurnAssertionContext {
    return {
        trace,
        expectIntent(kind: Intent['kind']) {
            if (trace.intent?.kind !== kind) {
                throw new HarnessAssertionError('intent.kind', kind, trace.intent?.kind, trace.turn);
            }
            return this;
        },
        expectShield(action: ShieldOutcome['action']) {
            if (trace.shield?.action !== action) {
                throw new HarnessAssertionError('shield.action', action, trace.shield?.action, trace.turn);
            }
            return this;
        },
        expectTransition(kind: TransitionOut['kind']) {
            if (trace.transition?.kind !== kind) {
                throw new HarnessAssertionError('transition.kind', kind, trace.transition?.kind, trace.turn);
            }
            return this;
        },
        expectAwaitToken(token: string) {
            if (trace.transition?.token !== token) {
                throw new HarnessAssertionError('transition.token', token, trace.transition?.token, trace.turn);
            }
            return this;
        },
        expectStageTransition(from: string, to: string) {
            if (trace.stageTransition?.from !== from || trace.stageTransition?.to !== to) {
                throw new HarnessAssertionError(
                    'stageTransition',
                    { from, to },
                    trace.stageTransition,
                    trace.turn
                );
            }
            return this;
        },
        expectStageBefore(stage: string) {
            if (trace.stageBefore !== stage) {
                throw new HarnessAssertionError('stageBefore', stage, trace.stageBefore, trace.turn);
            }
            return this;
        },
        expectStageAfter(stage: string) {
            if (trace.stageAfter !== stage) {
                throw new HarnessAssertionError('stageAfter', stage, trace.stageAfter, trace.turn);
            }
            return this;
        },
        expectInboxKinds(kinds: string[]) {
            const actualKinds = trace.inboxCurrent.map(o => o.kind);
            const missing = kinds.filter(k => !actualKinds.includes(k));
            if (missing.length > 0) {
                throw new HarnessAssertionError('inboxCurrent', kinds, actualKinds, trace.turn);
            }
            return this;
        },
        expectMemoryChanged() {
            if (trace.mentalStateBeforeHash === trace.mentalStateAfterHash) {
                throw new HarnessAssertionError(
                    'mentalStateAfterHash',
                    '<changed>',
                    '<unchanged>',
                    trace.turn
                );
            }
            return this;
        }
    };
}
