/**
 * Wires the default in-process runtime stack: TurnRunnerSegmentExecutor +
 * InProcessRuntimeDriver. Used at the TaskEngine composition root (Phase 0.3).
 *
 * INTERNAL — not exported from the public package index.
 */

import type { SessionManager } from '../orchestration/SessionManager.js';
import type { TurnRunner } from '../orchestration/TurnRunner.js';
import type { TaskContext } from '../shared/types/index.js';
import { InProcessRuntimeDriver } from './inProcessRuntimeDriver.js';
import type { RuntimeDriver } from './runtimeDriver.js';
import {
    TurnRunnerSegmentExecutor,
    type RuntimeContextBinding,
} from './turnRunnerSegmentExecutor.js';
import type { TurnExecutor } from './turnExecutor.js';
import { RuntimeTimerRepository } from './runtimeTimer.js';
import type { TaskRunTimeoutDisposition } from './runtimeTimer.js';

export type InProcessRuntimeStack = {
    turnExecutor: TurnExecutor;
    runtimeDriver: RuntimeDriver;
    onTaskRunTimeout?: BuildInProcessRuntimeStackParams['onTaskRunTimeout'];
};

export type BuildInProcessRuntimeStackParams = {
    turnRunner: TurnRunner;
    sessionManager: SessionManager;
    createContext: (
        task: { id: string; input: unknown },
        binding?: RuntimeContextBinding
    ) => TaskContext;
    isStreaming?: boolean;
    onChildTimeout?: (params: { tenantId: string; childTaskId: string }) => Promise<void>;
    onTaskTerminal?: (params: {
        tenantId: string;
        taskId: string;
        state: 'completed' | 'failed' | 'canceled';
        runtimeSurface: 'direct' | 'in_process' | 'hatchet';
    }) => Promise<void>;
    onTaskRunTimeout?: (params: {
        tenantId: string;
        taskId: string;
        agentId?: string;
        token: string;
        dueAt: string;
        payload?: unknown;
    }) => Promise<TaskRunTimeoutDisposition | void>;
    ensureInitialRootDeadline?: (params: {
        tenantId: string;
        taskId: string;
        agentId?: string;
        snapshot: Record<string, unknown>;
    }) => Promise<'ready' | 'canceled' | 'terminal'>;
    enableTurnRecovery?: boolean;
};

/** Default Phase 0 stack: real segment kernel behind the in-process driver. */
export function buildInProcessRuntimeStack(
    params: BuildInProcessRuntimeStackParams
): InProcessRuntimeStack {
    const turnExecutor = new TurnRunnerSegmentExecutor({
        turnRunner: params.turnRunner,
        sessionManager: params.sessionManager,
        createContext: params.createContext,
        isStreaming: params.isStreaming,
        onChildTimeout: params.onChildTimeout,
        onTaskTerminal: params.onTaskTerminal,
        ensureInitialRootDeadline: params.ensureInitialRootDeadline,
    });
    const prisma = (params.sessionManager as unknown as { store?: { prisma?: { runtimeTimer?: unknown } } })
        .store?.prisma;
    // An outer runtime driver (Hatchet/custom) owns durable timer storage and
    // reconciliation. The in-process delegate must not race it for the same
    // SQL timer leases.
    const runtimeTimers = params.enableTurnRecovery !== false && prisma?.runtimeTimer
        ? new RuntimeTimerRepository(prisma as never)
        : undefined;
    const runtimeDriver = new InProcessRuntimeDriver({
        turnExecutor,
        runtimeTimers,
        // Pure in-memory sessions cannot survive process loss and accepted wakes
        // are scheduled locally. Periodic durable scanning is reserved for SQL
        // stores, and is disabled when this stack is only the delegate behind an
        // outer runtime driver (Hatchet/custom drivers own their recovery loop).
        sessionManager: params.enableTurnRecovery !== false && runtimeTimers !== undefined
            ? params.sessionManager
            : undefined,
        onTaskRunTimeout: params.onTaskRunTimeout,
    });
    return { turnExecutor, runtimeDriver, onTaskRunTimeout: params.onTaskRunTimeout };
}
