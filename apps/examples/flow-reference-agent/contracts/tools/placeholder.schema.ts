import { z } from 'zod';

/** Placeholder tool contract for non-trivial scaffolded agents. */
export const ToolResultSchema = z.object({
    ok: z.boolean(),
});
