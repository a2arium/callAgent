import { z, type ZodType } from 'zod';

export const MAX_LLM_TIMEOUT_MS = 2_147_483_647;

function isAbortSignal(value: unknown): value is AbortSignal {
    if (value === null || typeof value !== 'object') return false;
    const candidate = value as Partial<AbortSignal>;
    return typeof candidate.aborted === 'boolean'
        && typeof candidate.addEventListener === 'function'
        && typeof candidate.removeEventListener === 'function';
}

export const LLMOutputContractSchema = z.object({
    name: z.string().min(1),
    schema: z.union([
        z.instanceof(z.ZodType),
        z.record(z.string(), z.unknown()),
    ]),
});

export type LLMOutputContract = {
    name: string;
    schema: ZodType | Record<string, unknown>;
};

export const LLMSettingsSchema = z.object({
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().positive().optional(),
    topP: z.number().min(0).max(1).optional(),
    seed: z.number().int().optional(),
    stop: z.union([z.string(), z.array(z.string())]).optional(),
}).passthrough();

export type LLMSettings = z.infer<typeof LLMSettingsSchema>;

export const LLMCallOptionsSchema = LLMSettingsSchema.pick({
    temperature: true,
    seed: true,
}).extend({
    signal: z.custom<AbortSignal>(isAbortSignal, {
        message: 'signal must be an AbortSignal',
    }).optional(),
    timeoutMs: z.number().int().min(1).max(MAX_LLM_TIMEOUT_MS).optional(),
    data: z.unknown().optional(),
    jsonSchema: LLMOutputContractSchema.optional(),
    schema: z.union([
        z.instanceof(z.ZodType),
        z.record(z.string(), z.unknown()),
    ]).optional(),
    telemetryNodeId: z.string().optional(),
}).passthrough();

export type LLMCallOptions = z.infer<typeof LLMCallOptionsSchema>;
