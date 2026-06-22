import { TaskEngine } from '../src/orchestration/taskEngine';
import { ApiBinder } from '../src/orchestration/api/ApiBinder';
import { globalA2AService } from '../src/orchestration/A2AService';
import { SessionManager } from '../src/orchestration/SessionManager';
import { v4 as uuidv4 } from 'uuid';
import { jest } from '@jest/globals';

describe('ApiBinder.requestTool unified API', () => {
    let apiBinder: ApiBinder;
    let mockSessionManager: jest.Mocked<SessionManager>;
    let mockTaskEngine: Partial<TaskEngine>;

    beforeEach(() => {
        mockSessionManager = {
            load: jest.fn().mockResolvedValue({
                snapshot: {
                    pending: { tools: {} }
                },
                wmVersion: BigInt(1)
            }),
            saveSnapshot: jest.fn().mockResolvedValue({ newVersion: BigInt(2) }),
            appendEvent: jest.fn().mockResolvedValue({ eventId: 'evt-1', seq: 1 }),
            enqueueOutbox: jest.fn().mockResolvedValue(undefined),
            listEventsSince: jest.fn()
        } as unknown as jest.Mocked<SessionManager>;

        mockTaskEngine = {
            handleToolCompleted: jest.fn().mockResolvedValue(true)
        };

        apiBinder = new ApiBinder({
            sessionManager: mockSessionManager,
            snapshotRepo: {
                saveWithRetry: jest.fn(async (opts: any) => {
                    const session = await mockSessionManager.load('t1', 's1');
                    const baseSnap = session?.snapshot || {};
                    const nextSnap = await opts.mutate(baseSnap);
                    await mockSessionManager.saveSnapshot({
                        tenantId: opts.tenantId,
                        sessionId: opts.sessionId,
                        agentId: opts.agentId || 'default',
                        expectedWmVersion: BigInt(1), // dummy for test
                        snapshot: nextSnap
                    });
                })
            } as any,
            getTraceContext: () => ({}),
            getSessionStorePrisma: () => null,
            taskCreationMutex: { runExclusive: jest.fn((key, fn) => fn()) } as any,
            backgroundTaskPromises: new Set(),
            handleChildCompleted: jest.fn().mockResolvedValue(undefined)
        });
    });

    it('schedules non-blocking child starts through the runtime driver when start surface is enabled', async () => {
        process.env.CALLAGENT_DRIVER_SURFACES = 'start,resume';
        const enqueueChildStart = jest.fn().mockResolvedValue(undefined);
        const localA2ASpy = jest
            .spyOn(globalA2AService, 'sendTaskToAgent')
            .mockRejectedValue(new Error('local A2A should not run'));

        apiBinder = new ApiBinder({
            sessionManager: mockSessionManager,
            snapshotRepo: {
                saveWithRetry: jest.fn(async (opts: any) => {
                    const session = await mockSessionManager.load('t1', 's1');
                    const baseSnap = session?.snapshot || {};
                    const nextSnap = await opts.mutate(baseSnap);
                    await mockSessionManager.saveSnapshot({
                        tenantId: opts.tenantId,
                        sessionId: opts.sessionId,
                        agentId: opts.agentId || 'default',
                        expectedWmVersion: BigInt(1),
                        snapshot: nextSnap
                    });
                })
            } as any,
            getTraceContext: () => ({}),
            getSessionStorePrisma: () => null,
            taskCreationMutex: { runExclusive: jest.fn((key, fn) => fn()) } as any,
            backgroundTaskPromises: new Set(),
            handleChildCompleted: jest.fn().mockResolvedValue(undefined),
            enqueueChildStart
        });

        const ctx: any = {
            task: { id: 's1', input: {} },
            tenantId: 't1',
            agentId: 'parent-agent',
            telemetry: { traceId: 'trace-1', nodeId: 'node-1' }
        };

        try {
            await apiBinder.attachOrchestrationAPIs(ctx, {
                tenantId: 't1',
                sessionId: 's1',
                agentId: 'parent-agent',
                flushMentalState: jest.fn()
            });

            const result = await ctx.sendTaskToAgent('child-agent', { url: 'https://example.test' }, {
                awaitCompletion: false
            });

            expect(result).toHaveProperty('token');
            expect(localA2ASpy).not.toHaveBeenCalled();
            expect(enqueueChildStart).toHaveBeenCalledWith(expect.objectContaining({
                tenantId: 't1',
                agentId: 'child-agent',
                input: { url: 'https://example.test' },
                token: result.token,
                traceId: 'trace-1'
            }));
            const scheduledTaskId = (enqueueChildStart.mock.calls[0]?.[0] as any)?.taskId;
            expect(typeof scheduledTaskId).toBe('string');
            expect(scheduledTaskId).toContain('a2a_s1_child-agent_');
            expect(mockSessionManager.saveSnapshot).toHaveBeenCalledWith(expect.objectContaining({
                tenantId: 't1',
                sessionId: scheduledTaskId,
                agentId: 'child-agent',
                snapshot: expect.objectContaining({
                    meta: expect.objectContaining({
                        agentId: 'child-agent',
                        a2aParent: {
                            parentTenantId: 't1',
                            parentTaskId: 's1',
                            parentChildToken: result.token
                        }
                    })
                })
            }));
        } finally {
            delete process.env.CALLAGENT_DRIVER_SURFACES;
            localA2ASpy.mockRestore();
        }
    });

    it('should execute regular tool inline when awaitCompletion is true', async () => {
        const mockTools = {
            invoke: jest.fn().mockResolvedValue('inline-result')
        };
        const ctx: any = {
            tools: mockTools
        };

        await apiBinder.attachOrchestrationAPIs(ctx, { tenantId: 't1', sessionId: 's1', agentId: 'a1', flushMentalState: jest.fn() });

        const result = await ctx.requestTool('my_tool', { arg: 1 }, { awaitCompletion: true });

        expect(mockTools.invoke).toHaveBeenCalledWith('my_tool', { arg: 1 });
        expect(result).toBe('inline-result');
        // Should not save snapshot or emit event for inline execution
        expect(mockSessionManager.saveSnapshot).not.toHaveBeenCalled();
    });

    it('should auto-execute regular tool when awaitCompletion is false', async () => {
        const mockTools = {
            invoke: jest.fn().mockResolvedValue('async-result')
        };
        const ctx: any = {
            tools: mockTools
        };

        // Attach auto-executor simulate TaskEngine.createContext mapping
        ctx.__autoExecuteTool = async (tId: string, sId: string, token: string, toolName: string, args: unknown) => {
            try {
                const res = await ctx.tools.invoke(toolName, args);
                await mockTaskEngine.handleToolCompleted!({ tenantId: tId, taskId: sId, token, result: res });
            } catch (err) {
                // error handling
            }
        };

        await apiBinder.attachOrchestrationAPIs(ctx, { tenantId: 't1', sessionId: 's1', agentId: 'a1', flushMentalState: jest.fn() });

        const result = await ctx.requestTool('my_tool', { arg: 1 }, { awaitCompletion: false });

        expect(result).toHaveProperty('token');

        // Wait a tick for autoExecuteTool to run
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(mockTools.invoke).toHaveBeenCalledWith('my_tool', { arg: 1 });
        expect(mockTaskEngine.handleToolCompleted).toHaveBeenCalledWith({
            tenantId: 't1',
            taskId: 's1',
            token: result.token,
            result: 'async-result'
        });

        // Should persist pending tool state
        expect(mockSessionManager.saveSnapshot).toHaveBeenCalled();
        expect(mockSessionManager.appendEvent).toHaveBeenCalledWith(
            't1', 's1', 'task.tool_requested', expect.objectContaining({ toolName: 'my_tool' })
        );
    });

    it('should delegate to LLM adapter for MCP tool inline when awaitCompletion is true', async () => {
        const mockLlm = {
            callMcpTool: jest.fn().mockResolvedValue('mcp-inline-result')
        };
        const ctx: any = {
            llm: mockLlm,
            tools: { invoke: jest.fn() } // should not be called
        };

        await apiBinder.attachOrchestrationAPIs(ctx, { tenantId: 't1', sessionId: 's1', agentId: 'a1', flushMentalState: jest.fn() });

        const result = await ctx.requestTool('mcp:server.tool', { arg: 2 }, { awaitCompletion: true });

        expect(mockLlm.callMcpTool).toHaveBeenCalledWith('server', 'tool', { arg: 2 });
        expect(ctx.tools.invoke).not.toHaveBeenCalled();
        expect(result).toBe('mcp-inline-result');
    });

    it('should auto-execute MCP tool when awaitCompletion is false', async () => {
        const mockLlm = {
            callMcpTool: jest.fn().mockResolvedValue('mcp-async-result')
        };
        const ctx: any = {
            llm: mockLlm,
            tools: { invoke: jest.fn() }
        };

        // Attach auto-executor simulate TaskEngine.createContext mapping
        ctx.__autoExecuteTool = async (tId: string, sId: string, token: string, toolName: string, args: unknown) => {
            let res;
            if (toolName.startsWith('mcp:')) {
                const parts = toolName.slice(4).split('.');
                res = await ctx.llm.callMcpTool(parts[0], parts.slice(1).join('.'), args);
            }
            await mockTaskEngine.handleToolCompleted!({ tenantId: tId, taskId: sId, token, result: res });
        };

        await apiBinder.attachOrchestrationAPIs(ctx, { tenantId: 't1', sessionId: 's1', agentId: 'a1', flushMentalState: jest.fn() });

        const result = await ctx.requestTool('mcp:server.tool', { arg: 2 }, { awaitCompletion: false });

        expect(result).toHaveProperty('token');

        // Wait a tick for autoExecuteTool to run
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(mockLlm.callMcpTool).toHaveBeenCalledWith('server', 'tool', { arg: 2 });
        expect(mockTaskEngine.handleToolCompleted).toHaveBeenCalledWith({
            tenantId: 't1',
            taskId: 's1',
            token: result.token,
            result: 'mcp-async-result'
        });
    });

    it('should handle onCompleted binding correctly during sync execution', async () => {
        // If awaitCompletion: true, it should ignore onCompleted since it returns directly inline
        const mockTools = {
            invoke: jest.fn().mockResolvedValue('inline')
        };
        const ctx: any = { tools: mockTools };

        await apiBinder.attachOrchestrationAPIs(ctx, { tenantId: 't1', sessionId: 's1', agentId: 'a1', flushMentalState: jest.fn() });

        const result = await ctx.requestTool('my_tool', { arg: 1 }, { awaitCompletion: true, onCompleted: 'myHandler' });

        expect(result).toBe('inline');
        expect(mockSessionManager.saveSnapshot).not.toHaveBeenCalled(); // Handler is not persisted
    });

    it('should handle onCompleted binding correctly during async execution', async () => {
        const mockTools = { invoke: jest.fn() };
        const ctx: any = { tools: mockTools };

        let savedSnapshot: any;
        mockSessionManager.saveSnapshot.mockImplementation(async (args: any) => {
            savedSnapshot = args.snapshot;
            return { newVersion: BigInt(2) };
        });

        await apiBinder.attachOrchestrationAPIs(ctx, { tenantId: 't1', sessionId: 's1', agentId: 'a1', flushMentalState: jest.fn() });

        const result = await ctx.requestTool('my_tool', { arg: 1 }, { awaitCompletion: false, onCompleted: 'myHandler' });

        expect(result).toHaveProperty('token');

        // Assert the handler string was saved in the pending list
        const pend = savedSnapshot.pending.tools[result.token];
        expect(pend).toBeDefined();
        expect(pend.handlers.completed).toBe('myHandler');
    });

    it('should be backwards compatible without awaitCompletion flag', async () => {
        const mockTools = { invoke: jest.fn() };
        const ctx: any = { tools: mockTools };

        await apiBinder.attachOrchestrationAPIs(ctx, { tenantId: 't1', sessionId: 's1', agentId: 'a1', flushMentalState: jest.fn() });

        // Should default to awaitCompletion: false
        const result = await ctx.requestTool('my_tool', { arg: 1 });

        expect(result).toHaveProperty('token');
        expect(mockSessionManager.saveSnapshot).toHaveBeenCalled();
        expect(mockTools.invoke).not.toHaveBeenCalled();
    });
});
