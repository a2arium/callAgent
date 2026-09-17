import { expectType } from 'tsd';
import type { LLMCallOptions } from '../src/types/llmContracts.js';
import type { ILLMCaller, LLMMessage } from '../src/shared/types/LLMTypes.js';
import type { ExecOutcome, ExecResult } from '../src/types/execOutcome.js';
import type { ExecutableAction } from '../src/types/intent.js';

declare const options: LLMCallOptions;
expectType<number | undefined>(options.temperature);
expectType<number | undefined>(options.seed);
expectType<number | undefined>(options.timeoutMs);
expectType<AbortSignal | undefined>(options.signal);

declare const message: LLMMessage;
expectType<string | Record<string, unknown>>(message);

declare const llm: ILLMCaller;
expectType<Promise<unknown>>(llm.call('hello', options).then(() => undefined));

declare const action: ExecutableAction;
declare const result: ExecResult;
const outcome: ExecOutcome = { action, result };
expectType<ExecOutcome>(outcome);
