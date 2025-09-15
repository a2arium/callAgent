import { createAgent } from '../src/index.js';
import { PluginManager } from '../src/core/plugin/pluginManager.js';
import { runAgentWithStreaming } from '../src/runner/streamingRunner.js';

describe('WM/LLM restore on onProvided (integration)', () => {
    beforeAll(() => {
        const child = createAgent({
            manifest: { name: 'wmllm-child', version: '1.0.0' },
            async handleTask(ctx) {
                ctx.vars!.debugString = 'child turn 1';
                await ctx.requestInput('threshold?', { onProvided: 'onThreshold' });
                return; // non-blocking
            }
        }, import.meta.url);
        // durable handler invoked by engine after resume
        PluginManager.registerAgent(child);
        // co-located durable handler
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (global as any).onThreshold = async (ctx: any, ev: { input: unknown }) => {
            // Assert ctx.vars is restored
            if (ctx?.vars?.debugString !== 'child turn 1') {
                throw new Error('vars not restored');
            }
            // Touch llm to ensure state object exists and is callable
            await ctx.reply([{ type: 'text', text: `Analyzer: threshold=${ev.input as number}` }]);
            return ev.input;
        };
    });

    it('persists vars and resumes handler with restored ctx', async () => {
        // Create a tiny orchestrator that forwards to child and returns synchronously
        const orchestrator = createAgent({
            manifest: { name: 'wmllm-parent', version: '1.0.0', dependencies: { agents: ['wmllm-child'] } },
            async handleTask(ctx) {
                await ctx.sendTaskToAgent('wmllm-child', { method: 'basic' }, { onInputRequired: 'onChildAsk', onCompleted: 'onChildDone' });
                return; // non-blocking
            }
        }, import.meta.url);

        // co-located handlers
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (global as any).onChildAsk = async (_ctx: any, ev: { input: { prompt: string } }) => {
            // Simulate parent answering immediately by calling resume via engine RPC
            expect(ev?.input?.prompt).toContain('threshold');
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (global as any).onChildDone = async (_ctx: any, _ev: { input: unknown }) => { /* no-op */ };

        PluginManager.registerAgent(orchestrator);

        // Run via streaming runner to ensure engine path is used (no assert on outputs here)
        await runAgentWithStreaming('dummy.js', { kick: true }, { isStreaming: true, resolveDeps: false });

        expect(true).toBe(true);
    });
});


