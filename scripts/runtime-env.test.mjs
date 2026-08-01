import assert from 'node:assert/strict';
import test from 'node:test';
import {
    buildRuntimeEnvironment,
    DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS,
    resolveRuntimeWorkspacePath,
} from './runtime-env.mjs';

test('runtime gives long-running MCP browser tools five minutes by default', () => {
    const env = buildRuntimeEnvironment({}, '/repo/.callagent/workspaces.json');

    assert.equal(env.MCP_TOOL_CALL_TIMEOUT_MS, '300000');
    assert.equal(env.MCP_TOOL_CALL_TIMEOUT_MS, DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS);
});

test('workspace registry paths resolve from the invoking thin workspace', () => {
    assert.equal(
        resolveRuntimeWorkspacePath('.callagent/workspaces.json', '/work/itupdated'),
        '/work/itupdated/.callagent/workspaces.json',
    );
    assert.equal(
        resolveRuntimeWorkspacePath('/shared/workspaces.json', '/work/itupdated'),
        '/shared/workspaces.json',
    );
});

test('runtime preserves an explicit MCP tool timeout override', () => {
    const env = buildRuntimeEnvironment(
        { MCP_TOOL_CALL_TIMEOUT_MS: '120000' },
        '/repo/.callagent/workspaces.json',
    );

    assert.equal(env.MCP_TOOL_CALL_TIMEOUT_MS, '120000');
});
