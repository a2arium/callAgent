// src/shared/types/index.ts (Consolidated for minimal)
import type { ILLMCaller } from './LLMTypes.js';
import type { ComponentLogger } from '@a2arium/callagent-utils'; // Import ComponentLogger
// Explicitly import only needed types from StreamingEvents
import type { TaskStatus, A2AEvent, Artifact } from './StreamingEvents.js';
// UsageRecord is defined in this file (no dependency on provider-specific Usage)
import type { IMemory } from '@a2arium/callagent-types';
// Import working memory types for TaskContext
import type { ThoughtEntry, DecisionEntry } from './workingMemory.js';
import type { RecallOptions, RememberOptions } from './memoryLifecycle.js';
import type { GoalId, GoalNode, GoalStatus, GoalType } from '../../loop/types.js';

// Re-export only specific streaming event types needed externally
export type { A2AEvent, TaskStatus, Artifact };

// Re-export LLM types including the pure LLM port for modules
export type { PureLLMPort, ILLMCaller, LLMConfig } from './LLMTypes.js';
export { extractPureLLMPort } from './LLMTypes.js';

// Working Memory Types
export * from './workingMemory.js';
export * from './memoryLifecycle.js';
export * from './observation.js';

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
    /** Execution mode: 'loop' (default) or 'legacy' */
    runMode?: 'loop' | 'legacy';
    /** Optional default loop budgets */
    budgets?: { maxTurns?: number; latencyMs?: number };
    /** Human-in-the-loop level */
    hitl?: 'advise' | 'consent' | 'guardrails';
    /** Safety configuration */
    safety?: { sanitize?: boolean; costLimit?: number; piiPatterns?: string[] };
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

// --- Usage Tracking ---
export type UsageRecord = {
    cost: number; // USD
    kind: 'llm' | 'embedding' | 'tool' | 'external_api' | 'storage' | 'network' | 'other';
    op?: 'call' | 'stream' | 'embed' | 'invoke' | 'read' | 'write';
    provider?: string;
    model?: string;
    tokens?: { input?: number; output?: number };
    turn?: number; // auto-filled when available
};

