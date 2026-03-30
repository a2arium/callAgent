import { z, type ZodType } from 'zod';

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
    data: z.unknown().optional(),
    jsonSchema: LLMOutputContractSchema.optional(),
    schema: z.union([
        z.instanceof(z.ZodType),
        z.record(z.string(), z.unknown()),
    ]).optional(),
    telemetryNodeId: z.string().optional(),
}).passthrough();

export type LLMCallOptions = z.infer<typeof LLMCallOptionsSchema>;
