import type { AgentManifest, TaskContext } from '../../shared/types/index.js';
import type { LLMConfig } from '../../shared/types/LLMTypes.js';
import type { ILLMCaller } from '../../shared/types/LLMTypes.js';

export type AgentPlugin = {
    manifest: AgentManifest;
    handleTask: (ctx: TaskContext) => Promise<void>;
    // Store the LLM adapter instance for this plugin
    llmAdapter?: ILLMCaller;
    // Future hooks: initialize?: () => Promise<void>; shutdown?: () => Promise<void>;
}

export type CreateAgentPluginOptions = {
    manifest: string | AgentManifest; // Path or direct object
    llmConfig?: LLMConfig; // LLM configuration specific to this agent
    handleTask: (ctx: TaskContext) => Promise<void>;
    // Future hooks
} 