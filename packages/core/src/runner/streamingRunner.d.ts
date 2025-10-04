import type { TaskInput } from '../shared/types/index.js';
type StreamingOptions = {
    isStreaming: boolean;
    outputType?: 'json' | 'sse' | 'console';
    outputFile?: string;
    tenantId?: string;
    resolveDeps?: boolean;
};
/**
 * Run an agent locally with the given input and streaming options
 * @param agentFilePath - Path to the agent module file
 * @param input - Input data for the agent
 * @param options - Streaming and output options
 * @throws {TaskExecutionError} If agent execution fails
 */
export declare function runAgentWithStreaming(agentFilePath: string, input: TaskInput, options: StreamingOptions): Promise<void>;
export {};
