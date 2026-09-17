// src/shared/types/index.ts (Consolidated for minimal)
import type { ILLMCaller } from './LLMTypes.js';
import type { ComponentLogger } from '@a2arium/callagent-utils'; // Import ComponentLogger
// Explicitly import only needed types from StreamingEvents
import type { TaskStatus, A2AEvent, Artifact as ProtocolArtifact } from './StreamingEvents.js';
import type { IMemory, AgentCard, AgentRuntimeManifest, ResolvedManifests } from '@a2arium/callagent-types';
// Import working memory types for TaskContext
import type { ThoughtEntry, DecisionEntry } from './workingMemory.js';
import type { RecallOptions, RememberOptions } from './memoryLifecycle.js';
import type { GoalId, GoalNode, GoalStatus, GoalType } from '../../types/external/loop/types.js';
// Import Artifact types and the static factory
import { Artifact } from './artifacts.js';
import type { Artifact as ArtifactType, ArtifactHandle, LocalArtifact } from './artifacts.js';

// Re-export only specific streaming event types needed externally
// Rename ProtocolArtifact to avoid conflict, but keep Artifact exporting the new type
export type { A2AEvent, TaskStatus, ProtocolArtifact };

// Export the unified Artifact type and interfaces
export type { ArtifactType, ArtifactHandle, LocalArtifact };
// Export the static factory as 'Artifact'
export { Artifact };

export type { PureLLMPort, ILLMCaller, LLMConfig } from './LLMTypes.js';

// Working Memory Types
export * from './workingMemory.js';
export * from './memoryLifecycle.js';
export * from './observation.js';
export * from './artifacts.js'; // Export artifacts types

// Serialization Types (Data contracts)
export * from './SerializationTypes.js';

// MLO Configuration Types
export * from '../../lifecycle/config/index.js';

// MLO Interface Types
export * from '../../lifecycle/interfaces/index.js';

// --- Agent Types (A2A Discovery) ---
// Re-export manifest types from callagent-types for A2A compatibility
export type { AgentCard, AgentRuntimeManifest, ResolvedManifests };

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
    M?: Readonly<import('../../types/external/loop/types.js').MentalState>;
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

    // Artifacts factory for offloading large data
    artifacts: {
        /**
         * Create an artifact handle and offload the value to storage.
         * @param val - The data to offload
         * @param options - Metadata options (mimeType, preview)
         */
        create<T>(val?: T, options?: { mimeType?: string; preview?: string }): ArtifactType<T>;

        /**
         * Helper to create a text artifact.
         */
        text(val?: string): ArtifactType<string>;

        /**
         * Helper to create a JSON artifact.
         */
        json<T>(val?: T): ArtifactType<T>;

        retain(artifact: ArtifactHandle<unknown>, ownerId: string): Promise<void>;
        retainMany(artifacts: readonly ArtifactHandle<unknown>[], ownerId: string): Promise<void>;
        retainIds(artifactIds: readonly string[], ownerId: string): Promise<void>;
        inheritOwner(fromOwnerId: string, toOwnerId: string, excludedArtifactIds?: readonly string[]): Promise<readonly string[]>;
        release(artifactId: string, ownerId: string): Promise<void>;
        releaseOwner(ownerId: string): Promise<number>;
        delete(artifactId: string): Promise<boolean>;
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
    sendTaskToAgent: (
        targetAgent: string,
        taskInput: TaskInput,
        options?: any
    ) => Promise<unknown>;
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
    ) => Promise<import('../../types/external/orchestration/Handles.js').InputHandle>;
    allTasks?: (
        children: Array<{ agent: string; input: unknown }>,
        opts?: { withTimeoutMs?: number; cancelRemaining?: boolean; onAllCompleted?: string; onAnyFailed?: string }
    ) => Promise<import('../../types/external/orchestration/Handles.js').GroupHandle>;
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
    'recall' | 'remember' | 'sendTaskToAgent' | 'artifacts'
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

    if (!ctx.artifacts || typeof ctx.artifacts !== 'object') {
        throw new Error('Agent context is missing required artifacts factory. Ensure the agent is run through the proper runner with memory support.');
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
