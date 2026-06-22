/**
 * Unit tests for TaskExecutor logic
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(__dirname, '../src');

// Mock dependencies
const mockExtendContext = jest.fn();
const mockGetPrisma = jest.fn();
const mockRunLoop = jest.fn() as jest.Mock<any>;
const mockFindAgent = jest.fn() as jest.Mock<any>;
const mockCreateLLMForTask = jest.fn() as jest.Mock<any>;
const mockLogger = {
    createLogger: () => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn()
    })
};

// unstable_mockModule needs absolute paths or precise specifiers in ESM
await jest.unstable_mockModule('@a2arium/callagent-memory-engine', () => ({
    extendContextWithMemory: mockExtendContext,
    getMemoryPrismaClient: mockGetPrisma,
    AgentResultCache: class { },
    offloadArtifacts: jest.fn()
}));

await jest.unstable_mockModule(resolve(srcDir, 'loop/loopRunner.ts'), () => ({
    runLoop: mockRunLoop
}));

await jest.unstable_mockModule('@a2arium/callagent-utils', () => ({
    logger: mockLogger,
    updateLoggingContext: jest.fn()
}));

await jest.unstable_mockModule(resolve(srcDir, 'llm/LLMFactory.ts'), () => ({
    createLLMForTask: mockCreateLLMForTask,
    createEmbeddingFunction: jest.fn(),
    isEmbeddingAvailable: jest.fn(() => false)
}));

await jest.unstable_mockModule(resolve(srcDir, 'plugin/pluginManager.ts'), () => ({
    PluginManager: {
        findAgent: mockFindAgent,
    },
}));

await jest.unstable_mockModule(resolve(srcDir, 'orchestration/SessionManager.ts'), () => ({
    SessionManager: class { }
}));

await jest.unstable_mockModule(resolve(srcDir, 'loop/hygiene.ts'), () => ({
    pruneSnapshot: jest.fn(x => x)
}));

await jest.unstable_mockModule(resolve(srcDir, 'eventbus/taskEventEmitter.ts'), () => ({ taskChannel: { emit: jest.fn() } }));
await jest.unstable_mockModule(resolve(srcDir, 'orchestration/ArtifactHydrationService.ts'), () => ({ ArtifactHydrationService: { hydrate: jest.fn() } }));
await jest.unstable_mockModule(resolve(srcDir, 'orchestration/InboxManager.ts'), () => ({ InboxManager: { normalizeInbox: jest.fn(x => x), mergeInboxes: jest.fn() } }));

// Import the module under test
const { TaskExecutor } = await import(resolve(srcDir, 'orchestration/TaskExecutor.ts'));

describe('TaskExecutor', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockRunLoop.mockResolvedValue({
            M: {},
            outcome: { kind: 'continue' },
            metrics: {}
        });
        mockFindAgent.mockReset();
        mockCreateLLMForTask.mockReset();
    });

    it('should call extendContextWithMemory if memory backends are empty', async () => {
        const ctx: any = {
            memory: {
                semantic: {
                    backends: {}, // Empty backends
                    getDefaultBackend: () => 'none'
                }
            }
        };

        const params: any = {
            ctx,
            M: {},
            env: { turn: 1, inbox: { current: [], all: [] } },
            overrides: {},
            loopOpts: {},
            sessionManager: undefined, // simplify test
            tenantId: 'test-tenant',
            sessionId: 'test-session',
            agentId: 'test-agent',
            isStreaming: false
        };

        await TaskExecutor.executeTurn(params);

        expect(mockExtendContext).toHaveBeenCalledTimes(1);
        expect(mockExtendContext).toHaveBeenCalledWith(
            expect.anything(), // ctx
            'test-tenant',
            'test-agent',
            expect.anything(), // config
            undefined, // semanticAdapter
            undefined  // existingPrisma (mock returns undefined)
        );
    });

    it('should NOT call extendContextWithMemory if memory is already valid', async () => {
        const ctx: any = {
            memory: {
                semantic: {
                    backends: { sql: {} }, // Valid backend
                    getDefaultBackend: () => 'sql'
                }
            }
        };

        const params: any = {
            ctx,
            M: {},
            env: { turn: 1, inbox: { current: [], all: [] } },
            overrides: {},
            loopOpts: {},
            tenantId: 'test-tenant',
            sessionId: 'test-session',
            agentId: 'test-agent',
            isStreaming: false
        };

        await TaskExecutor.executeTurn(params);

        expect(mockExtendContext).not.toHaveBeenCalled();
    });

    it('attaches the configured agent LLM before running a turn', async () => {
        const llm = {
            call: jest.fn(),
            stream: jest.fn(),
            addToolResult: jest.fn(),
            updateSettings: jest.fn(),
            getMessages: jest.fn(() => [{ role: 'user', content: 'previous' }]),
            importState: jest.fn(),
            getHistoryMode: jest.fn(() => 'full'),
        };
        mockFindAgent.mockReturnValue({
            llmConfig: { provider: 'openai', modelAliasOrName: 'gpt-5-mini' },
        });
        mockCreateLLMForTask.mockReturnValue(llm);

        const ctx: any = {
            memory: {
                semantic: {
                    backends: { sql: {} },
                    getDefaultBackend: () => 'sql',
                },
            },
            llm: {
                call: async () => [],
                stream: async function* () { },
                addToolResult: () => { },
                updateSettings: () => { },
            },
        };

        const sessionManager = {
            load: jest.fn(async () => ({ snapshot: { llmState: { messages: ['saved'] } } })),
        };

        await TaskExecutor.executeTurn({
            ctx,
            M: {},
            env: { turn: 1, inbox: { current: [], all: [] } },
            overrides: {},
            loopOpts: {},
            sessionManager,
            tenantId: 'test-tenant',
            sessionId: 'test-session',
            agentId: 'discover-listing-selectors',
            isStreaming: false,
            getSessionStorePrisma: () => undefined,
        } as any);

        expect(mockCreateLLMForTask).toHaveBeenCalledWith(
            { provider: 'openai', modelAliasOrName: 'gpt-5-mini' },
            ctx
        );
        expect(llm.importState).toHaveBeenCalledWith({ messages: ['saved'] });
        expect(mockRunLoop).toHaveBeenCalledWith(
            expect.objectContaining({ llm }),
            expect.anything(),
            expect.anything(),
            expect.anything(),
            expect.anything()
        );
    });

    it('records turn usage on base contexts and carries it into task status metadata', async () => {
        mockRunLoop.mockImplementation(async (ctx: any) => {
            ctx.recordUsage({ cost: 0.125, kind: 'llm', provider: 'openai' });
            return {
                M: {},
                outcome: { kind: 'complete', result: { ok: true } },
                metrics: {},
            };
        });

        const ctx: any = {
            memory: {
                semantic: {
                    backends: { sql: {} },
                    getDefaultBackend: () => 'sql',
                },
            },
            recordUsage: jest.fn(() => {
                throw new Error('base usage stub should be replaced');
            }),
        };

        const result = await TaskExecutor.executeTurn({
            ctx,
            M: {},
            env: { turn: 1, inbox: { current: [], all: [] } },
            overrides: {},
            loopOpts: {},
            sessionManager: undefined,
            tenantId: 'test-tenant',
            sessionId: 'test-session',
            agentId: 'test-agent',
            isStreaming: false,
            getSessionStorePrisma: () => undefined,
        } as any);

        expect(ctx.getUsage()).toEqual({ totalCost: 0.125, byKind: { llm: 0.125 } });
        expect(result.taskStatus.metadata).toMatchObject({
            result: { ok: true },
            usage: { totalCost: 0.125, byKind: { llm: 0.125 } },
        });
    });
});
