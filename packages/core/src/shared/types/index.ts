// src/shared/types/index.ts (Consolidated for minimal)
import type { ILLMCaller } from './LLMTypes.js';
import type { ComponentLogger } from '@a2arium/callagent-utils'; // Import ComponentLogger
// Explicitly import only needed types from StreamingEvents
import type { TaskStatus, A2AEvent, Artifact } from './StreamingEvents.js';
import type { Usage } from './LLMTypes.js'; // Import Usage type
import type { IMemory } from '@a2arium/callagent-types';
// Import working memory types for TaskContext
import type { ThoughtEntry, DecisionEntry, WorkingVariables } from './workingMemory.js';
import type { RecallOptions, RememberOptions } from './memoryLifecycle.js';

// Re-export only specific streaming event types needed externally
export type { A2AEvent, TaskStatus, Artifact };

// Working Memory Types
export * from './workingMemory.js';
export * from './memoryLifecycle.js';

// A2A (Agent-to-Agent) Communication Types
export * from './A2ATypes.js';

// MLO Configuration Types
export * from '../../core/memory/lifecycle/config/types.js';

// MLO Interface Types
export * from '../../core/memory/lifecycle/interfaces/index.js';

// --- Agent Card (Enhanced for A2A) ---
/**
 * Agent manifest defines the metadata and capabilities of an agent
 * Used for A2A communication to identify and configure target agents
 */
export type AgentManifest = {
    /** Agent name identifier */
    name: string;
    /** Agent version */
    version: string;
    /** Optional agent description */
    description?: string;
    /** Memory configuration for A2A context inheritance */
    memory?: {
        /** Memory profile (e.g., 'basic', 'advanced', 'custom') */
        profile?: string;
        /** Additional memory configuration */
        [key: string]: unknown;
    };
    /** Agent result caching configuration */
    cache?: {
        /** Enable/disable caching for this agent (default: false) */
        enabled?: boolean;
        /** Cache TTL in seconds (default: 300 = 5 minutes) */
        ttlSeconds?: number;
        /** Paths to exclude from cache key (dot notation for nested objects) */
        excludePaths?: string[];
    };
    // Future: capabilities, endpoint, auth, plugins, tools, etc.
    [key: string]: unknown;
}

// --- Messages & Parts (Simplified) ---
export type MessagePart = {
    type: string; // e.g., 'text', 'data', 'file'
    // Content depends on type. Focus on text for minimal.
    text?: string; // for type === 'text'
    data?: unknown;    // for type === 'data'
    // Future: uri, bytes, etc.
}

export type Message = {
    role: 'user' | 'agent' | string; // Simplified roles for minimal
    parts: MessagePart[];
}

// --- Task Input (Simplified) ---
export type TaskInput = {
    // In minimal, just represent a single user message for simplicity
    // Future: array of Messages, parameters, artifacts, metadata
    messages?: Message[]; // Represents the conversation history or current turn
    // Allow generic data for simple initial tests
    [key: string]: unknown;
}

// Define a type for the logger expected by TaskContext
// This could eventually just be ComponentLogger directly
export type TaskLogger = {
    debug: (msg: string, ...args: unknown[]) => void;
    info: (msg: string, ...args: unknown[]) => void;
    warn: (msg: string, ...args: unknown[]) => void;
    // Match the ComponentLogger signature for error
    error: (msg: string, error?: unknown, context?: Record<string, unknown>) => void;
};

