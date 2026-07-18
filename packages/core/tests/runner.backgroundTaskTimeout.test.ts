import {
    BACKGROUND_TASK_DRAIN_TIMEOUT_DEFAULTS,
    resolveActiveRunTimeout,
    resolveBackgroundTaskDrainTimeout,
    resolveTerminalDrainTimeout,
} from '../src/runner/backgroundTaskTimeout.js';

describe('runner background task drain timeout policy', () => {
    it('uses explicit CALLAGENT_BACKGROUND_TASK_TIMEOUT_MS first', () => {
        expect(
            resolveBackgroundTaskDrainTimeout({
                explicitTimeoutMs: '1234',
                realRunTimeoutMs: '5678',
                latencyBudgetMs: 90_000,
                taskState: 'working',
            })
        ).toEqual({
            timeoutMs: 1234,
            source: 'env',
            activeGraph: true,
        });
    });

    it('uses REAL_RUN_TIMEOUT_MS when explicit background timeout is unset', () => {
        expect(
            resolveBackgroundTaskDrainTimeout({
                realRunTimeoutMs: '5678',
                latencyBudgetMs: 90_000,
                taskState: 'completed',
            })
        ).toEqual({
            timeoutMs: 5678,
            source: 'real-run-env',
            activeGraph: false,
        });
    });

    it('derives active graph timeout from manifest latency budget plus grace', () => {
        expect(
            resolveBackgroundTaskDrainTimeout({
                latencyBudgetMs: 120_000,
                taskState: 'working',
            })
        ).toEqual({
            timeoutMs: 120_000 + BACKGROUND_TASK_DRAIN_TIMEOUT_DEFAULTS.activeGraceMs,
            source: 'manifest-latency',
            activeGraph: true,
        });
    });

    it('uses a long active default when the graph is still awaiting work', () => {
        expect(
            resolveBackgroundTaskDrainTimeout({
                taskState: 'working',
            })
        ).toEqual({
            timeoutMs: BACKGROUND_TASK_DRAIN_TIMEOUT_DEFAULTS.activeMs,
            source: 'active-default',
            activeGraph: true,
        });
    });

    it('keeps the short default for terminal cleanup', () => {
        expect(
            resolveBackgroundTaskDrainTimeout({
                taskState: 'completed',
            })
        ).toEqual({
            timeoutMs: BACKGROUND_TASK_DRAIN_TIMEOUT_DEFAULTS.terminalMs,
            source: 'terminal-default',
            activeGraph: false,
        });
    });

    it('separates active-run and terminal-cleanup overrides', () => {
        expect(resolveActiveRunTimeout({
            explicitTimeoutMs: '4321',
            realRunTimeoutMs: '9999',
        })).toEqual({ timeoutMs: 4321, source: 'active-run-env' });
        expect(resolveTerminalDrainTimeout('1234')).toEqual({ timeoutMs: 1234, source: 'env' });
    });
});
