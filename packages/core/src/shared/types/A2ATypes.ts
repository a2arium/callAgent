import type { TaskInput, TaskStatus, Artifact } from './index.js'; // Presumed to be safe if index.ts doesn't import A2ATypes.ts directly for TaskContext augmentation
import type { ThoughtEntry, DecisionEntry } from './workingMemory.js';

/**
 * Minimal TaskContext interface needed by IA2AService to avoid circular dependencies.
 * The full TaskContext will be defined in index.ts and will implement/extend this.
 */
export type MinimalSourceTaskContext = {
    task: { id: string;[key: string]: any };
    tenantId: string;
    getGoal?: () => Promise<string | null>;
    getThoughts?: () => Promise<ThoughtEntry[]>;
    // Add other methods IA2AService's sendTaskToAgent might directly need from sourceCtx *before* targetCtx creation
    // For example, for memory operations *during* serialization.
    recall?: (query: string, options?: any) => Promise<any[]>;
    memory?: {
        semantic?: any; // Placeholder for semantic adapter type if needed by serializer
        mlo?: {
            getAllDecisions?: (agentId?: string) => Promise<Record<string, DecisionEntry>>;
            [key: string]: any;
        };
        [key: string]: any;
    };
    vars?: Record<string, any>;
    // Add agentId to allow the serializer to get the source agent's ID
    agentId: string;
    // Add llm and tools for sharing with target context
    llm?: any;
    tools?: any;
};

/**
 * Options for agent-to-agent communication
 */
export type A2ACallOptions = {
    /** Include semantic and episodic memory context */
    inheritMemory?: boolean;
    /** Include working memory (goals, thoughts, decisions, variables) */
    inheritWorkingMemory?: boolean;
    /** Override tenant context (defaults to current agent's tenant) */
    tenantId?: string;
    /** Call timeout in milliseconds */
    timeout?: number;
    /** Enable streaming updates (future) */
    streaming?: boolean;
};

/**
 * Serialized working memory state for transfer between agents
 */
export type SerializedWorkingMemory = {
    goal?: string;
    thoughts: ThoughtEntry[];
    decisions: Record<string, DecisionEntry>;
    variables: Record<string, unknown>;
};

/**
 * Represents a single recalled memory item for transfer.
 */
export type RecalledMemoryItem = {
    id: string; // Or a unique key for the memory item
    type: 'semantic' | 'episodic' | string; // Type of memory
    data: unknown; // The actual memory content
    metadata?: Record<string, unknown>; // Any associated metadata
};

/**
 * Memory context keys and snapshot for transfer
 */
export type SerializedMemoryContext = {
    /** 
     * Optional high-level semantic keys or topics representing the context.
     * Further clarification needed during implementation on its exact role 
     * if memorySnapshot is comprehensive.
     */
    semanticKeys?: string[];
    episodicEventCount?: number; // Or a more direct representation of episodic context
    /** 
     * A snapshot of recalled memory items, preserving their structure and type.
     */
    memorySnapshot: RecalledMemoryItem[];
};

/**
 * Complete context package for agent transfer
 */
export type SerializedAgentContext = {
    tenantId: string;
    sourceTaskId: string;
    sourceAgentId: string; // Ensure this is correctly populated
    timestamp: string;
    workingMemory?: SerializedWorkingMemory;
    memoryContext?: SerializedMemoryContext;
};

/**
 * Result interface for interactive agent communication
 */
export type InteractiveTaskResult = {
    /** Subscribe to task status updates */
    onStatusUpdate: (callback: (status: TaskStatus) => void) => void;
    /** Subscribe to new artifacts */
    onArtifactUpdate: (callback: (artifact: Artifact) => void) => void;
    /** Handle input-required scenarios */
    onInputRequired: (callback: (prompt: string) => Promise<string>) => void;
    /** Send input to continue task */
    sendInput: (input: string) => Promise<void>;
    /** Cancel the running task */
    cancel: (reason?: string) => Promise<void>;
    /** Wait for final completion */
    waitForCompletion: () => Promise<unknown>;
    /** Get current task state */
    getStatus: () => Promise<TaskStatus>;
};

/**
 * A2A service interface
 */
export type IA2AService = {
    sendTaskToAgent: (
        sourceCtx: MinimalSourceTaskContext, // Use minimal context here
        targetAgent: string,
        taskInput: TaskInput,
        options?: A2ACallOptions
    ) => Promise<InteractiveTaskResult | unknown>;

    findLocalAgent: (agentName: string) => Promise<import('../../core/plugin/types.js').AgentPlugin | null>;
}; 