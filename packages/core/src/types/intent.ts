import { z } from 'zod';

export const IntentSchema = z.discriminatedUnion('kind', [
    // User interaction
    z.object({ kind: z.literal('prompt_user'), prompt: z.string(), schema: z.unknown().optional() }),
    z.object({ kind: z.literal('answer_with_llm'), query: z.string(), contextKey: z.string().optional() }),

    // Tools / children
    z.object({ kind: z.literal('call_tool'), toolName: z.string(), args: z.record(z.string(), z.unknown()).optional(), mode: z.enum(['sync', 'async']).optional() }),
    z.object({ kind: z.literal('delegate_to_child'), agentId: z.string(), input: z.unknown() }),

    // Planning
    z.object({ kind: z.literal('create_plan'), goalId: z.string() }),
    z.object({ kind: z.literal('execute_next_step'), planId: z.string() }),
    z.object({ kind: z.literal('repair_plan'), planId: z.string(), reason: z.string() }),

    // Terminal / idle
    z.object({ kind: z.literal('complete'), result: z.unknown().optional() }),
    z.object({ kind: z.literal('wait') }),
    
    // Internal (for testing or advanced control flow)
    z.object({ kind: z.literal('internal'), intent: z.string(), data: z.unknown().optional() })
]);

export type Intent = z.infer<typeof IntentSchema>;

export const ExecutableActionSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('prompt_user'), token: z.string() }),
    z.object({ kind: z.literal('delegate_to_child'), token: z.string().optional() }),
    z.object({ kind: z.literal('call_tool'), token: z.string().optional() }),
    z.object({ kind: z.literal('answer_with_llm'), echoed: z.boolean() }),
    z.object({ kind: z.literal('internal'), done: z.boolean() })
]);

export type ExecutableAction = z.infer<typeof ExecutableActionSchema>;
