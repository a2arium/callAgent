import { describe, it, expect } from '@jest/globals';
import { z } from 'zod';
import {
    LLMCallOptionsSchema,
    LLMOutputContractSchema,
    LLMSettingsSchema,
} from '../src/types/llmContracts.js';

describe('llmContracts schemas', () => {
    it('parses valid output contract with zod schema', () => {
        const parsed = LLMOutputContractSchema.parse({
            name: 'MySchema',
            schema: z.object({ ok: z.boolean() }),
        });
        expect(parsed.name).toBe('MySchema');
    });

    it('rejects invalid output contract schema payload', () => {
        const parsed = LLMOutputContractSchema.safeParse({
            name: 'BadSchema',
            schema: 42,
        });
        expect(parsed.success).toBe(false);
    });

    it('allows passthrough settings fields', () => {
        const parsed = LLMSettingsSchema.parse({
            temperature: 0.2,
            providerSpecificFlag: true,
        });
        expect(parsed.providerSpecificFlag).toBe(true);
    });

    it('composes LLMCallOptions from settings fields', () => {
        const parsed = LLMCallOptionsSchema.parse({
            temperature: 0.5,
            seed: 10,
            telemetryNodeId: 'node-1',
            extraProviderField: 'ok',
        });
        expect(parsed.temperature).toBe(0.5);
        expect(parsed.seed).toBe(10);
        expect(parsed.telemetryNodeId).toBe('node-1');
        expect(parsed.extraProviderField).toBe('ok');
    });
});
