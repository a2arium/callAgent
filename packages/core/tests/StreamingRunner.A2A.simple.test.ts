import { globalA2AService } from '../src/core/orchestration/A2AService.js';

describe('StreamingRunner A2A Integration', () => {
    describe('globalA2AService availability', () => {
        it('should have globalA2AService available for import', () => {
            expect(globalA2AService).toBeDefined();
            expect(typeof globalA2AService.sendTaskToAgent).toBe('function');
            expect(typeof globalA2AService.findLocalAgent).toBe('function');
        });
    });

    describe('A2A service integration', () => {
        it('should be able to call A2A service methods', async () => {
            // Test that the service methods exist and can be called
            const agent = await globalA2AService.findLocalAgent('nonexistent-agent');
            expect(agent).toBeNull(); // Should return null for non-existent agent
        });
    });

    describe('type compatibility', () => {
        it('should have correct method signatures', () => {
            // Verify that the service has the expected interface
            expect(globalA2AService).toHaveProperty('sendTaskToAgent');
            expect(globalA2AService).toHaveProperty('findLocalAgent');

            // Check that methods are functions
            expect(typeof globalA2AService.sendTaskToAgent).toBe('function');
            expect(typeof globalA2AService.findLocalAgent).toBe('function');
        });
    });
}); 