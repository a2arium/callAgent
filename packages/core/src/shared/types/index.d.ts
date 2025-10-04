import type { ILLMCaller } from './LLMTypes.js';
import type { TaskStatus, A2AEvent, Artifact } from './StreamingEvents.js';
import type { Usage } from './LLMTypes.js';
import type { IMemory } from '@a2arium/callagent-types';
import type { RecallOptions, RememberOptions } from './memoryLifecycle.js';
export type { A2AEvent, TaskStatus, Artifact };
export * from './workingMemory.js';
export * from './memoryLifecycle.js';
export * from './A2ATypes.js';
export * from '../../core/memory/lifecycle/config/types.js';
export * from '../../core/memory/lifecycle/interfaces/index.js';
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
    budgets?: {
        maxTurns?: number;
        latencyMs?: number;
    };
    /** Human-in-the-loop level */
    hitl?: 'advise' | 'consent' | 'guardrails';
    /** Safety configuration */
    safety?: {
        sanitize?: boolean;
        costLimit?: number;
        piiPatterns?: string[];
    };
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
    [key: string]: unknown;
};
export type MessagePart = {
    type: string;
    text?: string;
    data?: unknown;
    value?: unknown;
    format?: 'plain' | 'markdown' | 'html';
};
export type Message = {
    role: 'user' | 'agent' | string;
    parts: MessagePart[];
};
export type TaskInput = {
    messages?: Message[];
    [key: string]: unknown;
};
export type TaskLogger = {
    debug: (event: string, data?: Record<string, unknown>) => void;
    info: (event: string, data?: Record<string, unknown>) => void;
    warn: (event: string, data?: Record<string, unknown>) => void;
    error: (event: string, data?: Record<string, unknown>) => void;
};
export type TaskContext = {
    M?: Readonly<import('../../loop/types.js').MentalState>;
    tenantId: string;
    agentId: string;
    task: {
        id: string;
        input: TaskInput;
    };
    reply: (parts: string | string[] | MessagePart | MessagePart[]) => Promise<void>;
    progress: ((pct: number, msg?: string) => void) & ((status: TaskStatus) => void);
    complete: (pct?: number, status?: string) => void;
    fail: (error: unknown) => Promise<void>;
    recordUsage: (cost: number | {
        cost: number;
    } | Usage) => void;
    llm: ILLMCaller & {
        exportState?: () => unknown;
        importState?: (state: unknown) => void;
    };
    vars: {
        get<T = unknown>(key: string): T | undefined;
        set<T = unknown>(key: string, value: T): void;
        merge(patch: Record<string, unknown>): void;
        update<T = unknown>(key: string, fn: (prev: T | undefined) => T): void;
        delete(key: string): void;
        keys(): string[];
        has(key: string): boolean;
    };
    goals?: {
        add: (g: any) => Promise<string> | string;
        update: (id: string, patch: any) => Promise<void> | void;
        remove: (id: string) => Promise<void> | void;
        clear: (predicate?: (g: any) => boolean) => Promise<void> | void;
        read: (filter?: any) => Promise<any[]> | any[];
    };
    episodic?: {
        add: (e: any) => void;
    };
    thoughts?: {
        add: (t: {
            text: string;
        } | string) => Promise<void> | void;
    };
    semantic?: {
        add: (item: SemanticAddInput) => Promise<void> | void;
        read: (filter?: SemanticReadFilter) => Promise<SemanticItem[]> | SemanticItem[];
        remove: (idOrPredicate: string | ((item: SemanticItem) => boolean)) => Promise<void> | void;
    };
    world?: {
        update: (fn: (wm: any) => void) => void;
        patch: (p: Record<string, unknown>) => void;
    };
    decisions?: {
        add: (key: string, value: unknown, reasoning?: string) => void | Promise<void>;
        get: (key: string) => unknown | Promise<unknown>;
        read: (filter?: {
            prefix?: string;
        }) => Array<{
            key: string;
            value: unknown;
            reasoning?: string;
            ts: string;
        }> | Promise<Array<{
            key: string;
            value: unknown;
            reasoning?: string;
            ts: string;
        }>>;
        remove: (key: string) => void | Promise<void>;
        clear: () => void | Promise<void>;
    };
    recall: (query: string, options?: RecallOptions) => Promise<unknown[]>;
    remember: (key: string, value: unknown, options?: RememberOptions) => Promise<void>;
    tools: {
        invoke: <T = unknown>(toolName: string, args: unknown) => Promise<T>;
    };
    memory: IMemory & {
        mlo?: unknown;
        semantic?: unknown;
        episodic?: unknown;
        embed?: unknown;
    };
    cognitive: {
        loadWorkingMemory: (e: unknown) => void;
        plan: (prompt: string, options?: unknown) => Promise<unknown>;
        record: (state: unknown) => void;
        flush: () => Promise<void>;
    };
    logger: TaskLogger;
    config: unknown;
    validate: (schema: unknown, data: unknown) => void;
    retry: <T = unknown>(fn: () => Promise<T>, opts: unknown) => Promise<T>;
    cache: {
        get: <T = unknown>(key: string) => Promise<T | null>;
        set: <T = unknown>(key: string, value: T, ttl?: number) => Promise<void>;
        delete: (key: string) => Promise<void>;
    };
    emitEvent: (channel: string, payload: unknown) => Promise<void>;
    updateStatus: (state: string) => void;
    services: {
        get: <T = unknown>(name: string) => T | undefined;
    };
    getEnv: (key: string, defaultValue?: string) => string | undefined;
    throw: (code: string, message: string, details?: unknown) => never;
    /**
     * Request human or external input. Returns an InputHandle for durable handler chaining.
     */
    requestInput: (prompt: string, opts: {
        schema?: unknown;
        ttlMs?: number;
        onProvided: string;
        onExpired?: string;
    }) => Promise<import('../../core/orchestration/Handles.js').InputHandle>;
    /**
     * Group orchestration for running multiple child tasks and joining their results.
     */
    allTasks?: (children: Array<{
        agent: string;
        input: unknown;
    }>, opts?: {
        withTimeoutMs?: number;
        cancelRemaining?: boolean;
        onAllCompleted?: string;
        onAnyFailed?: string;
    }) => Promise<import('../../core/orchestration/Handles.js').GroupHandle>;
    /**
     * A2A: Send task to another agent with context inheritance
     * This method enables agent-to-agent communication with memory context transfer
     * @param targetAgent - Name of the target agent
     * @param taskInput - Input data for the target agent
     * @param options - A2A communication options (memory inheritance, tenant context, etc.)
     * @returns Promise resolving to task result or interactive task handle
     */
    sendTaskToAgent: (targetAgent: string, taskInput: TaskInput, options?: import('./A2ATypes.js').A2ACallOptions & {
        onCompleted?: string;
        onFailed?: string;
        onInputRequired?: string;
        streaming?: boolean;
    }) => Promise<import('./A2ATypes.js').InteractiveTaskResult | unknown>;
};
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
export type AgentTaskContext = Required<Pick<TaskContext, 'vars' | 'recall' | 'remember' | 'sendTaskToAgent'>> & TaskContext;
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
export declare function ensureAgentContext(ctx: TaskContext): AgentTaskContext;
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
export type DirectInput = {
    kind: 'input';
    token?: string;
    value: unknown;
};
/**
 * External event payload forwarded into the loop.
 */
export type ExternalEventInput = {
    kind: 'external';
    event: unknown;
};
export type InputKind = ChildCompletionInput | ToolCompletionInput | DirectInput | ExternalEventInput;
/** True if value is a child agent completion payload. */
export declare function isChildCompletionInput(x: unknown): x is ChildCompletionInput;
/** True if value is a tool completion payload. */
export declare function isToolCompletionInput(x: unknown): x is ToolCompletionInput;
/** True if value is a direct human input payload. */
export declare function isDirectInput(x: unknown): x is DirectInput;
/** True if value is an external event payload. */
export declare function isExternalEventInput(x: unknown): x is ExternalEventInput;
