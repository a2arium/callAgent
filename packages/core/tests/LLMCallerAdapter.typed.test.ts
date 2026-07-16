import { describe, expect, it } from '@jest/globals';
import type { LLMCallOptions } from '../src/types/llmContracts.js';
import { LLMCallerAdapter } from '../src/llm/LLMCallerAdapter.js';

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
});
