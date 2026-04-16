import { z } from 'zod';

/** Placeholder LLM output contract for non-trivial scaffolded agents. */
export const LlmOutputSchema = z.object({
    ok: z.boolean(),
});
