import type { Request, Response } from 'express';
/**
 * Handler for the tasks/resubscribe method
 * Allows clients to reconnect to an existing task's event stream
 */
export declare function handleTasksResubscribe(req: Request, res: Response): Promise<void>;
