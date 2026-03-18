import { expectType, expectError } from 'tsd';
import type {
    StageFacade,
    StageEnterContext,
    StageTransitionResult,
    StageSummary,
    StageInvariantRule,
} from '../src/types/stageFacade.js';
import type { TaskContext } from '../src/shared/types/index.js';

// StageFacade methods are typed with stage union
type MyStage = 'idle' | 'running' | 'completed';
declare const facade: StageFacade<MyStage>;
declare const ctx: TaskContext;

expectType<MyStage>(facade.get(ctx));
expectType<boolean>(facade.is(ctx, 'idle'));
expectType<StageTransitionResult<MyStage>>(facade.set(ctx, 'running'));
expectType<StageSummary<MyStage>>(facade.summary(ctx));
expectType<boolean>(facade.summary(ctx).hasPendingInput);
expectType<number>(facade.summary(ctx).markCount);

expectError(facade.set(ctx, 'invalid_stage'));
expectError(facade.is(ctx, 'nonexistent'));

// StageEnterContext is restricted
declare const enterCtx: StageEnterContext;
expectType<(pct: number, message: string) => void>(enterCtx.progress);
expectType<(pct: number, message: string) => void>(enterCtx.complete);
expectError(enterCtx.reply);
expectError(enterCtx.requestInput);
expectError(enterCtx.tools);

// StageInvariantRule is strict
const rule: StageInvariantRule = { require: ['token'], forbid: ['done'] };
expectType<string[] | undefined>(rule.require);
expectError(((): StageInvariantRule => ({ validate: () => {} }))());
