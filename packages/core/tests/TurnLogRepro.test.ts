import { jest } from '@jest/globals';
import { withLoggingContext, getLoggingContext } from '@a2arium/callagent-utils';
import { A2AService } from '../src/orchestration/A2AService.js';
import { TurnRunner } from '../src/orchestration/TurnRunner.js';
import { PluginManager } from '../src/plugin/pluginManager.js';
import { SessionManager } from '../src/orchestration/SessionManager.js';
import { ApiBinder } from '../src/orchestration/api/ApiBinder.js';
import { EngineLocator } from '../src/orchestration/EngineLocator.js';
import { createInMemoryEventBus } from '../src/eventbus/inMemoryEventBus.js';

describe('Turn Logic & Logging Verification', () => {
    let a2a: A2AService;
    let turnRunner: TurnRunner;
    let sessionManager: SessionManager;
    let mockEngine: any;

    beforeEach(() => {
        const mockPrisma = {} as any;
        sessionManager = new SessionManager(() => mockPrisma);
        const apiBinder = new ApiBinder(sessionManager, () => mockPrisma);
        turnRunner = new TurnRunner(sessionManager, apiBinder, () => mockPrisma, createInMemoryEventBus());
        a2a = new A2AService();

        mockEngine = {
            handleChildCompleted: jest.fn(),
            startTask: jest.fn().mockResolvedValue({ status: 'completed' }),
            handleChildInputRequired: jest.fn(),
            stageChildCompletionObservation: jest.fn()
        };
        EngineLocator.setEngine(mockEngine);

        PluginManager.registerAgent({
            resolved: {
                agentCard: {
                    name: 'child-agent',
                    version: '1.0.0',
                    description: 'test child',
                    supportedInterfaces: [{ protocolBinding: 'JSONRPC', protocolVersion: '1.0', url: 'http://localhost' }],
                    capabilities: {},
                    defaultInputModes: ['text/plain'],
                    defaultOutputModes: ['text/plain'],
                    skills: [{ id: 's1', name: 's1', description: 's1' }]
                },
                runtimeManifest: {
                    name: 'child-agent',
                    version: '1.0.0',
                    runMode: 'loop'
                } as any,
                agentCardHash: 'h1',
                runtimeManifestHash: 'h2',
                agentCardSource: 'inline',
                runtimeManifestSource: 'inline'
            },
            execution: async (a, ctx) => {
                return {
                    action: { kind: 'output', payload: { value: 'done' } },
                    result: { status: 'completed' }
                };
            },
            perception: (env: any) => ({}),
            attention: () => ({}),
            learning: (p: any, a: any, o: any) => p,
            policy: () => ({ kind: 'output', payload: { value: 'done' } }),
            transition: (env: any) => ({ kind: 'complete' }),
            shield: () => ({ kind: 'allow' }),
            tenantId: 'tenant-1'
        } as any);
    });

    it('verifies the "blink" fix: child does NOT inherit parent turn in logging context', async () => {
        const ctx = {
            agentId: 'parent-agent',
            tenantId: 'tenant-1',
            task: { id: 'parent-task', input: 'hello' }
        } as any;

        // Parent is on turn 3
        await withLoggingContext({ turn: 3, taskId: 'parent-task', agentId: 'parent-agent' }, async () => {
            // Intercept engine call to check context inside child startup
            mockEngine.startTask.mockImplementation(async (params: any) => {
                const logCtx = getLoggingContext();
                // ✅ VERIFY: Child logging context should NOT have parent turn
                expect(logCtx.turn).toBeUndefined();
                return { status: 'completed' };
            });

            await a2a.sendTaskToAgent(ctx, 'child-agent', { input: 'hello' });
        });
    });

    it('verifies Turn 1 provenance for initial observations', async () => {
        const mockSessionManager = {
            load: jest.fn().mockResolvedValue({ wmVersion: BigInt(0), snapshot: { meta: { turn: 0 } } }),
            saveSnapshot: jest.fn()
        };

        const mockApiBinder: any = {
            attachOrchestrationAPIs: jest.fn().mockResolvedValue(undefined)
        };

        const tr = new TurnRunner(mockSessionManager as any, mockApiBinder as any, () => ({}), createInMemoryEventBus());

        const ctx: any = { agentId: 'test-agent', task: { id: 'test-task-id', input: 'hello' } };
        const params: any = {
            tenantId: 't1',
            sessionId: 's1',
            trigger: 'start',
            input: 'hello'
        };

        await tr.runTurn(ctx, params);

        const saveCall = mockSessionManager.saveSnapshot.mock.calls[0][0] as any;
        const inbox = saveCall.snapshot.inbox;
        const inputObs = inbox.all.find((o: any) => o.kind === 'input.provided');

        // ✅ VERIFY: Provenance should be Turn 1
        expect(inputObs.provenance.turn).toBe(1);
    });

    it('verifies A2A persistence: unique Task IDs to prevent state pollution', async () => {
        const sourceCtx: any = {
            task: { id: 'parent-task' },
            agentId: 'parent-agent',
            tenantId: 'tenant-1'
        };

        const targetAgent = 'child-agent';

        // Call 1
        await a2a.sendTaskToAgent(sourceCtx, targetAgent, { page: 1 });
        const taskId1 = mockEngine.startTask.mock.calls[0][0].task.id;

        // Small delay to ensure different timestamp
        const start = Date.now();
        while (Date.now() === start) { /* busy wait */ }

        // Call 2
        await a2a.sendTaskToAgent(sourceCtx, targetAgent, { page: 2 });
        const taskId2 = mockEngine.startTask.mock.calls[1][0].task.id;

        // ✅ VERIFY: Task IDs are now UNIQUE (to prevent state pollution across runs)
        // Each call should have a different taskId with unique timestamp suffix
        expect(taskId1).not.toBe(taskId2);

        // Both should start with the expected prefix
        expect(taskId1).toMatch(/^a2a_parent-task_child-agent_\d+_[a-z0-9]+$/);
        expect(taskId2).toMatch(/^a2a_parent-task_child-agent_\d+_[a-z0-9]+$/);

        console.log('✅ Task ID 1:', taskId1);
        console.log('✅ Task ID 2:', taskId2);
        console.log('   Each call gets unique state, preventing pollution');
    });
});
