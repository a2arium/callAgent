import { jest } from '@jest/globals';
import { mockDeep, mockReset, type DeepMockProxy } from 'jest-mock-extended';
import PrismaClientPkg from '@prisma/client';
import type { PrismaClient as PrismaClientType } from '@prisma/client';
const { PrismaClient } = PrismaClientPkg;

// Create a deep mock of PrismaClient
export const prismaMock = mockDeep<PrismaClientType>() as DeepMockProxy<PrismaClientType>;

// Reset mocks before each test
beforeEach(() => {
    mockReset(prismaMock);
}); 