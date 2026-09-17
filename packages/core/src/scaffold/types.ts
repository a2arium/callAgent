import { z } from 'zod';

const nameKebab = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const nameSnake = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;

export const AgentPresetSchema = z.enum(['minimal', 'non-trivial']);
export type AgentPreset = z.infer<typeof AgentPresetSchema>;

export const ScaffoldOptionsSchema = z
    .object({
        name: z
            .string()
            .min(1)
            .max(64)
            .refine(
                (s) => nameKebab.test(s) || nameSnake.test(s),
                'name must be kebab-case (e.g. my-agent) or snake_case (e.g. my_agent), lowercase letters, digits, single separators'
            ),
        preset: AgentPresetSchema,
        outputDir: z.string().min(1),
        description: z.string().min(1).optional(),
        usesLlm: z.boolean().optional(),
        usesTools: z.boolean().optional(),
        usesChildren: z.boolean().optional(),
        usesPlans: z.boolean().optional(),
        force: z.boolean().optional(),
        /** When true, emit workspace:* deps and tsconfig extends for monorepo packages */
        monorepo: z.boolean().optional(),
    })
    .strict();

export type ScaffoldOptions = z.infer<typeof ScaffoldOptionsSchema>;

export type ScaffoldResult = {
    outputDir: string;
    preset: AgentPreset;
    filesCreated: string[];
};

export type ScaffoldFailure =
    | { type: 'validation_failed'; issues: z.ZodIssue[] }
    | { type: 'output_exists'; path: string }
    | { type: 'write_failed'; path: string; cause: string };
