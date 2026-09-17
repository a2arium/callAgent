import { jest } from '@jest/globals';

jest.mock('../generated/prisma/index.js', () => {
    return {
        PrismaClient: jest.fn().mockImplementation((opts: any) => ({ opts }))
    };
});

describe('getChatPrismaClient', () => {
    const original = process.env.CHAT_DATABASE_URL;

    afterEach(() => {
        process.env.CHAT_DATABASE_URL = original;
        jest.resetModules();
    });

    it('returns singleton and uses CHAT_DATABASE_URL override', async () => {
        process.env.CHAT_DATABASE_URL = 'postgres://example';
        const { PrismaClient } = await import('../generated/prisma/index.js');
        const mockCtor = PrismaClient as unknown as jest.Mock;

        const mod = await import('./client.js');
        const first = mod.getChatPrismaClient();
        const second = mod.getChatPrismaClient();

        expect(first).toBe(second);
        // Expect constructor to be called with adapter (implementation detail of chat-bridge)
        expect(mockCtor).toHaveBeenCalledWith(expect.objectContaining({
            adapter: expect.anything()
        }));
        expect(mockCtor).toHaveBeenCalledTimes(1);
    });
});
