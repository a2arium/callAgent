import type { ILLMCaller } from './LLMTypes.js';
import type { TaskStatus, A2AEvent, Artifact } from './StreamingEvents.js';
import type { Usage } from './LLMTypes.js';
import type { IMemory } from '@callagent/types';
export type { A2AEvent, TaskStatus, Artifact };
export type AgentManifest = {
    name: string;
    version: string;
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
    tools: {
        invoke: <T = unknown>(toolName: string, args: unknown) => Promise<T>;
    };
    memory: IMemory;
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
};
