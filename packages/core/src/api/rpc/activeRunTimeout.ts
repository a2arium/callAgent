import { PluginManager } from '../../plugin/pluginManager.js';
import {
    resolveActiveRunTimeout,
    type ActiveRunTimeoutDecision,
} from '../../runner/backgroundTaskTimeout.js';

/**
 * Resolve the durable root deadline for an RPC-started task.
 *
 * RPC is one of several task-entry surfaces. It must use the selected agent's
 * latency budget just like the streaming runner does; otherwise long-running
 * agents silently fall back to the generic 15-minute active-run deadline.
 */
export function resolveRpcActiveRunTimeout(agentId?: string): ActiveRunTimeoutDecision {
    const latencyBudgetMs = agentId
        ? PluginManager.findAgent(agentId)?.resolved.runtimeManifest.budgets?.latencyMs
        : undefined;

    return resolveActiveRunTimeout({
        explicitTimeoutMs: process.env.CALLAGENT_ACTIVE_RUN_TIMEOUT_MS,
        realRunTimeoutMs: process.env.REAL_RUN_TIMEOUT_MS,
        latencyBudgetMs,
    });
}
