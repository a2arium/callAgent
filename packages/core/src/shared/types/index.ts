// src/shared/types/index.ts (Consolidated for minimal)
import type { ILLMCaller } from './LLMTypes.js';
import type { ComponentLogger } from '@a2arium/callagent-utils'; // Import ComponentLogger
// Explicitly import only needed types from StreamingEvents
import type { TaskStatus, A2AEvent, Artifact as ProtocolArtifact } from './StreamingEvents.js';

// A2A (Agent-to-Agent) Communication Types
export * from './A2ATypes.js';
import type { IMemory } from '@a2arium/callagent-types';
import type {
    EpisodicEvent,
    GoalId,
    GoalNode,
    GoalStatus,
    GoalType,
    TaskContextGoalAddInput,
    TaskContextGoalUpdatePatch,
    TaskContextGoalsReadFilter,
} from '../../loop/types.js';

// Import from memory-engine to satisfy local usage in TaskContext
import { Artifact } from '@a2arium/callagent-memory-engine';
import type {
    Artifact as ArtifactType,
    ArtifactHandle,
    LocalArtifact,
    ThoughtEntry,
    DecisionEntry,
    RecallOptions,
    RememberOptions,
    ChildCompletedObservation,
    ChildCompletedPayload,
    InteractiveTaskSnapshot,
    TaskStatusMetadataWithResult,
    TaskStatusWithResult
} from '@a2arium/callagent-memory-engine';

// Export Handle types for typed A2A interactions
export type { TaskHandle, InputHandle, GroupHandle } from '../../orchestration/Handles.js';

// Rename ProtocolArtifact to avoid conflict, but keep Artifact exporting the new type
export type { A2AEvent, TaskStatus, ProtocolArtifact };

import type { InvariantErrorCode, InvariantErrorContext, InvariantErrorDetail } from '../../types/invariantError.js';
import type { ConversationApi } from '../../public-types/conversation/types.js';


// Export the unified Artifact type and interfaces
export type {
    ArtifactType,
    ArtifactHandle,
    LocalArtifact,
    ThoughtEntry,
    DecisionEntry,
    ChildCompletedObservation,
    ChildCompletedPayload,
    InteractiveTaskSnapshot,
    TaskStatusMetadataWithResult,
    TaskStatusWithResult
};
// Export the static factory as 'Artifact'
export { Artifact };

// Re-export LLM types including the pure LLM port for modules
export type { PureLLMPort, ILLMCaller, LLMConfig } from './LLMTypes.js';

// MLO Configuration & Interface Types & Shared Types (WorkingMemory, Artifacts, A2ATypes, etc.)
export * from '@a2arium/callagent-memory-engine';

