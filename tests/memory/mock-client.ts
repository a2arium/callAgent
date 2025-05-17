import { PrismaClient } from '../../src/generated/prisma/index.js';
import { mockDeep, mockReset, DeepMockProxy } from 'jest-mock-extended';

// Create a single mock instance of Prisma Client
export const prismaMock = mockDeep<PrismaClient>() as DeepMockProxy<PrismaClient>;

// Reset mocks before each test
beforeEach(() => {
    mockReset(prismaMock);
}); 