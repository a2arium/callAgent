import type { AgentManifest, TaskContext, AgentTaskContext } from '../shared/types/index.js';
import type { AttentionSignal } from '../loop/oneTurn.js';
import type { LLMConfig } from '../shared/types/LLMTypes.js';
import type { ILLMCaller } from '../shared/types/LLMTypes.js';

/**
 * Agent plugin interface for A2A-compatible agents
 * 
 * Represents a deployable agent that can handle tasks and participate
 * in agent-to-agent communication with context inheritance.
 */
export type AgentPlugin = {
    /** Agent metadata and configuration */
    manifest: AgentManifest;
    /** 
     * Main task handler for the agent
     * @param ctx - Guaranteed agent task context with all working memory and A2A capabilities
     * @returns Promise resolving to task result
     */
    handleTask?: (ctx: AgentTaskContext) => Promise<unknown>;
    /** LLM configuration specific to this agent */
    llmConfig?: LLMConfig;
    /** LLM adapter instance for this plugin */
    llmAdapter?: ILLMCaller;
    /** Tenant context for multi-tenant isolation */
    tenantId: string;
    loop?: { modules?: Partial<import('../loop/oneTurn.js').Modules> };
    // Future hooks: initialize?: () => Promise<void>; shutdown?: () => Promise<void>;
}

/**
 * Options for creating A2A-compatible agent plugins
 */
export type CreateAgentPluginOptions<
    Sensory = unknown,
    Obs = unknown,
    Alpha = AttentionSignal,
    ExecData = unknown,
    ExecError extends import('../loop/oneTurn.js').ExecErrorPayload = import('../loop/oneTurn.js').ExecErrorPayload,
    ObsConfigOrPayload extends import('../loop/oneTurn.js').ObservationConfig = import('../loop/oneTurn.js').ObservationConfig
> = {
    /** Agent manifest - path to JSON file or direct object, defaults to './agent.json' */
    manifest?: string | AgentManifest;
    /** LLM configuration specific to this agent */
    llmConfig?: LLMConfig;
    /** 
     * Main task handler for the agent
     * @param ctx - Guaranteed agent task context with all working memory and A2A capabilities
     * @returns Promise resolving to task result
     */
    handleTask?: (ctx: AgentTaskContext) => Promise<unknown>;
    /** Tenant context for multi-tenant isolation */
    tenantId?: string;
    loop?: { modules?: Partial<import('../loop/oneTurn.js').Modules<Sensory, Obs, Alpha, ExecData, ExecError, ObsConfigOrPayload>> };
    // Sugar: allow defining loop modules at the top level
    attention?: import('../loop/oneTurn.js').Modules<Sensory, Obs, Alpha, ExecData, ExecError, ObsConfigOrPayload>['attention'];
    perception?: import('../loop/oneTurn.js').Modules<Sensory, Obs, Alpha, ExecData, ExecError, ObsConfigOrPayload>['perception'];
    learning?: import('../loop/oneTurn.js').Modules<Sensory, Obs, Alpha, ExecData, ExecError, ObsConfigOrPayload>['learning'];
    policy?: import('../loop/oneTurn.js').Modules<Sensory, Obs, Alpha, ExecData, ExecError, ObsConfigOrPayload>['policy'];
    shield?: import('../loop/oneTurn.js').Modules<Sensory, Obs, Alpha, ExecData, ExecError, ObsConfigOrPayload>['shield'];
    execution?: import('../loop/oneTurn.js').Modules<Sensory, Obs, Alpha, ExecData, ExecError, ObsConfigOrPayload>['execution'];
    transition?: import('../loop/oneTurn.js').Modules<Sensory, Obs, Alpha, ExecData, ExecError, ObsConfigOrPayload>['transition'];
    // Future hooks: initialize?, shutdown?, etc.
}