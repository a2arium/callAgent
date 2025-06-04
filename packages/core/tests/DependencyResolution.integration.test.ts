import { PluginManager } from '../src/core/plugin/pluginManager.js';
import { globalAgentRegistry } from '../src/core/plugin/AgentRegistry.js';
import { AgentDependencyResolver } from '../src/core/plugin/dependencies/AgentDependencyResolver.js';
import { createAgent } from '../src/index.js';

describe('Dependency Resolution Integration Tests', () => {
    beforeEach(() => {
        // Clear any existing agents using the same pattern as other tests
        const registry = globalAgentRegistry as any;
        registry.agents.clear();
        registry.aliases.clear();
    });

    describe('Real Example Dependencies', () => {
        it('should resolve dependencies for hello-to-llm demo', async () => {
            // Register hello-agent first (dependency)
            const helloAgent = createAgent({
                manifest: {
                    name: 'hello-agent',
                    version: '1.0.0',
                    description: 'Simple hello agent'
                },
                async handleTask(ctx) {
                    const name = (ctx.task.input as any)?.name || 'World';
                    await ctx.reply(`Hello, ${name}!`);
                    return { success: true, greeting: `Hello, ${name}!` };
                }
            }, import.meta.url);

            PluginManager.registerAgent(helloAgent);

            // Register hello-to-llm agent (depends on hello-agent)
            const helloToLLMAgent = createAgent({
                manifest: {
                    name: 'hello-to-llm-agent',
                    version: '1.0.0',
                    description: 'Demonstrates A2A communication via dependencies',
                    dependencies: {
                        agents: ['hello-agent']
                    }
                },
                async handleTask(ctx) {
                    await ctx.reply('🤝 Hello-to-LLM Demo Starting...');

                    ctx.progress(20, 'Calling hello-agent via A2A');

                    const result = await ctx.sendTaskToAgent('hello-agent', {
                        name: 'A2A Demo User'
                    });

                    ctx.progress(80, 'Hello-agent response received');

                    await ctx.reply(['✅ Hello-agent Response:', JSON.stringify(result, null, 2)]);

                    return { demoCompleted: true, helloResponse: result };
                }
            }, import.meta.url);

            PluginManager.registerAgent(helloToLLMAgent);

            // Test dependency resolution
            const result = await AgentDependencyResolver.resolveDependencies('hello-to-llm-agent');

            expect(result.loadingOrder).toEqual(['hello-agent', 'hello-to-llm-agent']);
            expect(result.allAgents).toContain('hello-to-llm-agent');
            expect(result.allAgents).toContain('hello-agent');
            expect(result.warnings).toEqual([]);
        });

        it('should handle missing dependencies gracefully', async () => {
            // Register an agent with a missing dependency
            const problematicAgent = createAgent({
                manifest: {
                    name: 'problematic-agent',
                    version: '1.0.0',
                    dependencies: {
                        agents: ['missing-agent']
                    }
                },
                async handleTask(ctx) {
                    return { status: 'should not reach here' };
                }
            }, import.meta.url);

            PluginManager.registerAgent(problematicAgent);

            // Test that missing dependencies are detected
            await expect(AgentDependencyResolver.resolveDependencies('problematic-agent'))
                .rejects.toThrow(/Manifest file not found for agent 'missing-agent'/);
        });

        it('should handle circular dependencies', async () => {
            // Create agents with circular dependencies
            const agentA = createAgent({
                manifest: {
                    name: 'agent-a',
                    version: '1.0.0',
                    dependencies: { agents: ['agent-b'] }
                },
                async handleTask() { return {}; }
            }, import.meta.url);

            const agentB = createAgent({
                manifest: {
                    name: 'agent-b',
                    version: '1.0.0',
                    dependencies: { agents: ['agent-a'] }
                },
                async handleTask() { return {}; }
            }, import.meta.url);

            PluginManager.registerAgent(agentA);
            PluginManager.registerAgent(agentB);

            await expect(AgentDependencyResolver.resolveDependencies('agent-a'))
                .rejects.toThrow(/Circular dependency detected/);
        });
    });

    describe('Complex Dependency Chains', () => {
        it('should handle multi-level dependencies', async () => {
            // Create a chain: coordinator -> data-analyzer -> data-fetcher
            const dataFetcher = createAgent({
                manifest: {
                    name: 'data-fetcher',
                    version: '1.0.0'
                },
                async handleTask(ctx) {
                    return { data: ['item1', 'item2', 'item3'] };
                }
            }, import.meta.url);

            const dataAnalyzer = createAgent({
                manifest: {
                    name: 'data-analyzer',
                    version: '1.0.0',
                    dependencies: { agents: ['data-fetcher'] }
                },
                async handleTask(ctx) {
                    const fetchResult = await ctx.sendTaskToAgent('data-fetcher', {}) as any;
                    return {
                        analysis: `Analyzed ${fetchResult.data.length} items`,
                        raw_data: fetchResult
                    };
                }
            }, import.meta.url);

            const coordinator = createAgent({
                manifest: {
                    name: 'coordinator',
                    version: '1.0.0',
                    dependencies: { agents: ['data-analyzer'] }
                },
                async handleTask(ctx) {
                    const analysisResult = await ctx.sendTaskToAgent('data-analyzer', {}) as any;
                    return {
                        final_report: `Coordination complete: ${analysisResult.analysis}`,
                        details: analysisResult
                    };
                }
            }, import.meta.url);

            PluginManager.registerAgent(dataFetcher);
            PluginManager.registerAgent(dataAnalyzer);
            PluginManager.registerAgent(coordinator);

            // Test dependency resolution
            const result = await AgentDependencyResolver.resolveDependencies('coordinator');

            // Should resolve in dependency order: data-fetcher, data-analyzer, coordinator
            expect(result.loadingOrder).toEqual(['data-fetcher', 'data-analyzer', 'coordinator']);
            expect(result.allAgents).toHaveLength(3);
        });

        it('should handle diamond dependency pattern', async () => {
            // Create diamond pattern: A -> B, A -> C, B -> D, C -> D
            const baseService = createAgent({
                manifest: { name: 'base-service', version: '1.0.0' },
                async handleTask() { return { base: 'data' }; }
            }, import.meta.url);

            const serviceB = createAgent({
                manifest: {
                    name: 'service-b',
                    version: '1.0.0',
                    dependencies: { agents: ['base-service'] }
                },
                async handleTask(ctx) {
                    const base = await ctx.sendTaskToAgent('base-service', {});
                    return { b_result: base, from: 'B' };
                }
            }, import.meta.url);

            const serviceC = createAgent({
                manifest: {
                    name: 'service-c',
                    version: '1.0.0',
                    dependencies: { agents: ['base-service'] }
                },
                async handleTask(ctx) {
                    const base = await ctx.sendTaskToAgent('base-service', {});
                    return { c_result: base, from: 'C' };
                }
            }, import.meta.url);

            const orchestrator = createAgent({
                manifest: {
                    name: 'orchestrator',
                    version: '1.0.0',
                    dependencies: { agents: ['service-b', 'service-c'] }
                },
                async handleTask(ctx) {
                    const [bResult, cResult] = await Promise.all([
                        ctx.sendTaskToAgent('service-b', {}),
                        ctx.sendTaskToAgent('service-c', {})
                    ]);
                    return { combined: { b: bResult, c: cResult } };
                }
            }, import.meta.url);

            PluginManager.registerAgent(baseService);
            PluginManager.registerAgent(serviceB);
            PluginManager.registerAgent(serviceC);
            PluginManager.registerAgent(orchestrator);

            const result = await AgentDependencyResolver.resolveDependencies('orchestrator');

            // base-service should be loaded first, then B and C, then orchestrator
            expect(result.loadingOrder[0]).toBe('base-service');
            expect(result.loadingOrder).toContain('service-b');
            expect(result.loadingOrder).toContain('service-c');
            expect(result.loadingOrder[result.loadingOrder.length - 1]).toBe('orchestrator');
            expect(result.allAgents).toHaveLength(4);
        });
    });

    describe('PluginManager Integration', () => {
        it('should load agent with dependencies using PluginManager', async () => {
            // Register agents first
            const baseAgent = createAgent({
                manifest: { name: 'base-agent', version: '1.0.0' },
                async handleTask() { return { base: 'loaded' }; }
            }, import.meta.url);

            const dependentAgent = createAgent({
                manifest: {
                    name: 'dependent-agent',
                    version: '1.0.0',
                    dependencies: { agents: ['base-agent'] }
                },
                async handleTask() { return { dependent: 'loaded' }; }
            }, import.meta.url);

            PluginManager.registerAgent(baseAgent);
            PluginManager.registerAgent(dependentAgent);

            // Test PluginManager.loadAgentWithDependencies
            const loadedAgents = await PluginManager.loadAgentWithDependencies('dependent-agent');

            expect(loadedAgents).toHaveLength(2);
            expect(loadedAgents[0].manifest.name).toBe('base-agent');
            expect(loadedAgents[1].manifest.name).toBe('dependent-agent');
        });

        it('should handle inline manifests in dependency resolution', async () => {
            // Register an agent with inline manifest
            const inlineAgent = createAgent({
                manifest: {
                    name: 'inline-agent',
                    version: '1.0.0',
                    description: 'Agent with inline manifest',
                    dependencies: { agents: ['hello-agent'] }
                },
                async handleTask() { return { inline: true }; }
            }, import.meta.url);

            const helloAgent = createAgent({
                manifest: { name: 'hello-agent', version: '1.0.0' },
                async handleTask() { return { hello: true }; }
            }, import.meta.url);

            PluginManager.registerAgent(helloAgent);
            PluginManager.registerAgent(inlineAgent);

            // Test that inline manifests work with dependency resolution
            const result = await AgentDependencyResolver.resolveDependencies('inline-agent');

            expect(result.loadingOrder).toEqual(['hello-agent', 'inline-agent']);
            expect(result.allAgents).toContain('inline-agent');
            expect(result.allAgents).toContain('hello-agent');
        });
    });
}); 