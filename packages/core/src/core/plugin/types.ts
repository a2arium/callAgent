import type { AgentManifest, TaskContext } from '../../shared/types/index.js';
import type { LLMConfig } from '../../shared/types/LLMTypes.js';
import type { ILLMCaller } from '../../shared/types/LLMTypes.js';

export type AgentPlugin = {
    manifest: AgentManifest;
    handleTask: (ctx: TaskContext) => Promise<void>;
    // Store either the LLM config or adapter instance for this plugin
    llmConfig?: LLMConfig;
    llmAdapter?: ILLMCaller;
    // Store tenant context for this agent
    tenantId: string;
    // Future hooks: initialize?: () => Promise<void>; shutdown?: () => Promise<void>;
}

export type CreateAgentPluginOptions = {
    manifest?: string | AgentManifest; // Path or direct object, defaults to './agent.json' when not provided
    llmConfig?: LLMConfig; // LLM configuration specific to this agent
    handleTask: (ctx: TaskContext) => Promise<void>;
    tenantId?: string; // Tenant context for this agent
    // Future hooks
} 