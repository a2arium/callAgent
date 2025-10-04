import type { Request, Response } from 'express';
import type { IWorkingMemorySessionStore } from '../../core/memory/stores/SessionStore.js';
/**
 * Handles Server-Sent Events (SSE) streaming for a task
 * @param req - The request object
 * @param res - The response object to stream events to
 * @param taskId - The ID of the task to stream events for
 */
export declare function handleSSE(req: Request, res: Response, taskId: string, store?: IWorkingMemorySessionStore, tenantId?: string): Promise<void>;
