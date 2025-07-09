import { extendContextWithMemory } from './src/core/memory/types/working/context/workingMemoryContext.js';
import { TaskContext } from './src/shared/types/index.js';
import { SemanticMemoryAdapter, EpisodicMemoryAdapter } from './src/core/memory/UnifiedMemoryService.js';
import {
    GetManyInput,
    GetManyOptions,
    MemoryQueryResult,
    MemoryQueryOptions
} from '@callagent/types';

/**
 * Mock semantic memory adapter for testing
 */
class MockSemanticMemoryAdapter implements SemanticMemoryAdapter {
    private store = new Map<string, unknown>();

    async set(key: string, value: unknown, namespace?: string, tenantId?: string): Promise<void> {
        const fullKey = `${tenantId || 'default'}:${namespace || 'default'}:${key}`;
        this.store.set(fullKey, value);
    }

    async get(key: string, namespace?: string, tenantId?: string): Promise<unknown> {
        const fullKey = `${tenantId || 'default'}:${namespace || 'default'}:${key}`;
        return this.store.get(fullKey) || null;
    }

    async query(query: string, options?: unknown, tenantId?: string): Promise<unknown[]> {
        const results: unknown[] = [];
        const tenantPrefix = `${tenantId || 'default'}:`;

        for (const [fullKey, value] of this.store.entries()) {
            if (fullKey.startsWith(tenantPrefix)) {
                // Extract the actual key part (remove tenant and namespace prefixes)
                const keyParts = fullKey.split(':');
                const actualKey = keyParts[keyParts.length - 1];

                // Search in both key and value
                const keyMatches = actualKey.toLowerCase().includes(query.toLowerCase());
                const valueMatches = typeof value === 'string' && value.toLowerCase().includes(query.toLowerCase());

                if (keyMatches || valueMatches) {
                    results.push(value);
                }
            }
        }
        return results;
    }

    async getMany<T>(input: GetManyInput, options?: GetManyOptions, tenantId?: string): Promise<Array<MemoryQueryResult<T>>> {
        const results: Array<MemoryQueryResult<T>> = [];
        const tenantPrefix = `${tenantId || 'default'}:`;

        // Handle string pattern input
        if (typeof input === 'string') {
            const pattern = input.replace('*', ''); // Simple pattern matching

            for (const [fullKey, value] of this.store.entries()) {
                if (fullKey.startsWith(tenantPrefix)) {
                    const keyParts = fullKey.split(':');
                    const actualKey = keyParts[keyParts.length - 1];

                    // Search in both key and value (like the query method)
                    const keyMatches = actualKey.toLowerCase().includes(pattern.toLowerCase());
                    const valueMatches = typeof value === 'string' && value.toLowerCase().includes(pattern.toLowerCase());

                    if (keyMatches || valueMatches) {
                        results.push({
                            key: actualKey,
                            value: value as T
                        });
                    }
                }
            }
        }

        return results;
    }

    async delete(key: string, namespace?: string, tenantId?: string): Promise<void> {
        const fullKey = `${tenantId || 'default'}:${namespace || 'default'}:${key}`;
        this.store.delete(fullKey);
    }

    async clear(namespace?: string, tenantId?: string): Promise<void> {
        const prefix = `${tenantId || 'default'}:${namespace || 'default'}:`;
        for (const key of this.store.keys()) {
            if (key.startsWith(prefix)) {
                this.store.delete(key);
            }
        }
    }
}

/**
 * Mock episodic memory adapter for testing
 */
class MockEpisodicMemoryAdapter implements EpisodicMemoryAdapter {
    private events: Array<{ event: unknown; timestamp: string; tenantId: string }> = [];

    async append(event: unknown, opts?: { tags?: string[] }, tenantId?: string): Promise<void> {
        this.events.push({
            event,
            timestamp: new Date().toISOString(),
            tenantId: tenantId || 'default'
        });
    }

    async getEvents<T>(filter?: MemoryQueryOptions, tenantId?: string): Promise<Array<MemoryQueryResult<T>>> {
        return this.events
            .filter(e => e.tenantId === (tenantId || 'default'))
            .map((e, index) => ({
                key: `event-${index}`,
                value: e.event as T
            }));
    }

    async query(query: string, options?: unknown, tenantId?: string): Promise<unknown[]> {
        return this.events
            .filter(e => e.tenantId === (tenantId || 'default'))
            .filter(e => JSON.stringify(e.event).includes(query))
            .map(e => e.event);
    }

