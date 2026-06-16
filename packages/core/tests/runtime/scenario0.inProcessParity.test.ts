/**
 * POC Scenario 0 — in-process parity (orchestrator-harness/harness/poc-scenarios.md).
 *
 * Proves TaskEngine start → input → resume → complete routes through the
 * in-process runtime driver without changing outcomes.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { TaskEngine } from '../../src/orchestration/taskEngine.js';
import { InMemorySessionManager } from '../../src/orchestration/InMemorySessionManager.js';
import { TaskExecutor } from '../../src/orchestration/TaskExecutor.js';
import { PluginManager } from '../../src/plugin/pluginManager.js';
import { isSyncRuntimeDriver } from '../../src/runtime/inProcessRuntimeDriver.js';
import { initialM } from '../../src/loop/init.js';
import type { TaskContext } from '../../src/shared/types/index.js';
import { setPendingInputs } from '../../src/orchestration/DurableHandlerRegistry.js';

const loopAgentPlugin = {
    resolved: {
        runtimeManifest: {
            name: 'scenario0-agent',
            version: '1.0.0',
            runMode: 'loop' as const,
            budgets: { maxTurns: 10 },
        },
        agentCard: { name: 'scenario0-agent', version: '1.0.0' },
    },
};

describe('POC Scenario 0 — in-process parity via TaskEngine', () => {
    const tenantId = 'tenant-scenario0';
    const taskId = 'task-scenario0';
    const agentId = 'scenario0-agent';
    const inputToken = 'input-scenario0';

    let executeTurnSpy: ReturnType<typeof jest.spyOn>;
    let segment = 0;

    beforeEach(() => {
        process.env.DISABLE_OUTBOX_PUBLISHER = 'true';
        segment = 0;
        jest.spyOn(PluginManager, 'findAgent').mockReturnValue(loopAgentPlugin as never);
        executeTurnSpy = jest.spyOn(TaskExecutor, 'executeTurn');
    });

    afterEach(() => {
        delete process.env.DISABLE_OUTBOX_PUBLISHER;
        executeTurnSpy.mockRestore();
        jest.restoreAllMocks();
    });

    it('start → await_input → resume → complete routes through sync runtime driver', async () => {
        executeTurnSpy.mockImplementation(async (params) => {
            segment += 1;
            const M = params.M ?? initialM(params.ctx as TaskContext);
            if (segment === 1) {
                return {
                    M,
                    outcome: { kind: 'await_input', token: inputToken },
                    metrics: {},
                    taskStatus: {
                        state: 'input-required',
                        timestamp: new Date().toISOString(),
                        metadata: { token: inputToken },
                    },
                };
            }
            return {
                M,
                outcome: { kind: 'complete', result: { done: true } },
                metrics: {},
                taskStatus: {
                    state: 'completed',
                    timestamp: new Date().toISOString(),
                    metadata: { result: { done: true } },
                },
            };
        });

        const store = new InMemorySessionManager();
        const engine = new TaskEngine({ sessionStore: store });
        const driver = engine.getCompositionRuntimeDriver();
        expect(isSyncRuntimeDriver(driver)).toBe(true);
        const startSpy = jest.spyOn(driver, 'enqueueStartSync');
        const resumeSpy = jest.spyOn(driver, 'enqueueResumeSync');

        const task = await engine.startTask({
            tenantId,
            agentId,
            isStreaming: false,
            task: {
                id: taskId,
                input: { question: 'hello' },
                status: { state: 'submitted', timestamp: new Date().toISOString() },
            },
        });

        expect(startSpy).toHaveBeenCalledTimes(1);
        expect(startSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                tenantId,
                taskId,
                idempotencyKey: `${taskId}:start`,
            })
        );
        expect(task.status?.state).toBe('input-required');
        expect(executeTurnSpy).toHaveBeenCalledTimes(1);

        const loaded = await (engine as unknown as { sessionManager: { load: (t: string, s: string) => Promise<{ wmVersion?: bigint; snapshot?: unknown } | null> } }).sessionManager.load(
            tenantId,
            taskId
        );
        await (engine as unknown as { sessionManager: { saveSnapshot: (p: unknown) => Promise<unknown> } }).sessionManager.saveSnapshot({
            tenantId,
            sessionId: taskId,
            agentId,
            expectedWmVersion: loaded?.wmVersion ?? BigInt(0),
            snapshot: setPendingInputs(
                (loaded?.snapshot as Record<string, unknown>) ?? {
                    meta: { agentId, turn: 1 },
                },
                { [inputToken]: {} }
            ),
        });

        await engine.resumeInput({
            tenantId,
            taskId,
            token: inputToken,
            input: 'my answer',
        });

        expect(resumeSpy).toHaveBeenCalledTimes(1);
        expect(resumeSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                tenantId,
                taskId,
                idempotencyKey: `${taskId}:input:${inputToken}`,
                event: expect.objectContaining({ kind: 'input', token: inputToken }),
            })
        );
        expect(executeTurnSpy).toHaveBeenCalledTimes(2);

        const finalSnap = await (engine as unknown as { sessionManager: { load: (t: string, s: string) => Promise<{ snapshot?: unknown } | null> } }).sessionManager.load(
            tenantId,
            taskId
        );
        const inbox = (finalSnap?.snapshot as { inbox?: { current: Array<{ kind: string }> } })?.inbox;
        expect(inbox?.current.some((o) => o.kind === 'input.provided')).toBe(true);

        await engine.waitForBackgroundTasks(2000);
    });
});
