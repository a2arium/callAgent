import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { TaskEngine } from '../../src/orchestration/taskEngine.js';
import { InMemorySessionManager } from '../../src/orchestration/InMemorySessionManager.js';
import { TaskExecutor } from '../../src/orchestration/TaskExecutor.js';
import { PluginManager } from '../../src/plugin/pluginManager.js';
import { isSyncRuntimeDriver } from '../../src/runtime/inProcessRuntimeDriver.js';
import type { RuntimeDriver } from '../../src/runtime/runtimeDriver.js';
import { initialM } from '../../src/loop/init.js';
import type { TaskContext } from '../../src/shared/types/index.js';

const loopAgentPlugin = {
    resolved: {
        runtimeManifest: {
            name: 'driver-test-agent',
            version: '1.0.0',
            runMode: 'loop' as const,
            budgets: { maxTurns: 5 },
        },
        agentCard: { name: 'driver-test-agent', version: '1.0.0' },
    },
};

describe('TaskEngine runtime driver routing', () => {
    beforeEach(() => {
        process.env.DISABLE_OUTBOX_PUBLISHER = 'true';
        jest.spyOn(PluginManager, 'findAgent').mockReturnValue(loopAgentPlugin as never);
    });

    afterEach(() => {
        delete process.env.DISABLE_OUTBOX_PUBLISHER;
        jest.restoreAllMocks();
    });

    it('falls back to turnRunner when driver lacks sync extensions', async () => {
        const executeTurnSpy = jest.spyOn(TaskExecutor, 'executeTurn').mockResolvedValue({
            M: initialM({ task: { id: 't-fallback', input: {} } } as TaskContext),
            outcome: { kind: 'complete', result: {} },
            metrics: {},
            taskStatus: { state: 'completed', timestamp: new Date().toISOString() },
        });

        const asyncOnlyDriver: RuntimeDriver = {
            enqueueStart: jest.fn(async () => undefined),
            enqueueResume: jest.fn(async () => undefined),
            enqueueChildDispatch: jest.fn(async () => undefined),
            scheduleTimer: jest.fn(async () => ({ timerId: 't1' })),
            cancel: jest.fn(async () => undefined),
            dispatchOutbox: jest.fn(async () => undefined),
        };

        const store = new InMemorySessionManager();
        const engine = new TaskEngine({
            sessionStore: store,
            runtimeDriver: asyncOnlyDriver,
        });

        const runTurnSpy = jest.spyOn(
            (engine as { turnRunner: { runTurn: Function } }).turnRunner,
            'runTurn'
        );

        await engine.startTask({
            tenantId: 't',
            agentId: 'driver-test-agent',
            isStreaming: false,
            task: {
                id: 't-fallback',
                input: {},
                status: { state: 'submitted', timestamp: new Date().toISOString() },
            },
        });

        expect(asyncOnlyDriver.enqueueStart).not.toHaveBeenCalled();
        expect(runTurnSpy).toHaveBeenCalledTimes(1);
        executeTurnSpy.mockRestore();
        runTurnSpy.mockRestore();
    });

    it('uses sync driver extensions when available', async () => {
        const executeTurnSpy = jest.spyOn(TaskExecutor, 'executeTurn').mockResolvedValue({
            M: initialM({ task: { id: 't-sync', input: {} } } as TaskContext),
            outcome: { kind: 'complete', result: { ok: true } },
            metrics: {},
            taskStatus: {
                state: 'completed',
                timestamp: new Date().toISOString(),
                metadata: { result: { ok: true } },
            },
        });

        const store = new InMemorySessionManager();
        const engine = new TaskEngine({ sessionStore: store });
        const driver = engine.getCompositionRuntimeDriver();
        expect(isSyncRuntimeDriver(driver)).toBe(true);

        const startSpy = jest.spyOn(driver, 'enqueueStartSync');

        await engine.startTask({
            tenantId: 't',
            agentId: 'driver-test-agent',
            isStreaming: false,
            task: {
                id: 't-sync',
                input: { x: 1 },
                status: { state: 'submitted', timestamp: new Date().toISOString() },
            },
        });

        expect(startSpy).toHaveBeenCalledTimes(1);
        executeTurnSpy.mockRestore();
        startSpy.mockRestore();
    });
});
