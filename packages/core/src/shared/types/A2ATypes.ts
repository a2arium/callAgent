import type { TaskInput, TaskStatus, Artifact } from './index.js'; // From core index
import type { ThoughtEntry, DecisionEntry } from '@a2arium/callagent-memory-engine';
import type { ThreadRef } from '../../public-types/conversation/types.js'; // From memory-engine
import type { SerializedAgentContext } from '@a2arium/callagent-memory-engine'; // Serialization types from memory-engine
import type { ILLMCaller } from './LLMTypes.js';

// Re-export serialization types for convenience
export type { SerializedAgentContext };
export type { SerializedWorkingMemory, SerializedMemoryContext, RecalledMemoryItem } from '@a2arium/callagent-memory-engine';

/**
 * Minimal TaskContext interface needed by IA2AService to avoid circular dependencies.
 * The full TaskContext will be defined in index.ts and will implement/extend this.
 */
export type MinimalSourceTaskContext = {
    task: { id: string; [key: string]: unknown };
    tenantId: string;
    getGoal?: () => Promise<string | null>;
    getThoughts?: () => Promise<ThoughtEntry[]>;
    // Add other methods IA2AService's sendTaskToAgent might directly need from sourceCtx *before* targetCtx creation
    // For example, for memory operations *during* serialization.
    recall?: (query: string, options?: Record<string, unknown>) => Promise<unknown[]>;
    memory?: {
        semantic?: unknown; // Placeholder for semantic adapter type if needed by serializer
        mlo?: {
            getAllDecisions?: (agentId?: string) => Promise<Record<string, DecisionEntry>>;
            [key: string]: unknown;
        };
        [key: string]: unknown;
    };

    // Add agentId to allow the serializer to get the source agent's ID
    agentId: string;

    /** Present when the caller participates in the telemetry tree (e.g. loop turn or subagent). */
    telemetry?: {
        nodeId?: string;
        traceId?: string;
    };
    // Add llm and tools for sharing with target context
    llm?: ILLMCaller;
    tools?: {
        invoke(name: string, args: Record<string, unknown>): Promise<unknown>;
    };
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
    /** When false, child result arrives via inbox on next turn (even from cache). When true, parent receives result immediately (blocking). */
    awaitCompletion?: boolean;
    /** Override cache behavior for this call */
    cache?: {
        /** Enable/disable caching for this call (overrides manifest when set) */
        enabled?: boolean;
        /** Override TTL in seconds; falls back to manifest when omitted */
        ttlSeconds?: number;
        /** Override excludePaths; falls back to manifest when omitted */
        excludePaths?: string[];
    };
    /** Automatically store child token in env.pending.controlVars when child requests input */
    setToken?: boolean;
    /** Path in controlVars where token is stored (default: 'child.token') */
    tokenPath?: string;
    /** Automatically clear token when child completes (default: true) */
    autoClearToken?: boolean;
    /** Automatically transition to stage when child requests input */
    setStage?: string;
    /** Explicitly provide a task ID for the child agent (for persistence/resumption) */
    childTaskId?: string;
    /**
     * Reuse an existing thread for this dispatch (multi-turn `sendTaskToAgent`).
     * Thread-only; use `ctx.conversation.startThread` first to obtain a `ThreadRef`.
     */
    conversation?: ThreadRef;
    /** Optional plan-step correlation stamps written onto the pending child record. */
    planId?: string;
    stepId?: string;
    advanceCursor?: boolean;
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

    findLocalAgent: (agentName: string) => Promise<import('../../plugin/types.js').AgentPlugin | null>;
    waitForPendingNotifications: () => Promise<void>;
};