    async clear(tenantId?: string): Promise<void> {
        this.events = this.events.filter(e => e.tenantId !== (tenantId || 'default'));
    }
}

/**
 * Create a test context with full memory capabilities
 */
export async function createTestContext(
    tenantId: string = 'test-tenant',
    agentConfig?: unknown,
    agentId: string = 'test-agent'
): Promise<TaskContext> {
    // Create mock adapters
    const semanticAdapter = new MockSemanticMemoryAdapter();
    const episodicAdapter = new MockEpisodicMemoryAdapter();

    // Base context with required TaskContext properties
    const baseContext = {
        tenantId,
        agentId,
        task: {
            id: 'test-task',
            input: { test: true }
        },
        reply: (() => Promise.resolve()) as any,
        progress: (() => { }) as any,
        complete: (() => { }) as any,
        fail: (() => Promise.resolve()) as any,
        recordUsage: (() => { }) as any,
        llm: {
            call: (() => Promise.resolve({ content: 'mock response' })) as any,
            callWithSchema: (() => Promise.resolve({ content: 'mock response' })) as any
        },
        tools: { invoke: (() => Promise.resolve({})) as any },
        memory: {
            semantic: semanticAdapter,
            episodic: episodicAdapter,
            embed: {
                upsert: (() => Promise.resolve()) as any,
                queryByVector: (() => Promise.resolve([])) as any,
                delete: (() => Promise.resolve()) as any
            }
        },
        cognitive: {
            loadWorkingMemory: (() => Promise.resolve()) as any,
            plan: (() => Promise.resolve({})) as any,
            record: (() => { }) as any,
            flush: (() => Promise.resolve()) as any
        },
        logger: {
            debug: (() => { }) as any,
            info: (() => { }) as any,
            warn: (() => { }) as any,
            error: (() => { }) as any
        },
        config: {},
        validate: (() => true) as any,
        retry: (async (fn: any) => await fn()) as any,
        cache: {
            get: (() => Promise.resolve(null)) as any,
            set: (() => Promise.resolve()) as any,
            delete: (() => Promise.resolve()) as any
        },
        emitEvent: (() => Promise.resolve()) as any,
        updateStatus: (() => { }) as any,
        services: { get: (() => undefined) as any },
        getEnv: (() => undefined) as any,
        throw: ((code: string, message: string) => {
            throw new Error(`${code}: ${message}`);
        }) as any
    };

    // Extend with memory capabilities
    const context = await extendContextWithMemory(
        baseContext,
        tenantId,
        agentId,
        agentConfig || { memory: { profile: 'basic' } },
        semanticAdapter
    );

    // Add episodic adapter to the context manually for testing
    if (context.memory && episodicAdapter) {
        (context.memory as any).mlo.episodicMemoryAdapter = episodicAdapter;
    }

    // Add A2A capability for testing
    const { globalA2AService } = await import('./src/core/orchestration/A2AService.js');
    context.sendTaskToAgent = async (targetAgent, taskInput, options) => {
        return globalA2AService.sendTaskToAgent(context as any, targetAgent, taskInput, options);
    };

    return context;
}

/**
 * Create a minimal test context without memory capabilities
 */
export function createMinimalTestContext(tenantId: string = 'test-tenant', agentId: string = 'test-agent'): Partial<TaskContext> {
    return {
        tenantId,
        agentId,
        task: {
            id: 'test-task',
            input: { test: true }
        },
        reply: (() => Promise.resolve()) as any,
        complete: (() => { }) as any,
        fail: (() => Promise.resolve()) as any,
        logger: {
            debug: (() => { }) as any,
            info: (() => { }) as any,
            warn: (() => { }) as any,
            error: (() => { }) as any
        }
    };
}

/**
 * Wait for async operations to complete
 */
export function waitForAsync(ms: number = 10): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Clean up test context resources
 */
export async function cleanupTestContext(context: TaskContext): Promise<void> {
    // Clear memory adapters first
    if (context.memory) {
        // Clear semantic memory (cast to any to access clear method)
        const semanticMemory = context.memory.semantic as any;
        if (semanticMemory && typeof semanticMemory.clear === 'function') {
            await semanticMemory.clear(undefined, context.tenantId);
        }

        // Clear episodic memory
        if ((context.memory as any).episodic && typeof (context.memory as any).episodic.clear === 'function') {
            await (context.memory as any).episodic.clear(context.tenantId);
        }

        // Clear MLO system
        if (context.memory?.mlo) {
            await (context.memory.mlo as any).shutdown?.();
        }
    }
} 