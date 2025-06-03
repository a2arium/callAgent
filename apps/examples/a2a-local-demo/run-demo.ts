import { loadConfig } from '@callagent/core/dist/config/index.js';
import { PluginManager } from '@callagent/core';
import { logger } from '@callagent/utils';
import { extendContextWithStreaming } from '@callagent/core/dist/core/context/StreamingContext.js';
import { getMemoryAdapter } from '@callagent/core/dist/core/memory/factory.js';
import { extendContextWithMemory } from '@callagent/core/dist/core/memory/types/working/context/workingMemoryContext.js';
import { resolveTenantId } from '@callagent/core/dist/core/plugin/tenantResolver.js';
import { globalA2AService } from '@callagent/core/dist/core/orchestration/A2AService.js';
import { AgentError } from '@callagent/core/dist/utils/errors.js';
import type { TaskContext, TaskInput, MessagePart } from '@callagent/core/dist/shared/types/index.js';
import type { TaskStatus } from '@callagent/core/dist/shared/types/StreamingEvents.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Create demo logger
const demoLogger = logger.createLogger({ prefix: 'A2ADemo' });

async function runA2ADemo() {
    console.log('🚀 Starting A2A Local Demo with True Agent-to-Agent Communication');
    console.log('📋 Loading all agents into the same process...');

    // Load all agent modules to register them in the same process
    const agentFiles = [
        path.join(__dirname, 'CoordinatorAgent.js'),
        path.join(__dirname, 'DataAnalysisAgent.js'),
        path.join(__dirname, 'ReportingAgent.js')
    ];

    // Import all agents to register them
    for (const agentFile of agentFiles) {
        try {
            console.log(`📦 Loading ${path.basename(agentFile)}...`);
            await import(agentFile);
            console.log(`✅ Loaded ${path.basename(agentFile)}`);
        } catch (error) {
            console.error(`❌ Failed to load ${agentFile}:`, error);
            process.exit(1);
        }
    }

    // List registered agents from the unified registry (createAgent now uses PluginManager)
    const registeredAgents = PluginManager.listAgents();
    console.log(`\n🎯 Registered Agents (${registeredAgents.length}):`);
    registeredAgents.forEach((agent: any) => {
        console.log(`  - ${agent.name} (v${agent.version})`);
    });

    if (registeredAgents.length === 0) {
        console.error('❌ No agents registered! Cannot proceed with demo.');
        process.exit(1);
    }

    // Find the coordinator agent
    const coordinatorAgent: any = PluginManager.findAgent('coordinator-agent');

    if (!coordinatorAgent) {
        console.error('❌ Coordinator agent not found! Available agents:',
            registeredAgents.map((a: any) => a.name).join(', '));
        process.exit(1);
    }

    console.log('\n🎬 Starting Coordinator Agent with A2A Support...\n');

    // Create a custom task context for the coordinator
    const config = loadConfig();
    const taskId = `a2a-demo-${Date.now()}`;
    const tenantId = resolveTenantId();
    const agentName = coordinatorAgent.manifest.name;

    // Create agent logger
    const agentLogger = demoLogger.createLogger({ prefix: agentName });

    // Get memory adapter
    const memoryAdapter = await getMemoryAdapter(tenantId);
    const semanticAdapter = memoryAdapter.semantic.backends[config.memory.semantic.default];

    // Create basic task context
    const partialCtx = {
        tenantId,
        agentId: agentName,
        task: {
            id: taskId,
            input: { requestedBy: 'CEO', priority: 'high' } as TaskInput,
        },
        reply: async (parts: string | string[] | MessagePart | MessagePart[]) => {
            // Convert to MessagePart array
            const messageParts = Array.isArray(parts)
                ? parts.map(p => typeof p === 'string' ? { type: 'text' as const, text: p } : p)
                : [typeof parts === 'string' ? { type: 'text' as const, text: parts } : parts];

            // Print each part
            messageParts.forEach(part => {
                if (part.type === 'text') {
                    console.log(part.text);
                }
            });
        },
        progress: (pctOrStatus: number | TaskStatus, msg?: string) => {
            if (typeof pctOrStatus === 'number') {
                console.log(`Progress: ${pctOrStatus}%${msg ? `: ${msg}` : ''}`);
            } else {
                console.log(`Status: ${pctOrStatus.state}`);
            }
        },
        complete: (pct?: number, status?: string) => {
            console.log(`✅ Complete: ${status || 'completed'} at ${pct ?? 100}%`);
        },
        llm: coordinatorAgent.llmAdapter || {
            async call(message: string, options?: Record<string, any>) {
                agentLogger.warn(`llm.call is stubbed`, { message, options });
                return [{ content: "Stubbed LLM response", role: "assistant" }];
            },
            async *stream(message: string, options?: Record<string, any>) {
                agentLogger.warn(`llm.stream is stubbed`, { message, options });
                yield { content: "Stubbed LLM response", role: "assistant", isComplete: true };
            },
            addToolResult: () => { },
            updateSettings: () => { }
        },
        tools: {
            invoke: async (toolName: string, args: unknown) => {
                agentLogger.warn(`tools.invoke is stubbed`, { toolName, args });
                return { success: true, output: "Stubbed tool result" };
            }
        },
        logger: agentLogger,
        cognitive: {
            loadWorkingMemory: () => { },
            plan: async () => ({ steps: [] }),
            record: () => { },
            flush: async () => { }
        },
        config,
        validate: () => { },
        retry: async (fn: () => Promise<any>) => fn(),
        cache: {
            get: async () => null,
            set: async () => { },
            delete: async () => { }
        },
        emitEvent: async () => { },
        updateStatus: (state: string) => console.log(`Status: ${state}`),
        services: { get: () => undefined },
        getEnv: (key: string, defaultValue?: string) => process.env[key] ?? defaultValue,
        throw: (code: string, message: string, details?: unknown) => {
            agentLogger.error(`Agent error: [${code}] ${message}`, null, { details });
            throw new AgentError(message, agentName, { code, details });
        },
        recordUsage: () => { },
        memory: {
            semantic: {
                getDefaultBackend: () => 'none',
                setDefaultBackend: () => { },
                backends: {},
                get: async () => null,
                set: async () => { },
                getMany: async () => [],
                delete: async () => { },
            },
            episodic: {
                getDefaultBackend: () => 'none',
                setDefaultBackend: () => { },
                backends: {},
                append: async () => { },
                getEvents: async () => [],
                deleteEvent: async () => { },
            },
            embed: {
                getDefaultBackend: () => 'none',
                setDefaultBackend: () => { },
                backends: {},
                upsert: async () => { },
                queryByVector: async () => [],
                delete: async () => { },
            }
        }
    };

    // Extend context with memory
    const contextWithMemory = await extendContextWithMemory(
        partialCtx,
        tenantId,
        agentName,
        coordinatorAgent.manifest,
        semanticAdapter
    );

    // Add A2A capability
    contextWithMemory.sendTaskToAgent = async (targetAgent, taskInput, options) => {
        return globalA2AService.sendTaskToAgent(contextWithMemory as any, targetAgent, taskInput, options);
    };

    // Create complete task context
    const taskCtx: TaskContext = {
        ...contextWithMemory,
        fail: async (error: unknown) => {
            const errorMessage = error instanceof Error ? error.message : String(error);
            agentLogger.error(`Task failed`, error, { taskId });
            console.error(`❌ Task failed: ${errorMessage}`);
            throw error;
        },
    };

    // Extend with streaming (but we'll use console output)
    extendContextWithStreaming(taskCtx, false);

    console.log('🎯 Executing Coordinator Agent...\n');

    try {
        // Execute the coordinator agent
        const result = await coordinatorAgent.handleTask(taskCtx);

        console.log('\n✅ A2A Demo completed successfully!');
        console.log('📊 Final Result:', JSON.stringify(result, null, 2));

    } catch (error) {
        console.error('\n❌ A2A Demo failed:', error);
        process.exit(1);
    }
}

runA2ADemo().catch(error => {
    console.error('❌ Unhandled error in A2A demo:', error);
    process.exit(1);
}); 