// --- Messages & Parts (Simplified) ---
export type MessagePart = {
    type: string; // e.g., 'text', 'data', 'file'
    // Content depends on type. Focus on text for minimal.
    text?: string; // for type === 'text'
    data?: unknown;    // for type === 'data'
    // Payload for rich parts (e.g., markup passthrough)
    value?: unknown;
    // Future: uri, bytes, etc.
    format?: 'plain' | 'markdown' | 'html';
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

// --- Task Context (Interface for agent task handling) ---
export type TaskContext = {
    // Readonly mental state view for queries
    M?: Readonly<import('../../loop/types.js').MentalState>;
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

    // Usage recording supports numeric shortcut or detailed record
    recordUsage: (cost: number | UsageRecord) => void;
    // Read-only accessor for current aggregated usage
    getUsage?: () => { totalCost: number; byKind: Record<string, number> };

    // Use the ILLMCaller interface for llm, allow optional state (de)serialization
    llm: ILLMCaller & { exportState?: () => unknown; importState?: (state: unknown) => void };

    // Working Memory Operations (replaced by namespaced helpers below)

    // Working memory variables - facade (writes via methods only)
    vars: {
        /**
         * Get a variable value. Supports nested paths using dot notation.
         * @param key - Variable key or nested path (e.g., 'user.profile.name')
         * @returns The stored value or undefined if not found
         * @example
         * const name = ctx.vars.get('user.profile.name');
         * const stage = ctx.vars.get('stage');
         */
        get<T = unknown>(key: string): T | undefined;

        /**
         * Set a variable value. Supports nested paths with automatic object creation.
         * @param key - Variable key or nested path (e.g., 'user.profile.email')
         * @param value - Value to store
         * @example
         * ctx.vars.set('user.profile.email', 'john@example.com');
         * ctx.vars.set('stage', 'completed');
         */
        set<T = unknown>(key: string, value: T): void;

        /**
         * Merge multiple key-value pairs into variables. Does NOT treat dots as paths.
         * @param patch - Object containing key-value pairs to merge
         * @example
         * ctx.vars.merge({ stage: 'completed', counter: 42 });
         * // Note: merge({ 'user.profile.email': 'value' }) creates a key with dots
         */
        merge(patch: Record<string, unknown>): void;

        /**
         * Update a variable value using a function that receives the current value.
         * Supports nested paths with automatic object creation.
         * @param key - Variable key or nested path (e.g., 'counter', 'user.profile.name')
         * @param fn - Function that receives current value and returns new value
         * @example
         * ctx.vars.update('counter', (current) => (current || 0) + 1);
         * ctx.vars.update('user.profile.name', (current) => current?.toUpperCase() || 'UNKNOWN');
         */
        update<T = unknown>(key: string, fn: (prev: T | undefined) => T): void;

        /**
         * Delete a variable. Supports nested paths.
         * @param key - Variable key or nested path to delete
         * @example
         * ctx.vars.delete('user.profile.email');
         * ctx.vars.delete('temporaryData');
         */
        delete(key: string): void;

        /**
         * Get all variable keys (top-level only).
         * @returns Array of variable keys
         * @example
         * const keys = ctx.vars.keys(); // ['user', 'stage', 'counter']
         */
        keys(): string[];

        /**
         * Check if a variable exists. Supports nested paths.
         * @param key - Variable key or nested path to check
         * @returns True if the variable exists
         * @example
         * if (ctx.vars.has('user.profile.email')) { ... }
         */
        has(key: string): boolean;
    };

    // Namespaced helpers (minimal, ergonomic)
    goals?: {
        add: (g: any) => Promise<string> | string;
        update: (id: string, patch: any) => Promise<void> | void;
        remove: (id: string) => Promise<void> | void;
        clear: (predicate?: (g: any) => boolean) => Promise<void> | void;
        read: (filter?: any) => Promise<any[]> | any[];
    };
    episodic?: { add: (e: any) => void };
    thoughts?: { add: (t: { text: string } | string) => Promise<void> | void };
    // Semantic memory facade (hybrid): prefer add/read/remove over legacy set/get/delete
    semantic?: {
        add: (item: SemanticAddInput) => Promise<void> | void;
        read: (filter?: SemanticReadFilter) => Promise<SemanticItem[]> | SemanticItem[];
        remove: (idOrPredicate: string | ((item: SemanticItem) => boolean)) => Promise<void> | void;
    };
    world?: { update: (fn: (wm: any) => void) => void; patch: (p: Record<string, unknown>) => void };
    decisions?: {
        add: (key: string, value: unknown, reasoning?: string) => Promise<void>;
        get: (key: string) => Promise<{ key: string; value: unknown; reasoning?: string; ts: string } | null>;
        read: (filter?: { prefix?: string }) => Promise<Array<{ key: string; value: unknown; reasoning?: string; ts: string }>>;
    };

    // Unified memory operations - REQUIRED
    recall: (query: string, options?: RecallOptions) => Promise<unknown[]>;
    remember: (key: string, value: unknown, options?: RememberOptions) => Promise<void>;

    // Future Capabilities (Stubbed/Placeholder - DO NOT USE in minimal agent logic)
    tools: { invoke: <T = unknown>(toolName: string, args: unknown, options?: { onCompleted?: string; setToken?: boolean; setStage?: string }) => Promise<T> };
    memory: IMemory & {
        // NEW: Direct MLO access (will be defined later)
        mlo?: unknown; // Enhanced for A2A serialization - UnifiedMemoryService or compatible service
        semantic?: unknown; // Placeholder for semantic adapter access
        episodic?: unknown; // Placeholder for episodic adapter access
        embed?: unknown; // Placeholder for embed adapter access
    };
    cognitive: { loadWorkingMemory: (e: unknown) => void; plan: (prompt: string, options?: unknown) => Promise<unknown>; record: (state: unknown) => void; flush: () => Promise<void>; };
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
     * Request human or external input. Returns an InputHandle for durable handler chaining.
     */
    requestInput: (
        promptOrParts: string | string[] | MessagePart | MessagePart[],
        opts?: {
            schema?: unknown;
            ttlMs?: number;
            onProvided?: string;
            onExpired?: string;
            setToken?: boolean;
            setStage?: string
        }
    ) => Promise<import('../../core/orchestration/Handles.js').InputHandle>;

    /**
     * Group orchestration for running multiple child tasks and joining their results.
     */
    allTasks?: (
        children: Array<{ agent: string; input: unknown }>,
        opts?: { withTimeoutMs?: number; cancelRemaining?: boolean; onAllCompleted?: string; onAnyFailed?: string }
    ) => Promise<import('../../core/orchestration/Handles.js').GroupHandle>;

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
        options?: import('./A2ATypes.js').A2ACallOptions & { onCompleted?: string; onFailed?: string; onInputRequired?: string }
    ) => Promise<import('./A2ATypes.js').InteractiveTaskResult | unknown>;
}

