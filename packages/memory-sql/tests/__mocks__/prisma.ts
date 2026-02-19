import { jest } from '@jest/globals';
import { mockDeep, mockReset, type DeepMockProxy } from 'jest-mock-extended';
import { PrismaClient } from '../../src/generated/prisma/index.js';
import type { PrismaClient as PrismaClientType } from '../../src/generated/prisma/index.js';
// Removed const { PrismaClient } = PrismaClientPkg;

// Create a deep mock of PrismaClient
export const prismaMock = mockDeep<PrismaClientType>() as DeepMockProxy<PrismaClientType>;

// Reset mocks before each test
beforeEach(() => {
    mockReset(prismaMock);
}); 