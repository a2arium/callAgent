import { IntentSchema } from '../src/types/intent.js';

describe('IntentSchema validation', () => {
    it('validates a prompt_user intent', () => {
        const intent = { kind: 'prompt_user', prompt: 'Hello', schema: { type: 'string' } };
        expect(IntentSchema.parse(intent)).toEqual(intent);
    });

    it('validates a call_tool intent', () => {
        const intent = { kind: 'call_tool', toolName: 'fetch', args: { url: 'https://example.com' }, mode: 'async' };
        expect(IntentSchema.parse(intent)).toEqual(intent);
    });

    it('validates a delegate_to_child intent', () => {
        const intent = { kind: 'delegate_to_child', agentId: 'data-analyzer', input: { query: 'test' } };
        expect(IntentSchema.parse(intent)).toEqual(intent);
    });

    it('validates an answer_with_llm intent', () => {
        const intent = { kind: 'answer_with_llm', query: 'What is the capital of France?' };
        expect(IntentSchema.parse(intent)).toEqual(intent);
    });

    it('rejects an invalid intent kind', () => {
        const intent = { kind: 'invalid_kind' };
        expect(() => IntentSchema.parse(intent)).toThrow();
    });

    it('rejects a missing required field', () => {
        // call_tool requires toolName
        const intent = { kind: 'call_tool', args: {} };
        expect(() => IntentSchema.parse(intent)).toThrow();
    });
});
