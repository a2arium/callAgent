import { createDeterministicLLMStub, createDeterministicToolStub } from '../src/testing/DeterministicStubs.js';

describe('DeterministicStubs', () => {
    describe('LLMStub', () => {
        let llm: ReturnType<typeof createDeterministicLLMStub>;

        beforeEach(() => {
            llm = createDeterministicLLMStub();
        });

        it('returns a default response when queue is empty', async () => {
            const result = await llm.call({ text: 'hi' });
            
            expect(result).toHaveLength(1);
            expect(result[0].content).toBe('default test response');
            expect(result[0].role).toBe('assistant');
        });

        it('dequeues responses in FIFO order', async () => {
            llm.enqueue('first');
            llm.enqueue({ content: 'second', role: 'user' });

            const r1 = await llm.call({ text: 'a' });
            const r2 = await llm.call({ text: 'b' });

            expect(r1[0].content).toBe('first');
            expect(r1[0].role).toBe('assistant'); // default
            
            expect(r2[0].content).toBe('second');
            expect(r2[0].role).toBe('user');
        });

        it('captures calls correctly', async () => {
            llm.enqueue('response');
            
            await llm.call({ text: 'prompt 1' }, { temperature: 0.5 });
            
            const calls = llm.getCalls();
            expect(calls).toHaveLength(1);
            expect(calls[0].message).toEqual({ text: 'prompt 1' });
            expect(calls[0].options?.temperature).toBe(0.5);
        });

        it('supports structured contentObject responses', async () => {
            llm.enqueue({ role: 'assistant', content: '', contentObject: { answer: 42 } });
            
            const res = await llm.call({ text: 'math' });
            
            expect(res[0].content).toBe('');
            expect(res[0].contentObject).toEqual({ answer: 42 });
        });

        it('supports fake streaming', async () => {
            llm.enqueueMany(['chunk 1', 'chunk 2']);
            
            const stream1 = llm.stream({ text: 'a' });
            for await (const chunk of stream1) {
                expect(chunk.content).toBe('chunk 1');
                expect(chunk.isComplete).toBe(true);
            }

            const stream2 = llm.stream({ text: 'b' });
            for await (const chunk of stream2) {
                expect(chunk.content).toBe('chunk 2');
            }
        });
    });

    describe('ToolStub', () => {
        let tools: ReturnType<typeof createDeterministicToolStub>;

        beforeEach(() => {
            tools = createDeterministicToolStub();
        });

        it('invokes registered tools', async () => {
            tools.register('weather', { temp: 72 });
            
            const res = await tools.invoke('weather', { city: 'Boston' });
            expect(res).toEqual({ temp: 72 });
        });

        it('throws descriptive error if tool is invoked without registry', async () => {
            await expect(tools.invoke('unknown', {})).rejects.toThrowError(/not registered/);
        });

        it('captures invocations', async () => {
            tools.register('test', 1);
            await tools.invoke('test', { arg: true });
            
            const calls = tools.getCalls();
            expect(calls).toHaveLength(1);
            expect(calls[0]).toEqual({ tool: 'test', args: { arg: true } });
        });
    });
});
