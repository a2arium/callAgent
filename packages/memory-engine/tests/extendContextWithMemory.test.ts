import { jest, describe, it, expect } from '@jest/globals';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

// Mocking dependencies
const mockMemorySQLAdapter = jest.fn();
const mockWorkingMemorySQLAdapter = jest.fn();

await jest.unstable_mockModule('@a2arium/callagent-memory-sql', () => ({
    MemorySQLAdapter: mockMemorySQLAdapter,
    WorkingMemorySQLAdapter: mockWorkingMemorySQLAdapter
}));

await jest.unstable_mockModule('@prisma/client', () => ({
    PrismaClient: jest.fn(() => ({ $connect: jest.fn() }))
}));

// Import module after mocks
const { extendContextWithMemory } = await import('../src/types/working/context/workingMemoryContext.js');

describe('extendContextWithMemory', () => {
    it('should auto-instantiate both adapters when prisma client is provided', async () => {
        const mockPrisma = { isMock: true };
        const baseContext: any = {};
        const tenantId = 'test-tenant';
        const agentId = 'test-agent';
        const agentConfig = { memory: { profile: 'basic' } };

        await extendContextWithMemory(
            baseContext,
            tenantId,
            agentId,
            agentConfig,
            undefined, // No semantic adapter
            mockPrisma // But we have prisma
        );

        // Verify Working Memory Adapter was created with Prisma
        expect(mockWorkingMemorySQLAdapter).toHaveBeenCalledWith(mockPrisma, expect.anything());

        // Verify Semantic Memory Adapter was created with Prisma
        expect(mockMemorySQLAdapter).toHaveBeenCalledWith(expect.objectContaining({
            prismaClient: mockPrisma
        }));
    });
});
