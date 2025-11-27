import { jest } from '@jest/globals';

jest.mock('@prisma/client', () => {
    return {
        PrismaClient: jest.fn().mockImplementation((opts: any) => ({ opts }))
    };
});

describe('getChatPrismaClient', () => {
    const original = process.env.CHAT_DATABASE_URL;

    afterEach(() => {
        process.env.CHAT_DATABASE_URL = original;
    });

    it('returns singleton and uses CHAT_DATABASE_URL override', async () => {
        process.env.CHAT_DATABASE_URL = 'postgres://example';
        const { PrismaClient } = jest.requireMock('@prisma/client') as any;
        const mockCtor = PrismaClient as jest.Mock;
        const mod = await import('../src/prisma/client.js');
        const first = mod.getChatPrismaClient();
        const second = mod.getChatPrismaClient();
        expect(first).toBe(second);
        expect(mockCtor).toHaveBeenCalledWith(expect.objectContaining({ datasources: { db: { url: 'postgres://example' } } }));
        expect(mockCtor).toHaveBeenCalledTimes(1);
    });
});