// --- Task Context (Interface for agent task handling) ---
export type TaskContext = {
    // Tenant context for multi-tenant operations
    tenantId: string;
    // Agent identifier for the current agent
    agentId: string;
    task: {
        id: string;
        input: TaskInput;
        // Future: status, artifacts, createdAt, etc.
    };
    // Basic Output & Status Control (Implemented minimally)
    reply: (parts: string | string[] | MessagePart | MessagePart[]) => Promise<void>;
    progress: ((pct: number, msg?: string) => void) & ((status: TaskStatus) => void); // Support both signatures
    complete: (pct?: number, status?: string) => void; // Basic console log
    fail: (error: unknown) => Promise<void>; // Added fail method

    // Add usage recording method that accepts multiple formats for backward compatibility
    recordUsage: (cost: number | { cost: number } | Usage) => void;

    // Use the ILLMCaller interface for llm
    llm: ILLMCaller;

    // Working Memory Operations - REQUIRED for all agents
    setGoal: (goal: string) => Promise<void>;
    getGoal: () => Promise<string | null>;
    addThought: (thought: string) => Promise<void>;
    getThoughts: () => Promise<ThoughtEntry[]>;
    makeDecision: (key: string, decision: string, reasoning?: string) => Promise<void>;
    getDecision: (key: string) => Promise<DecisionEntry | null>;
    getAllDecisions: () => Promise<Record<string, DecisionEntry>>; // A2A: Required for context serialization

    // Working memory variables - REQUIRED
    vars: WorkingVariables;

    // Unified memory operations - REQUIRED
    recall: (query: string, options?: RecallOptions) => Promise<unknown[]>;
    remember: (key: string, value: unknown, options?: RememberOptions) => Promise<void>;

    // Future Capabilities (Stubbed/Placeholder - DO NOT USE in minimal agent logic)
    tools: { invoke: <T = unknown>(toolName: string, args: unknown) => Promise<T> };
    memory: IMemory & {
        // NEW: Direct MLO access (will be defined later)
        mlo?: unknown; // Enhanced for A2A serialization - UnifiedMemoryService or compatible service
        semantic?: unknown; // Placeholder for semantic adapter access
        episodic?: unknown; // Placeholder for episodic adapter access
        embed?: unknown; // Placeholder for embed adapter access
    };
    cognitive: { loadWorkingMemory: (e: unknown) => void; plan: (prompt: string, options?: unknown) => Promise<unknown>; record: (state: unknown) => void; flush: () => Promise<void>; };
    logger: TaskLogger; // Use the defined TaskLogger type
    config: unknown; // Minimal config object
    validate: (schema: unknown, data: unknown) => void; // Basic validation, will throw
    retry: <T = unknown>(fn: () => Promise<T>, opts: unknown) => Promise<T>;
    cache: { get: <T = unknown>(key: string) => Promise<T | null>; set: <T = unknown>(key: string, value: T, ttl?: number) => Promise<void>; delete: (key: string) => Promise<void>; };
    emitEvent: (channel: string, payload: unknown) => Promise<void>;
    updateStatus: (state: string) => void; // Placeholder for FSM state
    services: { get: <T = unknown>(name: string) => T | undefined }; // Placeholder for service registry
    getEnv: (key: string, defaultValue?: string) => string | undefined;
    throw: (code: string, message: string, details?: unknown) => never; // Structured error throw

    /** 
     * A2A: Send task to another agent with context inheritance
     * This method enables agent-to-agent communication with memory context transfer
     * @param targetAgent - Name of the target agent
     * @param taskInput - Input data for the target agent
     * @param options - A2A communication options (memory inheritance, tenant context, etc.)
     * @returns Promise resolving to task result or interactive task handle
     */
    sendTaskToAgent: (
        targetAgent: string,
        taskInput: TaskInput,
        options?: import('./A2ATypes.js').A2ACallOptions
    ) => Promise<import('./A2ATypes.js').InteractiveTaskResult | unknown>;
}

/**
 * Guaranteed Agent Task Context
 * This type ensures that all working memory and A2A methods are definitely available
 * Use this type for agent implementations to avoid "possibly undefined" errors
 */
export type AgentTaskContext = Required<Pick<TaskContext,
    'setGoal' | 'getGoal' | 'addThought' | 'getThoughts' |
    'makeDecision' | 'getDecision' | 'getAllDecisions' | 'vars' |
    'recall' | 'remember' | 'sendTaskToAgent'
>> & TaskContext;

/**
 * Type assertion helper for agents to guarantee they have all working memory methods
 * Use this at the start of your agent's handleTask function to ensure TypeScript
 * recognizes that all working memory methods are available.
 * 
 * @param ctx - The task context passed to the agent
 * @returns The same context but typed as AgentTaskContext
 * 
 * @example
 * ```typescript
 * async handleTask(ctx) {
 *   const agentCtx = ensureAgentContext(ctx);
 *   await agentCtx.setGoal('My goal'); // No TypeScript errors
 * }
 * ```
 */
export function ensureAgentContext(ctx: TaskContext): AgentTaskContext {
    // Runtime validation to ensure all required methods are present
    const requiredMethods = [
        'setGoal', 'getGoal', 'addThought', 'getThoughts',
        'makeDecision', 'getDecision', 'getAllDecisions',
        'recall', 'remember', 'sendTaskToAgent'
    ];

    for (const method of requiredMethods) {
        if (typeof (ctx as any)[method] !== 'function') {
            throw new Error(`Agent context is missing required method: ${method}. Ensure the agent is run through the proper runner with memory support.`);
        }
    }

    if (!ctx.vars || typeof ctx.vars !== 'object') {
        throw new Error('Agent context is missing required vars object. Ensure the agent is run through the proper runner with memory support.');
    }

    return ctx as AgentTaskContext;
} 