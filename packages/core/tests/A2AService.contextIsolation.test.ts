import { jest } from '@jest/globals';

const { A2AService } = await import('../src/orchestration/A2AService.js');

describe('A2AService context isolation', () => {
    it('does not inherit parent async tool executor into child target context', async () => {
        const service = new A2AService();
        const parentAutoExecuteTool = jest.fn();
        const sourceCtx = {
            tenantId: 'default',
            agentId: 'parent-agent',
            task: { id: 'parent-task', input: {} },
            __autoExecuteTool: parentAutoExecuteTool,
            llm: { callMcpTool: jest.fn() },
            tools: { invoke: jest.fn() },
            memory: {},
        };
        const plugin = {
            resolved: {
                agentCard: { name: 'child-agent', version: '1.0.0' },
                runtimeManifest: { name: 'child-agent', version: '1.0.0' },
            },
        };

        const targetCtx = await (service as any).createTargetContext(
            sourceCtx,
            plugin,
            { value: 1 },
            { tenantId: 'default' },
            {}
        );

        expect(targetCtx.__autoExecuteTool).toBeUndefined();
        expect(targetCtx.__activeLoopInbox).toBeUndefined();
        expect(targetCtx.__activeLoopEnv).toBeUndefined();
        expect(targetCtx.task.id).toMatch(/^a2a_parent-task_child-agent_/);
    });
});
