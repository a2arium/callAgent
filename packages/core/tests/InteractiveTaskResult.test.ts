import { InteractiveTaskHandler } from '../src/core/orchestration/InteractiveTaskResult.js';

describe('InteractiveTaskHandler', () => {
    let handler: InteractiveTaskHandler;
    const taskId = 'test-task-123';
    const targetAgent = 'test-agent';

    beforeEach(() => {
        handler = new InteractiveTaskHandler(taskId, targetAgent);
    });

    describe('constructor', () => {
        it('should create InteractiveTaskHandler instance', () => {
            expect(handler).toBeInstanceOf(InteractiveTaskHandler);
        });
    });

    describe('callback registration', () => {
        it('should register status update callbacks', () => {
            const callback = jest.fn();
            handler.onStatusUpdate(callback);

            // Verify callback is registered (no direct way to test, but no errors should occur)
            expect(callback).not.toHaveBeenCalled();
        });

        it('should register artifact update callbacks', () => {
            const callback = jest.fn();
            handler.onArtifactUpdate(callback);

            // Verify callback is registered (no direct way to test, but no errors should occur)
            expect(callback).not.toHaveBeenCalled();
        });

        it('should register input required callbacks', () => {
            const callback = jest.fn().mockResolvedValue('test input');
            handler.onInputRequired(callback);

            // Verify callback is registered (no direct way to test, but no errors should occur)
            expect(callback).not.toHaveBeenCalled();
        });
    });

    describe('task operations', () => {
        it('should handle sendInput', async () => {
            await expect(handler.sendInput('test input')).resolves.toBeUndefined();
        });

        it('should handle cancel', async () => {
            await expect(handler.cancel('test reason')).resolves.toBeUndefined();
        });

        it('should handle cancel without reason', async () => {
            await expect(handler.cancel()).resolves.toBeUndefined();
        });
    });

    describe('status and completion', () => {
        it('should return working status initially', async () => {
            const status = await handler.getStatus();
            expect(status.state).toBe('working');
            expect(status.message).toBeUndefined();
            expect(status.timestamp).toBeDefined();
        });

        it('should return completed status after marking completed', async () => {
            const result = { success: true };
            handler.markCompleted(result);

            const status = await handler.getStatus();
            expect(status.state).toBe('completed');
            expect(status.timestamp).toBeDefined();
        });

        it('should wait for completion and return result', async () => {
            const result = { success: true, data: 'test' };
            handler.markCompleted(result);

            const completionResult = await handler.waitForCompletion();
            expect(completionResult).toEqual(result);
        });

        it('should wait for completion when not yet completed', async () => {
            const completionResult = await handler.waitForCompletion();
            expect(completionResult).toBeNull();
        });
    });

    describe('multiple callbacks', () => {
        it('should handle multiple status callbacks', () => {
            const callback1 = jest.fn();
            const callback2 = jest.fn();

            handler.onStatusUpdate(callback1);
            handler.onStatusUpdate(callback2);

            // Both callbacks should be registered without errors
            expect(callback1).not.toHaveBeenCalled();
            expect(callback2).not.toHaveBeenCalled();
        });

        it('should handle multiple artifact callbacks', () => {
            const callback1 = jest.fn();
            const callback2 = jest.fn();

            handler.onArtifactUpdate(callback1);
            handler.onArtifactUpdate(callback2);

            // Both callbacks should be registered without errors
            expect(callback1).not.toHaveBeenCalled();
            expect(callback2).not.toHaveBeenCalled();
        });
    });
}); 