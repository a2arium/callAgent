import type { TaskContext } from '../../shared/types/index.js';
import type { TaskStatus, Artifact } from '../../shared/types/StreamingEvents.js';
import type { IWorkingMemorySessionStore } from '../memory/stores/SessionStore.js';
import type { DurableHandlerInvoker } from './DurableHandlerInvoker.js';
/**
 * Task entity with the necessary properties for the task engine
 */
export type TaskEntity = {
    id: string;
    input: unknown;
    status?: TaskStatus;
    artifacts?: Artifact[];
};
/**
 * Parameters for starting a task
 */
export type StartTaskParams = {
    task: TaskEntity;
    isStreaming: boolean;
    agentId?: string;
    tenantId?: string;
    initialContext?: TaskContext;
};
/**
 * A minimal task engine that handles task execution
 * This is a simplified implementation that would use XState in a full framework
 */
export declare class TaskEngine {
    private sessionManager?;
    private handlerInvoker?;
    constructor(opts?: {
        sessionStore?: IWorkingMemorySessionStore;
        handlerInvoker?: DurableHandlerInvoker;
    });
    persistChildContext(params: {
        tenantId: string;
        sessionId: string;
        agentId: string;
        vars?: Record<string, unknown>;
    }): Promise<void>;
    attachWorkingMemory(ctx: TaskContext, tenantId: string, sessionId: string, agentId: string): void;
    flushContextSnapshot(tenantId: string, sessionId: string, agentId: string, ctx: TaskContext): Promise<void>;
    /**
     * Start a task with either streaming or buffered mode
     * @returns The final task entity for buffered mode, or void for streaming mode
     */
    startTask(params: StartTaskParams): Promise<TaskEntity | void>;
    /**
     * Resume a task on input (scaffold): append input event and publish status via outbox.
     * Real handler dispatch will be added with durable handler registry.
     */
    resumeInput(params: {
        tenantId: string;
        taskId: string;
        token: string;
        input: unknown;
    }): Promise<{
        acknowledged: true;
    }>;
    /**
     * Handle tool completion (placeholder): removes pending tool token and invokes durable handler if present.
     */
    handleToolCompleted(params: {
        tenantId: string;
        taskId: string;
        token: string;
        result: unknown;
    }): Promise<void>;
    /**
     * Handle external event occurrence: removes pending event token and invokes durable handler if present.
     */
    handleExternalEventOccurred(params: {
        tenantId: string;
        taskId: string;
        token: string;
        payload: unknown;
    }): Promise<void>;
    /**
     * Route child completion to parent's durable handler using pending task mappings.
     * Provide either childToken (preferred correlation) or childTaskId.
     */
    handleChildCompleted(params: {
        tenantId: string;
        parentTaskId: string;
        childToken?: string;
        childTaskId?: string;
        result: unknown;
        childAgentId?: string;
    }): Promise<void>;
    /**
     * Route child input-required to parent's durable handler.
     */
    handleChildInputRequired(params: {
        tenantId: string;
        parentTaskId: string;
        childToken?: string;
        childTaskId?: string;
        prompt: string;
        schema?: unknown;
        childOnProvided?: string;
        childInputToken?: string;
    }): Promise<void>;
    /**
     * Route child failure to parent's durable handler and update group aggregations.
     */
    handleChildFailed(params: {
        tenantId: string;
        parentTaskId: string;
        childToken?: string;
        childTaskId?: string;
        error: unknown;
    }): Promise<void>;
    /**
     * Execute the task handler
     * In a real implementation, this would find and call the correct agent plugin
     */
    private executeTaskHandler;
    /**
     * Create a basic task context
     */
    private createContext;
    private restoreCtx;
}
export declare const taskEngine: TaskEngine;
