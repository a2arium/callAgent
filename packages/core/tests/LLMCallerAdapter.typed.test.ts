import { describe, expect, it, jest } from '@jest/globals';
import type { LLMCallOptions } from '../src/types/llmContracts.js';
import { LLMCallerAdapter } from '../src/llm/LLMCallerAdapter.js';
import { z } from 'zod';

describe('LLMCallerAdapter typing surface', () => {
    it('constructs and accepts typed updateSettings', () => {
        const adapter = new LLMCallerAdapter({
            provider: 'openai',
            modelAliasOrName: 'gpt-4o-mini',
            systemPrompt: 'test',
            historyMode: 'stateless',
        });

        adapter.updateSettings({ temperature: 0.4, seed: 5, maxTokens: 50 });
        expect(adapter).toBeDefined();
    });

    it('typed options shape is assignable', () => {
        const controller = new AbortController();
        const options: LLMCallOptions = {
            temperature: 0,
            seed: 1,
            signal: controller.signal,
            timeoutMs: 100,
            telemetryNodeId: 'node',
            jsonSchema: { name: 'shape', schema: { type: 'object' } },
        };
        expect(options.telemetryNodeId).toBe('node');
        expect(options.signal).toBe(controller.signal);
        expect(options.timeoutMs).toBe(100);
    });

    it('passes a Zod output contract to CallLLM unchanged', async () => {
        const schema = z.object({ answer: z.string() });
        const adapter = new LLMCallerAdapter({ provider: 'openai', modelAliasOrName: 'gpt-test' });
        const call = jest.fn(async () => []);
        Object.assign(adapter as unknown as { caller: { call: typeof call } }, { caller: { call } });

        await adapter.call('test', { jsonSchema: { name: 'Answer', schema } });

        expect(call).toHaveBeenCalledWith(expect.objectContaining({ jsonSchema: { name: 'Answer', schema } }));
    });

    it('serializes a legacy JSON-schema object for CallLLM', async () => {
        const adapter = new LLMCallerAdapter({ provider: 'openai', modelAliasOrName: 'gpt-test' });
        const call = jest.fn(async () => []);
        Object.assign(adapter as unknown as { caller: { call: typeof call } }, { caller: { call } });

        await adapter.call('test', { jsonSchema: { name: 'Answer', schema: { type: 'object' } } });

        expect(call).toHaveBeenCalledWith(expect.objectContaining({
            jsonSchema: { name: 'Answer', schema: JSON.stringify({ type: 'object' }) },
        }));
    });
});
