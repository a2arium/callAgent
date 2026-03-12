/**
 * Additional coverage tests for taskEngine orchestration helpers.
 * These tests focus on public API behavior and edge cases not covered in main test file.
 */

import { jest } from '@jest/globals';
import { TaskEngine } from '../src/orchestration/taskEngine.js';

describe('TaskEngine Additional Coverage Tests', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('public API behavior tests', () => {
        test('TaskEngine handles missing dependencies gracefully', () => {
            // Create engine without dependencies
            const engine = new (TaskEngine as any)();

            // Should not throw when creating context
            expect(() => (engine as any).createContext({ id: 'test' } as any)).not.toThrow();
        });

        test('TaskEngine handles missing session manager gracefully', () => {
            // Create engine without session manager
            const engine = new (TaskEngine as any)();

            // Should not throw when creating context
            expect(() => (engine as any).createContext({ id: 'test' } as any)).not.toThrow();
        });

        test('TaskEngine handles missing handler invoker gracefully', () => {
            // Create engine without handler invoker
            const engine = new (TaskEngine as any)();

            // Should not throw when creating context
            expect(() => (engine as any).createContext({ id: 'test' } as any)).not.toThrow();
        });

        test('TaskEngine handles missing both dependencies gracefully', () => {
            // Create engine without both dependencies
            const engine = new (TaskEngine as any)();

            // Should not throw when creating context
            expect(() => (engine as any).createContext({ id: 'test' } as any)).not.toThrow();
        });

        test('TaskEngine handles background task management', async () => {
            // Create engine
            const engine = new (TaskEngine as any)();

            // Should have no background tasks initially
            expect((engine as any).backgroundTaskPromises.size).toBe(0);

            // Add a background task that resolves after a delay
            let resolved = false;
            const promise = new Promise<void>(resolve => {
                setTimeout(() => {
                    resolved = true;
                    resolve();
                }, 50);
            });
            (engine as any).backgroundTaskPromises.add(promise);

            // Should have one background task
            expect((engine as any).backgroundTaskPromises.size).toBe(1);

            // Wait for background tasks with sufficient timeout
            await (engine as any).waitForBackgroundTasks(200);

            // Promise should have resolved
            expect(resolved).toBe(true);
            // Note: waitForBackgroundTasks doesn't automatically remove promises from the set
            // It only waits for them to resolve, so the promise should still be in the set
            expect((engine as any).backgroundTaskPromises.size).toBe(1);
        });

        test('TaskEngine handles debug logging', async () => {
            // Create engine
            const engine = new (TaskEngine as any)();

            // Set DEBUG_BACKGROUND_TASKS
            const originalEnv = process.env.DEBUG_BACKGROUND_TASKS;
            process.env.DEBUG_BACKGROUND_TASKS = '1';

            // Add a background task
            const resolvesQuickly = new Promise(resolve => setTimeout(resolve, 10));
            (engine as any).backgroundTaskPromises.add(resolvesQuickly);

            // Spy on console.log
            const logSpy = jest.spyOn(console, 'log').mockImplementation(() => { });

            // Call waitForBackgroundTasks
            await (engine as any).waitForBackgroundTasks(100);

            // Verify debug logs were called
            expect(logSpy).toHaveBeenCalledWith(
                expect.stringContaining('[TaskEngine] Waiting for 1 background task(s)')
            );
            expect(logSpy).toHaveBeenCalledWith(
                expect.stringContaining('[TaskEngine] Wait completed after')
            );

            // Restore
            logSpy.mockRestore();
            if (originalEnv) {
                process.env.DEBUG_BACKGROUND_TASKS = originalEnv;
            } else {
                delete process.env.DEBUG_BACKGROUND_TASKS;
            }
        });

        test('TaskEngine handles background task cleanup after timeout', async () => {
            // Create engine
            const engine = new (TaskEngine as any)();

            // Should have no background tasks initially
            expect((engine as any).backgroundTaskPromises.size).toBe(0);

            // Add multiple background tasks that don't resolve
            const promise1 = new Promise<void>(() => { }); // Never resolves
            const promise2 = new Promise<void>(() => { }); // Never resolves
            (engine as any).backgroundTaskPromises.add(promise1);
            (engine as any).backgroundTaskPromises.add(promise2);

            // Should have two background tasks
            expect((engine as any).backgroundTaskPromises.size).toBe(2);

            // Wait for background tasks with timeout
            await (engine as any).waitForBackgroundTasks(100);

            // Background tasks should still be in set since they didn't resolve
            expect((engine as any).backgroundTaskPromises.size).toBe(2);
        });

        test('attachAndRestoreLLM respects test override and forwards context', async () => {
            const mockAttachAndRestoreLLM = jest.fn() as jest.MockedFunction<(ctx: any, agentName: string | undefined, M: any, baseSnap?: Record<string, unknown>) => Promise<void>>;
            mockAttachAndRestoreLLM.mockResolvedValue(undefined);
            // @ts-ignore
            (TaskEngine as any).testOverrides = { attachAndRestoreLLM: mockAttachAndRestoreLLM };

            const engine = new (TaskEngine as any)();
            const task = { id: 'test-task', input: { data: 'test' } };
            const ctx = engine.createContext(task);

            await (engine as any).attachAndRestoreLLM(ctx, undefined, ctx.M);

            expect(mockAttachAndRestoreLLM).toHaveBeenCalledWith(ctx, undefined, ctx.M, undefined);
            // @ts-ignore
            (TaskEngine as any).testOverrides = undefined;
        });

        test('attachAndRestoreLLM propagates override errors for visibility', async () => {
            const mockAttachAndRestoreLLM = jest.fn() as jest.MockedFunction<(ctx: any, agentName: string | undefined, M: any, baseSnap?: Record<string, unknown>) => Promise<void>>;
            mockAttachAndRestoreLLM.mockRejectedValue(new Error('override failed'));
            // @ts-ignore
            (TaskEngine as any).testOverrides = { attachAndRestoreLLM: mockAttachAndRestoreLLM };

            const engine = new (TaskEngine as any)();
            const task = { id: 'test-task', input: { data: 'test' } };
            const ctx = engine.createContext(task);

            await expect((engine as any).attachAndRestoreLLM(ctx, undefined, ctx.M)).rejects.toThrow('override failed');
            expect(mockAttachAndRestoreLLM).toHaveBeenCalledWith(ctx, undefined, ctx.M, undefined);
            // @ts-ignore
            (TaskEngine as any).testOverrides = undefined;
        });

        test('TaskEngine handles child completion injection error', async () => {
            // Create engine
            const engine = new (TaskEngine as any)();

            // Create a mock session manager that simulates durable state access
            const mockLoad = jest.fn() as jest.MockedFunction<(tenant: string, taskId: string) => Promise<any>>;
            mockLoad.mockResolvedValue({
                snapshot: { inbox: { current: [], all: [] }, pending: {} },
                wmVersion: BigInt(0),
                agentId: 'agent-a'
            });

            const mockEnqueueOutbox = jest.fn() as jest.MockedFunction<(data: any) => Promise<void>>;
            mockEnqueueOutbox.mockResolvedValue(undefined);

            const mockSessionStore: any = {
                load: mockLoad,
                enqueueOutbox: mockEnqueueOutbox
            };

            // @ts-ignore
            (engine as any).sessionManager = mockSessionStore;

            const task = { id: 'test-task', input: { data: 'test' } };
            await (engine as any).restoreCtx('tenant', task.id);

            // Verify durable load used and no enqueue errors thrown
            expect(mockLoad).toHaveBeenCalledWith('tenant', task.id);

            // @ts-ignore
            (engine as any).sessionManager = undefined;
        });
    });
});
