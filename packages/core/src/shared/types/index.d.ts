import type { ILLMCaller } from './LLMTypes.js';
import type { TaskStatus, A2AEvent, Artifact } from './StreamingEvents.js';
import type { Usage } from './LLMTypes.js';
import type { IMemory } from '@callagent/types';
import type { ThoughtEntry, DecisionEntry, WorkingVariables } from './workingMemory.js';
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
    debug: (msg: string, ...args: unknown[]) => void;
    info: (msg: string, ...args: unknown[]) => void;
    warn: (msg: string, ...args: unknown[]) => void;
    error: (msg: string, error?: unknown, context?: Record<string, unknown>) => void;
};
export type TaskContext = {
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
    llm: ILLMCaller;
    setGoal: (goal: string) => Promise<void>;
    getGoal: () => Promise<string | null>;
    addThought: (thought: string) => Promise<void>;
    getThoughts: () => Promise<ThoughtEntry[]>;
    makeDecision: (key: string, decision: string, reasoning?: string) => Promise<void>;
    getDecision: (key: string) => Promise<DecisionEntry | null>;
    getAllDecisions: () => Promise<Record<string, DecisionEntry>>;
    vars: WorkingVariables;
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
     * A2A: Send task to another agent with context inheritance
     * This method enables agent-to-agent communication with memory context transfer
     * @param targetAgent - Name of the target agent
     * @param taskInput - Input data for the target agent
     * @param options - A2A communication options (memory inheritance, tenant context, etc.)
     * @returns Promise resolving to task result or interactive task handle
     */
    sendTaskToAgent: (targetAgent: string, taskInput: TaskInput, options?: import('./A2ATypes.js').A2ACallOptions) => Promise<import('./A2ATypes.js').InteractiveTaskResult | unknown>;
};
/**
 * Guaranteed Agent Task Context
 * This type ensures that all working memory and A2A methods are definitely available
 * Use this type for agent implementations to avoid "possibly undefined" errors
 */
export type AgentTaskContext = Required<Pick<TaskContext, 'setGoal' | 'getGoal' | 'addThought' | 'getThoughts' | 'makeDecision' | 'getDecision' | 'getAllDecisions' | 'vars' | 'recall' | 'remember' | 'sendTaskToAgent'>> & TaskContext;
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
