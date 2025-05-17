// src/shared/types/index.ts (Consolidated for minimal)
import type { ILLMCaller } from './LLMTypes.js';
import type { ComponentLogger } from '../../utils/logger.js'; // Import ComponentLogger
// Explicitly import only needed types from StreamingEvents
import type { TaskStatus, A2AEvent, Artifact } from './StreamingEvents.js';
import type { Usage } from './LLMTypes.js'; // Import Usage type
import type { IMemory } from '@callagent/types';

// Re-export only specific streaming event types needed externally
export type { A2AEvent, TaskStatus, Artifact };

// --- Agent Card (Minimal) ---
export type AgentManifest = {
    name: string;
    version: string;
    // Future: capabilities, endpoint, auth, plugins, tools, etc.
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

    // Future Capabilities (Stubbed/Placeholder - DO NOT USE in minimal agent logic)
    tools: { invoke: <T = unknown>(toolName: string, args: unknown) => Promise<T> };
    memory: IMemory;
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
} 