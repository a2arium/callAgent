import path from 'node:path';

export const DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS = '300000';

export function resolveRuntimeWorkspacePath(value, invocationCwd) {
    return path.isAbsolute(value) ? value : path.resolve(invocationCwd, value);
}

export function buildRuntimeEnvironment(baseEnv, callagentWorkspaces) {
    return {
        ...baseEnv,
        CALLAGENT_OUTBOX_DISPATCHER: baseEnv.CALLAGENT_OUTBOX_DISPATCHER ?? 'hatchet',
        CALLAGENT_WORKSPACES: callagentWorkspaces,
        MCP_TOOL_CALL_TIMEOUT_MS:
            baseEnv.MCP_TOOL_CALL_TIMEOUT_MS ?? DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS,
    };
}
