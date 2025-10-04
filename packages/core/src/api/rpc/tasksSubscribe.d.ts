import type { Request, Response } from 'express';
/**
 * Handler for the tasks/sendSubscribe method
 * This opens a streaming response using SSE
 */
export declare function handleTasksSubscribe(req: Request, res: Response): Promise<void>;
