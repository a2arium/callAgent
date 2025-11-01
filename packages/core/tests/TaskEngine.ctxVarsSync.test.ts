import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { TaskEngine, type TaskEntity } from '../src/core/orchestration/taskEngine.js';
import { createAgent } from '../src/index.js';
import { globalAgentRegistry } from '../src/core/plugin/AgentRegistry.js';

describe('TaskEngine ctx.vars + MentalState synchronization', () => {
    beforeEach(() => {
        const registry = globalAgentRegistry as unknown as { agents: Map<string, unknown>; aliases: Map<string, string> };
        registry.agents.clear();
        registry.aliases.clear();
    });

    afterEach(() => {
        const registry = globalAgentRegistry as unknown as { agents: Map<string, unknown>; aliases: Map<string, string> };
        registry.agents.clear();
        registry.aliases.clear();
    });

    it('propagates ctx.vars writes from execution to the next turn mental state', async () => {
        const seenSelectors: Array<unknown> = [];

        createAgent({
            manifest: { name: 'ctx-vars-sync-agent', version: '1.0.0', runMode: 'loop' },
            loop: {
                modules: {
                    attention: (prev) => {
                        const selectors = (prev.memory?.vars as Record<string, unknown> | undefined)?.selectors;
                        seenSelectors.push(selectors);
                        return null;
                    },
                    perception: () => ({}),
                    learning: (prev) => prev,
                    policy: () => ({ kind: 'internal', intent: 'noop' } as const),
                    shield: (_m, intent) => ({ action: 'pass', intent } as const),
                    execution: async (_action, ctx) => {
                        if (seenSelectors.length === 1) {
                            ctx.vars.set('selectors', 'from-execution');
                        }
                        return { kind: 'internal', done: true } as const;
                    },
                    transition: () => (seenSelectors.length >= 2
                        ? { kind: 'complete', result: { ok: true } } as const
                        : { kind: 'continue' } as const)
                }
            },
            async handleTask() { /* noop */ }
        }, import.meta.url);

        const engine = new TaskEngine();
        const task: TaskEntity = { id: 'task-vars-sync', input: {}, agentId: 'ctx-vars-sync-agent' };

        await engine.startTask({
            task,
            tenantId: 'tenant-sync',
            agentId: 'ctx-vars-sync-agent',
            isStreaming: false
        });

        expect(seenSelectors).toEqual([undefined, 'from-execution']);
    });
});


