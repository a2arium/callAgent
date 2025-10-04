import type { Request, Response } from 'express';
/**
 * Handler for the tasks/input method (idempotent)
 * Accepts an opaque input token and optional Idempotency-Key
 */
export declare function handleTasksInput(req: Request, res: Response): Promise<void>;
