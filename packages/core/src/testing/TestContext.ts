import type { TaskContext, TaskHandle, InputHandle, GroupHandle } from '../shared/types/index.js';
import type { InternalTaskContext } from '../loop/internalContext.js';
import type { IMemory } from '@a2arium/callagent-types';
import type { InvariantErrorCode, InvariantErrorDetail, InvariantErrorContext } from '../types/invariantError.js';
import { InvariantError } from '../utils/errors.js';
import type { DeterministicLLMStub, DeterministicToolStub } from './DeterministicStubs.js';
import type { HarnessState } from './harnessTypes.js';

export function createTestContext(
    state: HarnessState,
    llmStub: DeterministicLLMStub,
    toolStub: DeterministicToolStub
): TaskContext {
    let taskCounter = 0;
    const generateId = (prefix: string) => `${prefix}-${++taskCounter}`;

    const memoryStub: Partial<IMemory> = {
        semantic: {
            add: async () => {},
            read: async () => [],
            remove: async () => {},
        } as unknown as IMemory['semantic'],
        episodic: {
            add: async () => {},
            read: async () => [],
        } as unknown as IMemory['episodic'],
    };

    const ctx: TaskContext = {
        get M() { return state.m; },
        set M(val) { state.m = val as typeof state.m; },
        tenantId: 'test-tenant',
        agentId: 'test-agent',
        task: {
            id: 'test-task-1',
            input: {}
        },
        
        reply: async (parts) => {
            state.replies.push(parts);
        },
        progress: Object.assign(
            (pct: number, msg?: string) => {},
            (status: any) => {}
        ),
        complete: (pct?: number, status?: string) => {},
        fail: async (error: unknown) => {
            state.errors.push(error instanceof Error ? error : new Error(String(error)));
        },

        recordUsage: (cost) => {},
        getUsage: () => ({ totalCost: 0, byKind: {} }),

        telemetry: {
            nodeId: 'test-node-1',
            traceId: 'test-trace-1'
        },

        llm: Object.assign(llmStub, {
            exportState: () => ({}),
            importState: (st: unknown) => {}
        }),

        artifacts: {
            create: <T>(val?: T, options?: { mimeType?: string; preview?: string }) => ({
                id: generateId('art'),
                type: 'artifact',
                mimeType: options?.mimeType || 'application/json',
                preview: options?.preview || '',
                length: 0,
                uri: `memory://artifact/${generateId('uri')}`
            } as unknown as import('@a2arium/callagent-memory-engine').Artifact<T>),
            text: (val?: string) => ({
                id: generateId('art-text'),
                type: 'artifact',
                mimeType: 'text/plain',
                preview: val?.substring(0, 100) || '',
                length: val?.length || 0,
                uri: `memory://artifact/${generateId('uri')}`
            } as unknown as import('@a2arium/callagent-memory-engine').Artifact<string>),
            json: <T>(val?: T) => ({
                id: generateId('art-json'),
                type: 'artifact',
                mimeType: 'application/json',
                preview: '',
                length: 0,
                uri: `memory://artifact/${generateId('uri')}`
            } as unknown as import('@a2arium/callagent-memory-engine').Artifact<T>)
        },

        goals: {
            add: (g) => generateId('goal'),
            update: (id, patch) => {},
            remove: (id) => {},
            clear: (predicate) => {},
            read: (filter) => []
        },
        episodic: { add: (e) => {} },
        thoughts: { add: (t) => {} },
        world: { read: () => ({}) },
        decisions: {
            add: async (key, value, reasoning) => {},
            get: async (key) => null,
            read: async (filter) => []
        },

        recall: async (query, options) => [],
        remember: async (key, value, options) => {},

        tools: {
            invoke: async <T>(toolName: string, args: unknown, options?: { onCompleted?: string; setToken?: boolean; setStage?: string }) => {
                return toolStub.invoke<T>(toolName, args);
            }
        },

        memory: memoryStub as IMemory,

        cognitive: {
            loadWorkingMemory: (e) => {},
            plan: async (prompt, options) => ({}),
            record: (st) => {},
            flush: async () => {}
        },

        config: {},
        validate: (schema, data) => {},
        retry: async <T>(fn: () => Promise<T>, opts: unknown) => fn(),
        cache: {
            get: async <T>(key: string) => null as T | null,
            set: async <T>(key: string, value: T, ttl?: number) => {},
            delete: async (key: string) => {}
        },
        emitEvent: async (channel, payload) => {},
        updateStatus: (st) => {},
        services: { get: (name) => undefined },
        getEnv: (key, def) => def,

        throw: (code: InvariantErrorCode, message: string, detail: InvariantErrorDetail, context?: InvariantErrorContext) => {
            const payload = { code, message, detail, ...context };
            throw new InvariantError(payload);
        },

        sendTaskToAgent: ((targetAgent: string, taskInput: unknown, options?: { awaitCompletion?: boolean }) => {
            state.childDispatches.push({ agent: targetAgent, input: taskInput });
            const token = generateId('child');
            if (options?.awaitCompletion === false) {
                return Promise.resolve({
                    id: generateId('task'),
                    get token() { return token; }
                } as unknown as TaskHandle);
            }
            return Promise.resolve({ status: 'completed', result: {} });
        }) as unknown as TaskContext['sendTaskToAgent'],

        requestInput: async (prompt, opts) => ({
            id: generateId('input'),
            token: generateId('tok-in')
        } as unknown as InputHandle),

        requestTool: async (toolName, args, opts) => ({
            id: generateId('req-tool'),
            token: generateId('tok-tool')
        } as unknown as TaskHandle),

        allTasks: async (children, opts) => ({
            id: generateId('group'),
            token: generateId('tok-grp'),
            wait: async () => ({ results: [] })
        } as unknown as GroupHandle)
    };

    (ctx as InternalTaskContext).controlVars = {};
    return ctx;
}
