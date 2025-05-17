import type { AgentManifest, TaskContext } from '../../shared/types/index.js';
import type { LLMConfig } from '../../shared/types/LLMTypes.js';
import type { ILLMCaller } from '../../shared/types/LLMTypes.js';
export type AgentPlugin = {
    manifest: AgentManifest;
    handleTask: (ctx: TaskContext) => Promise<void>;
    llmConfig?: LLMConfig;
    llmAdapter?: ILLMCaller;
};
export type CreateAgentPluginOptions = {
    manifest?: string | AgentManifest;
    llmConfig?: LLMConfig;
    handleTask: (ctx: TaskContext) => Promise<void>;
};