// --- Agent Types (A2A Discovery) ---
// Re-export manifest types from callagent-types for A2A compatibility
export type { AgentCard, AgentRuntimeManifest, ResolvedManifests } from '@a2arium/callagent-types';

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

    // Telemetry Context
    telemetry?: {
        nodeId?: string; // Current node ID (AgentNode or TurnNode)
        traceId?: string;
    };

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
    };

    // Namespaced helpers (minimal, ergonomic)
    goals?: {
        add: (g: TaskContextGoalAddInput) => Promise<GoalId> | GoalId;
        update: (id: GoalId, patch: TaskContextGoalUpdatePatch) => Promise<void> | void;
        remove: (id: GoalId) => Promise<void> | void;
        clear: (predicate?: (g: GoalNode) => boolean) => Promise<void> | void;
        read: (filter?: TaskContextGoalsReadFilter) => Promise<GoalNode[]> | GoalNode[];
    };
    episodic?: { add: (e: EpisodicEvent) => void };
    thoughts?: { add: (t: { text: string } | string) => Promise<void> | void };

    world?: { read: () => Readonly<Record<string, unknown>> };
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
    memory: IMemory;
    cognitive: { loadWorkingMemory: (e: unknown) => void; plan: (prompt: string, options?: unknown) => Promise<unknown>; record: (state: unknown) => void; flush: () => Promise<void>; };
    config: unknown; // Minimal config object
    validate: (schema: unknown, data: unknown) => void; // Basic validation, will throw
    retry: <T = unknown>(fn: () => Promise<T>, opts: unknown) => Promise<T>;
    cache: { get: <T = unknown>(key: string) => Promise<T | null>; set: <T = unknown>(key: string, value: T, ttl?: number) => Promise<void>; delete: (key: string) => Promise<void>; };
    emitEvent: (channel: string, payload: unknown) => Promise<void>;
    updateStatus: (state: string) => void; // Placeholder for FSM state
    services: { get: <T = unknown>(name: string) => T | undefined }; // Placeholder for service registry
    getEnv: (key: string, defaultValue?: string) => string | undefined;
    throw: (code: InvariantErrorCode, message: string, detail: InvariantErrorDetail, context?: InvariantErrorContext) => never; // Structured error throw
    conversation?: ConversationApi;

    sendTaskToAgent: {
        /**
         * Send a task to another agent.
         * @param targetAgent - Name of the target agent
         * @param taskInput - Input data for the task
         * @param options - A2A call options
         * @returns TaskHandle with .token getter when awaitCompletion=false, or the actual result when awaitCompletion=true
         */
        (
            targetAgent: string,
            taskInput: TaskInput,
            options: import('./A2ATypes.js').A2ACallOptions & { awaitCompletion: false; onCompleted?: string; onFailed?: string; onInputRequired?: string }
        ): Promise<import('../../orchestration/Handles.js').TaskHandle>;
        (
            targetAgent: string,
            taskInput: TaskInput,
            options?: import('./A2ATypes.js').A2ACallOptions & { awaitCompletion?: true; onCompleted?: string; onFailed?: string; onInputRequired?: string }
        ): Promise<import('./A2ATypes.js').InteractiveTaskResult | unknown>;
    };
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
    ) => Promise<import('../../orchestration/Handles.js').InputHandle>;

    /**
     * Request a tool to be executed asynchronously.
     * @param toolName - Name of the tool to request
     * @param args - Arguments to pass to the tool
     * @param opts - Options including awaitCompletion
     */
    requestTool: <TArgs = unknown>(
        toolName: string,
        args: TArgs,
        opts?: {
            awaitCompletion?: boolean;
            onCompleted?: string;
            onFailed?: string;
        }
    ) => Promise<import('../../orchestration/Handles.js').TaskHandle>;

    allTasks?: (
        children: Array<{ agent: string; input: unknown }>,
        opts?: { withTimeoutMs?: number; cancelRemaining?: boolean; onAllCompleted?: string; onAnyFailed?: string }
    ) => Promise<import('../../orchestration/Handles.js').GroupHandle>;
}

// --- Shared Semantic facade types ---
export type {
    SemanticAddInput,
    SemanticReadFilter,
    SemanticItem,
    SemanticRemoveFilter,
    SemanticPredicateFilter
} from '@a2arium/callagent-types';

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
function isRecord(x: unknown): x is Record<string, unknown> {
    return typeof x === 'object' && x !== null;
}

export function ensureAgentContext(ctx: TaskContext): AgentTaskContext {
    // Runtime validation to ensure all required methods are present
    const requiredMethods = ['recall', 'remember', 'sendTaskToAgent'] as const;

    for (const method of requiredMethods) {
        const fn = ctx[method];
        if (typeof fn !== 'function') {
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
    return isRecord(x) && x.kind === 'child' && typeof x.token === 'string';
}

/** True if value is a tool completion payload. */
export function isToolCompletionInput(x: unknown): x is ToolCompletionInput {
    return isRecord(x) && x.kind === 'tool' && typeof x.token === 'string';
}

/** True if value is a direct human input payload. */
export function isDirectInput(x: unknown): x is DirectInput {
    return isRecord(x) && x.kind === 'input' && 'value' in x;
}

/** True if value is an external event payload. */
export function isExternalEventInput(x: unknown): x is ExternalEventInput {
    return isRecord(x) && x.kind === 'external' && 'event' in x;
}