// --- Semantic facade types ---
export type SemanticAddInput = {
    id: string;
    value: unknown;
    tags?: string[];
    entities?: Record<string, unknown>;
    backend?: string;
};

export type SemanticReadFilter = {
    id?: string | string[];
    tag?: string;
    tags?: string[];
    backend?: string;
    limit?: number;
};

export type SemanticItem = {
    id: string;
    value: unknown;
    tags?: string[];
    entities?: Record<string, unknown>;
};

/**
 * Guaranteed Agent Task Context
 * This type ensures that all working memory and A2A methods are definitely available
 * Use this type for agent implementations to avoid "possibly undefined" errors
 */
export type AgentTaskContext = Required<Pick<TaskContext,
    'vars' | 'recall' | 'remember' | 'sendTaskToAgent'
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

// --- Canonical Input Discriminators & Guards ---
/**
 * Child task completion resume event payload.
 * Emitted when a delegated child agent completes and returns a result.
 */
export type ChildCompletionInput = {
    kind: 'child';
    token: string;
    childTaskId?: string;
    agentId?: string;
    result: unknown;
};

/**
 * Tool invocation completion resume event payload.
 * Emitted when a long-running tool callback completes and returns a result.
 */
export type ToolCompletionInput = {
    kind: 'tool';
    token: string;
    toolId?: string;
    result: unknown;
};

/**
 * Direct human input resume event payload.
 * Carries the user-provided value and the durable token.
 */
export type DirectInput = { kind: 'input'; token?: string; value: unknown };

/**
 * External event payload forwarded into the loop.
 */
export type ExternalEventInput = { kind: 'external'; event: unknown };

export type InputKind = ChildCompletionInput | ToolCompletionInput | DirectInput | ExternalEventInput;

/** True if value is a child agent completion payload. */
export function isChildCompletionInput(x: unknown): x is ChildCompletionInput {
    return !!x && typeof x === 'object' && (x as any).kind === 'child' && typeof (x as any).token === 'string';
}

/** True if value is a tool completion payload. */
export function isToolCompletionInput(x: unknown): x is ToolCompletionInput {
    return !!x && typeof x === 'object' && (x as any).kind === 'tool' && typeof (x as any).token === 'string';
}

/** True if value is a direct human input payload. */
export function isDirectInput(x: unknown): x is DirectInput {
    return !!x && typeof x === 'object' && (x as any).kind === 'input' && 'value' in (x as any);
}

/** True if value is an external event payload. */
export function isExternalEventInput(x: unknown): x is ExternalEventInput {
    return !!x && typeof x === 'object' && (x as any).kind === 'external' && 'event' in (x as any);
}