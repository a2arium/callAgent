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
    logger: mockLogger
}));

await jest.unstable_mockModule(resolve(srcDir, 'llm/LLMFactory.ts'), () => ({
    createEmbeddingFunction: jest.fn(),
    isEmbeddingAvailable: jest.fn(() => false)
}));

await jest.unstable_mockModule(resolve(srcDir, 'orchestration/SessionManager.ts'), () => ({
    SessionManager: class { }
}));

await jest.unstable_mockModule(resolve(srcDir, 'loop/hygiene.ts'), () => ({
    pruneSnapshot: jest.fn(x => x)
}));

await jest.unstable_mockModule(resolve(srcDir, 'eventbus/taskEventEmitter.ts'), () => ({ taskChannel: { emit: jest.fn() } }));
await jest.unstable_mockModule(resolve(srcDir, 'eventbus/inMemoryEventBus.ts'), () => ({ eventBus: { emit: jest.fn() } }));
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
});
