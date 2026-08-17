import { expectType, expectError } from 'tsd';
import type { TurnTrace, TurnTraceExtension } from '../src/types/turnTrace.js';

declare const trace: TurnTrace;
expectType<TurnTraceExtension[] | undefined>(trace.extensions);
expectError(trace.memoryReads);
expectError(trace.related);

declare const ext: TurnTraceExtension;
expectType<string>(ext.namespace);
expectType<string>(ext.version);
expectError(ext.related);
expectError(ext.payload);
