import { A2AService, globalA2AService } from '../src/core/orchestration/A2AService.js';
import { InteractiveTaskHandler } from '../src/core/orchestration/InteractiveTaskResult.js';

describe('A2AService Simple Tests', () => {
    describe('constructor', () => {
        it('should create A2AService instance', () => {
            const service = new A2AService();
            expect(service).toBeInstanceOf(A2AService);
        });

        it('should create A2AService with eventBus', () => {
            const mockEventBus = {};
            const service = new A2AService(mockEventBus);
            expect(service).toBeInstanceOf(A2AService);
        });
    });

    describe('globalA2AService', () => {
        it('should export global singleton instance', () => {
            expect(globalA2AService).toBeInstanceOf(A2AService);
        });

        it('should return same instance on multiple accesses', () => {
            const instance1 = globalA2AService;
            const instance2 = globalA2AService;
            expect(instance1).toBe(instance2);
        });
    });

    describe('findLocalAgent', () => {
        it('should handle non-existent agent gracefully', async () => {
            const service = new A2AService();

            // This will return null since no agents are registered in test environment
            const agent = await service.findLocalAgent('nonexistent-agent');
            expect(agent).toBeNull();
        });
    });

    describe('InteractiveTaskHandler integration', () => {
        it('should create InteractiveTaskHandler correctly', () => {
            const taskId = 'test-task-123';
            const targetAgent = 'test-agent';

            const handler = new InteractiveTaskHandler(taskId, targetAgent);
            expect(handler).toBeInstanceOf(InteractiveTaskHandler);
        });

        it('should handle completion flow', async () => {
            const handler = new InteractiveTaskHandler('test-task', 'test-agent');

            // Initially not completed
            let status = await handler.getStatus();
            expect(status.state).toBe('working');

            // Mark as completed
            const result = { success: true };
            handler.markCompleted(result);

            // Should now be completed
            status = await handler.getStatus();
            expect(status.state).toBe('completed');

            // Should return the result
            const completionResult = await handler.waitForCompletion();
            expect(completionResult).toEqual(result);
        });
    });

    describe('type compatibility', () => {
        it('should implement IA2AService interface', () => {
            const service = new A2AService();

            // Check that required methods exist
            expect(typeof service.sendTaskToAgent).toBe('function');
            expect(typeof service.findLocalAgent).toBe('function');
        });
    });
}); 