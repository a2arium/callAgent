import type { TaskInput } from '../shared/types/index.js';

export interface RunnerContext {
    input: TaskInput;
    options: Record<string, unknown>;
}

export interface RunnerResult {
    success: boolean;
    output?: unknown;
    error?: Error;
}

export interface IRunner {
    run(context: RunnerContext): Promise<RunnerResult>;
}
