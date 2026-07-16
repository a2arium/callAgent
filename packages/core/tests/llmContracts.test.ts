import { describe, it, expect } from '@jest/globals';
import { z } from 'zod';
import {
    LLMCallOptionsSchema,
    LLMOutputContractSchema,
    LLMSettingsSchema,
    MAX_LLM_TIMEOUT_MS,
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
        const controller = new AbortController();
        const parsed = LLMCallOptionsSchema.parse({
            temperature: 0.5,
            seed: 10,
            signal: controller.signal,
            timeoutMs: 60_000,
            telemetryNodeId: 'node-1',
            extraProviderField: 'ok',
        });
        expect(parsed.temperature).toBe(0.5);
        expect(parsed.seed).toBe(10);
        expect(parsed.signal).toBe(controller.signal);
        expect(parsed.timeoutMs).toBe(60_000);
        expect(parsed.telemetryNodeId).toBe('node-1');
        expect(parsed.extraProviderField).toBe('ok');
    });

    it.each([0, -1, 1.5, Number.POSITIVE_INFINITY, Number.NaN, MAX_LLM_TIMEOUT_MS + 1])(
        'rejects invalid timeoutMs %p',
        (timeoutMs) => {
            expect(LLMCallOptionsSchema.safeParse({ timeoutMs }).success).toBe(false);
        },
    );

    it('rejects non-AbortSignal signal values', () => {
        expect(LLMCallOptionsSchema.safeParse({ signal: {} }).success).toBe(false);
    });
});
