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
            handleChildCompleted: jest.fn().mockResolvedValue(undefined),
            conversationService: {
                startThread: jest.fn().mockResolvedValue({
                    thread: { threadId: 'thread-1' },
                    receipt: { status: 'accepted', messageId: 'msg-1', sequenceNumber: 1 },
                }),
                send: jest.fn().mockResolvedValue({
                    status: 'accepted',
                    messageId: 'msg-1',
                    sequenceNumber: 1,
                }),
                close: jest.fn().mockResolvedValue(undefined),
            } as any,
        });
    });

    it('schedules non-blocking child starts through the runtime driver when start surface is enabled', async () => {
        const snapshots = new Map<string, { snapshot: Record<string, unknown>; wmVersion: bigint; agentId: string }>([
            ['s1', { snapshot: { pending: { tools: {} } }, wmVersion: BigInt(1), agentId: 'parent-agent' }],
        ]);
        mockSessionManager.load.mockImplementation(async (_tenantId, sessionId) => snapshots.get(sessionId) as any ?? null);
        mockSessionManager.saveSnapshot.mockImplementation(async (params: any) => {
            const current = snapshots.get(params.sessionId);
            const nextVersion = (current?.wmVersion ?? BigInt(0)) + BigInt(1);
            snapshots.set(params.sessionId, {
                snapshot: params.snapshot,
                wmVersion: nextVersion,
                agentId: current?.agentId ?? params.agentId,
            });
            return { newVersion: nextVersion };
        });
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
            conversationService: {
                startThread: jest.fn().mockResolvedValue({
                    thread: { threadId: 'thread-1' },
                    receipt: { status: 'accepted', messageId: 'msg-1', sequenceNumber: 1 },
                }),
                send: jest.fn().mockResolvedValue({
                    status: 'accepted',
                    messageId: 'msg-1',
                    sequenceNumber: 1,
                }),
                close: jest.fn().mockResolvedValue(undefined),
            } as any,
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
                awaitCompletion: false,
                cache: { enabled: true, ttlSeconds: 900, excludePaths: ['traceparent'] }
            });

            expect(result).toHaveProperty('token');
            expect(localA2ASpy).not.toHaveBeenCalled();
            expect(enqueueChildStart).toHaveBeenCalledWith(expect.objectContaining({
                tenantId: 't1',
                agentId: 'child-agent',
                input: { url: 'https://example.test' },
                cache: { enabled: true, ttlSeconds: 900, excludePaths: ['traceparent'] },
                token: result.token,
                traceId: 'trace-1'
            }));
            const scheduledTaskId = (enqueueChildStart.mock.calls[0]?.[0] as any)?.taskId;
            expect(typeof scheduledTaskId).toBe('string');
            expect(scheduledTaskId).toContain('a2a_s1_child-agent_');
            expect(mockSessionManager.appendEvent).toHaveBeenCalledWith(
                't1',
                's1',
                'task.child_started',
                expect.objectContaining({
                    childTaskId: scheduledTaskId,
                    inputPreview: { url: 'https://example.test' },
                })
            );
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

    it('redacts and bounds sync child completion result previews', async () => {
        const html = `<html>${'x'.repeat(80 * 1024)}</html>`;
        let durableSnapshot: Record<string, unknown> = { pending: { tools: {} } };
        mockSessionManager.load.mockImplementation(async () => ({
            snapshot: durableSnapshot,
            wmVersion: BigInt(1),
            agentId: 'parent-agent',
            updatedAt: new Date().toISOString(),
        }));
        mockSessionManager.saveSnapshot.mockImplementation(async (params: any) => {
            durableSnapshot = params.snapshot;
            return { newVersion: params.expectedWmVersion + BigInt(1) };
        });
        const sendSpy = jest.spyOn(globalA2AService, 'sendTaskToAgent').mockResolvedValue({
            id: 'child-task-1',
            status: {
                state: 'completed',
                timestamp: new Date().toISOString(),
                metadata: {
                    result: {
                        ok: true,
                        data: {
                            html: {
                                kind: 'artifact_local',
                                value: html,
                                mimeType: 'text/html',
                            },
                            content: html,
                            statusCode: 200,
                        },
                    },
                },
            },
        } as any);
        const ctx: any = {
            task: { id: 's1', input: {} },
            tenantId: 't1',
            agentId: 'parent-agent',
        };

        try {
            await apiBinder.attachOrchestrationAPIs(ctx, {
                tenantId: 't1',
                sessionId: 's1',
                agentId: 'parent-agent',
                flushMentalState: jest.fn(),
            });

            await ctx.sendTaskToAgent('child-agent', { url: 'https://example.test' });

            const childCompletedCall = mockSessionManager.appendEvent.mock.calls.find(
                (call) => call[2] === 'task.child_completed'
            );
            expect(childCompletedCall).toBeDefined();
            const payload = childCompletedCall?.[3] as any;
            expect(payload.result.data.html).toEqual(expect.objectContaining({
                state: 'artifact_only',
                mimeType: 'text/html',
            }));
            expect(payload.result.data.content).toBe(`[html/text truncated, ${html.length} chars]`);
            expect(payload.resultPreview.data.html).toEqual(expect.objectContaining({
                state: 'artifact_only',
                artifactId: 'local',
                mimeType: 'text/html',
            }));
            expect(payload.resultPreview.data.content).toBe(`[html/text truncated, ${html.length} chars]`);
            expect(JSON.stringify(payload)).not.toContain(html);
        } finally {
            sendSpy.mockRestore();
        }
    });

    it('persists a terminal child execution failure as child.failed', async () => {
        let durableSnapshot: Record<string, unknown> = { pending: { tools: {} } };
        let durableVersion = BigInt(1);
        mockSessionManager.load.mockImplementation(async () => ({
            snapshot: durableSnapshot,
            wmVersion: durableVersion,
            agentId: 'parent-agent',
            updatedAt: new Date().toISOString(),
        }));
        mockSessionManager.saveSnapshot.mockImplementation(async (params: any) => {
            durableSnapshot = params.snapshot;
            durableVersion = params.expectedWmVersion + BigInt(1);
            return { newVersion: durableVersion };
        });
        const sendSpy = jest.spyOn(globalA2AService, 'sendTaskToAgent').mockResolvedValue({
            id: 'child-task-failed',
            status: {
                state: 'failed',
                timestamp: new Date().toISOString(),
                metadata: {
                    error: { code: 'BROWSER_FAILED', message: 'browser unavailable' },
                },
            },
        } as any);
        const ctx: any = {
            task: { id: 's1', input: {} },
            tenantId: 't1',
            agentId: 'parent-agent',
        };

        try {
            await apiBinder.attachOrchestrationAPIs(ctx, {
                tenantId: 't1',
                sessionId: 's1',
                agentId: 'parent-agent',
                flushMentalState: jest.fn(),
            });

            const { token } = await ctx.sendTaskToAgent('child-agent', { url: 'https://example.test' });

            const failedEvent = mockSessionManager.appendEvent.mock.calls.find(
                (call) => call[2] === 'task.child_failed'
            );
            expect(failedEvent?.[3]).toEqual(expect.objectContaining({
                token,
                childTaskId: 'child-task-failed',
                error: { code: 'BROWSER_FAILED', message: 'browser unavailable' },
            }));
            expect((durableSnapshot as any).pending.tasks).not.toHaveProperty(token);
            expect((durableSnapshot as any).pending.childTerminals[token]).toEqual(
                expect.objectContaining({
                    kind: 'failed',
                    error: { code: 'BROWSER_FAILED', message: 'browser unavailable' },
                })
            );
        } finally {
            sendSpy.mockRestore();
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
        // Inline execution now claims the active owner lifecycle before invoking the provider.
        expect(mockSessionManager.saveSnapshot).toHaveBeenCalledTimes(1);
        expect(mockSessionManager.appendEvent).not.toHaveBeenCalled();
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
        expect(mockSessionManager.saveSnapshot).toHaveBeenCalledTimes(1); // lifecycle gate only; handler is not persisted
    });

    it('rejects tools under a detached owner before events or provider invocation', async () => {
        mockSessionManager.load.mockResolvedValue({
            snapshot: {
                meta: {
                    taskLifecycle: {
                        taskId: 's1',
                        rootTaskId: 's1',
                        ancestorTaskIds: [],
                        state: 'detached',
                        reason: 'child_timeout',
                    },
                },
                pending: { tools: {} },
            },
            wmVersion: BigInt(2),
            agentId: 'a1',
        } as any);
        const provider = jest.fn().mockResolvedValue('must-not-run');
        const ctx: any = {
            tools: { invoke: provider },
            __autoExecuteTool: provider,
        };
        await apiBinder.attachOrchestrationAPIs(ctx, {
            tenantId: 't1',
            sessionId: 's1',
            agentId: 'a1',
            flushMentalState: jest.fn(),
        });

        await expect(ctx.requestTool('slow_tool', {}, { awaitCompletion: false }))
            .rejects.toMatchObject({ code: 'TASK_LIFECYCLE_TERMINAL' });
        expect(provider).not.toHaveBeenCalled();
        expect(mockSessionManager.saveSnapshot).not.toHaveBeenCalled();
        expect(mockSessionManager.appendEvent).not.toHaveBeenCalled();
    });

    it('rejects single and grouped children under a detached owner before dispatch', async () => {
        mockSessionManager.load.mockResolvedValue({
            snapshot: {
                meta: {
                    taskLifecycle: {
                        taskId: 's1',
                        rootTaskId: 's1',
                        ancestorTaskIds: [],
                        state: 'completed',
                        reason: 'task_completed',
                    },
                },
                pending: { tasks: {}, groups: {} },
            },
            wmVersion: BigInt(2),
            agentId: 'a1',
        } as any);
        const dispatch = jest.spyOn(globalA2AService, 'sendTaskToAgent');
        const ctx: any = { task: { id: 's1', input: {} }, tenantId: 't1', agentId: 'a1' };
        await apiBinder.attachOrchestrationAPIs(ctx, {
            tenantId: 't1',
            sessionId: 's1',
            agentId: 'a1',
            flushMentalState: jest.fn(),
        });

        try {
            await expect(ctx.sendTaskToAgent('child-a', {}, { awaitCompletion: false }))
                .rejects.toMatchObject({ code: 'TASK_LIFECYCLE_TERMINAL' });
            await expect(ctx.allTasks([{ agent: 'child-a', input: {} }]))
                .rejects.toMatchObject({ code: 'TASK_LIFECYCLE_TERMINAL' });
            expect(dispatch).not.toHaveBeenCalled();
            expect(mockSessionManager.saveSnapshot).not.toHaveBeenCalled();
            expect(mockSessionManager.appendEvent).not.toHaveBeenCalled();
        } finally {
            dispatch.mockRestore();
        }
    });

    it('commits grouped children and group metadata before dispatching any child', async () => {
        const snapshots = new Map<string, { snapshot: Record<string, unknown>; wmVersion: bigint; agentId: string }>([
            ['s1', { snapshot: { meta: { agentId: 'a1' }, pending: {} }, wmVersion: BigInt(1), agentId: 'a1' }],
        ]);
        mockSessionManager.load.mockImplementation(async (_tenantId, sessionId) => snapshots.get(sessionId) as any ?? null);
        mockSessionManager.saveSnapshot.mockImplementation(async (params: any) => {
            const current = snapshots.get(params.sessionId);
            const nextVersion = (current?.wmVersion ?? BigInt(0)) + BigInt(1);
            snapshots.set(params.sessionId, {
                snapshot: params.snapshot,
                wmVersion: nextVersion,
                agentId: current?.agentId ?? params.agentId,
            });
            return { newVersion: nextVersion };
        });
        const dispatch = jest.spyOn(globalA2AService, 'sendTaskToAgent').mockImplementation(async () => {
            const parent = snapshots.get('s1')!.snapshot as any;
            expect(Object.keys(parent.pending.tasks)).toHaveLength(2);
            expect(Object.values(parent.pending.groups)[0]).toEqual(expect.objectContaining({
                childTokens: expect.arrayContaining(Object.keys(parent.pending.tasks)),
            }));
            return { status: { state: 'working' } } as any;
        });
        const ctx: any = { task: { id: 's1', input: {} }, tenantId: 't1', agentId: 'a1' };
        await apiBinder.attachOrchestrationAPIs(ctx, {
            tenantId: 't1',
            sessionId: 's1',
            agentId: 'a1',
            flushMentalState: jest.fn(),
        });

        try {
            const handle = await ctx.allTasks([
                { agent: 'child-a', input: { n: 1 } },
                { agent: 'child-b', input: { n: 2 } },
            ], { onAllCompleted: 'done' });
            expect(handle).toBeDefined();
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(dispatch).toHaveBeenCalledTimes(2);
            const linkedChildren = [...snapshots.entries()].filter(([taskId]) => taskId !== 's1');
            expect(linkedChildren).toHaveLength(2);
            for (const [, child] of linkedChildren) {
                expect((child.snapshot as any).meta.a2aParent.parentTaskId).toBe('s1');
            }
        } finally {
            dispatch.mockRestore();
        }
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

    it('redacts persisted async tool request previews without changing pending execution args', async () => {
        const mockTools = { invoke: jest.fn() };
        const ctx: any = { tools: mockTools };
        const args = {
            url: 'https://example.test',
            env_vars: {
                OPENAI_API_KEY: 'sk-secret-value-that-should-not-persist',
                BROWSER_USE_API_KEY: 'bu_secret-value-that-should-not-persist',
            },
            prompt: 'Use Bearer abcdefghijklmnopqrstuvwxyz123456 for nothing',
        };

        let savedSnapshot: any;
        mockSessionManager.saveSnapshot.mockImplementation(async (params: any) => {
            savedSnapshot = params.snapshot;
            return { newVersion: BigInt(2) };
        });

        await apiBinder.attachOrchestrationAPIs(ctx, { tenantId: 't1', sessionId: 's1', agentId: 'a1', flushMentalState: jest.fn() });

        const result = await ctx.requestTool('mcp:browser-use.navigate_and_extract', args, { awaitCompletion: false });

        expect(savedSnapshot.pending.tools[result.token].args).toEqual(args);
        expect(mockSessionManager.appendEvent).toHaveBeenCalledWith(
            't1',
            's1',
            'task.tool_requested',
            expect.objectContaining({
                token: result.token,
                argsPreview: {
                    url: 'https://example.test',
                    env_vars: {
                        OPENAI_API_KEY: '[redacted]',
                        BROWSER_USE_API_KEY: '[redacted]',
                    },
                    prompt: 'Use [redacted] for nothing',
                },
            })
        );
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
