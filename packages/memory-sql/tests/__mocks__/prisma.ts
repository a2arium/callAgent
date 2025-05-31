import { jest } from '@jest/globals';
import { mockDeep, mockReset, type DeepMockProxy } from 'jest-mock-extended';
import { PrismaClient } from '@prisma/client';

// Create a deep mock of PrismaClient
export const prismaMock = mockDeep<PrismaClient>() as DeepMockProxy<PrismaClient>;

// Reset mocks before each test
beforeEach(() => {
    mockReset(prismaMock);
}); 