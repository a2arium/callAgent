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
import { TurnRunnerSegmentExecutor } from './turnRunnerSegmentExecutor.js';
import type { TurnExecutor } from './turnExecutor.js';

export type InProcessRuntimeStack = {
    turnExecutor: TurnExecutor;
    runtimeDriver: RuntimeDriver;
};

export type BuildInProcessRuntimeStackParams = {
    turnRunner: TurnRunner;
    sessionManager: SessionManager;
    createContext: (task: { id: string; input: unknown }) => TaskContext;
    isStreaming?: boolean;
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
    });
    const runtimeDriver = new InProcessRuntimeDriver({ turnExecutor });
    return { turnExecutor, runtimeDriver };
}
