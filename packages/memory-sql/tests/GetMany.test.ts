import { PrismaClient } from '@prisma/client';
import { MemorySQLAdapter } from '../src/MemorySQLAdapter.js';

describe('MemorySQLAdapter - getMany', () => {
    let prisma: PrismaClient;
    let adapter: MemorySQLAdapter;

    beforeEach(async () => {
        prisma = new PrismaClient();
        adapter = new MemorySQLAdapter(prisma);

        // Clean up any existing test data
        await prisma.agentMemoryStore.deleteMany({
            where: {
                key: {
                    startsWith: 'test:'
                }
            }
        });

        // Set up test data
        await adapter.set('test:user:123:profile', {
            name: 'John Doe',
            email: 'john@example.com',
            status: 'active'
        }, { tags: ['user', 'profile'] });

        await adapter.set('test:user:123:settings', {
            theme: 'dark',
            notifications: true
        }, { tags: ['user', 'settings'] });

        await adapter.set('test:user:456:profile', {
            name: 'Jane Smith',
            email: 'jane@example.com',
            status: 'inactive'
        }, { tags: ['user', 'profile'] });

        await adapter.set('test:conversation:789', {
            participants: ['user:123', 'user:456'],
            lastMessage: 'Hello world'
        }, { tags: ['conversation'] });

        await adapter.set('test:session:abc', {
            userId: '123',
            expiresAt: '2024-12-31T23:59:59Z'
        }, { tags: ['session'] });
    });

    afterEach(async () => {
        // Clean up test data
        await prisma.agentMemoryStore.deleteMany({
            where: {
                key: {
                    startsWith: 'test:'
                }
            }
        });
        await prisma.$disconnect();
    });

    describe('Pattern matching', () => {
        it('should find all user data with wildcard', async () => {
            const results = await adapter.getMany('test:user:*');

            expect(results).toHaveLength(3);
            expect(results.map(r => r.key).sort()).toEqual([
                'test:user:123:profile',
                'test:user:123:settings',
                'test:user:456:profile'
            ]);
        });

        it('should find specific user data with pattern', async () => {
            const results = await adapter.getMany('test:user:123:*');

            expect(results).toHaveLength(2);
            expect(results.map(r => r.key).sort()).toEqual([
                'test:user:123:profile',
                'test:user:123:settings'
            ]);
        });

        it('should find all profiles with pattern', async () => {
            const results = await adapter.getMany('test:user:*:profile');

            expect(results).toHaveLength(2);
            expect(results.map(r => r.key).sort()).toEqual([
                'test:user:123:profile',
                'test:user:456:profile'
            ]);
        });

        it('should support single character wildcard', async () => {
            // Add some test data with single character differences
            await adapter.set('test:item:a', { value: 'A' });
            await adapter.set('test:item:b', { value: 'B' });
            await adapter.set('test:item:ab', { value: 'AB' });

            const results = await adapter.getMany('test:item:?');

            expect(results).toHaveLength(2);
            expect(results.map(r => r.key).sort()).toEqual([
                'test:item:a',
                'test:item:b'
            ]);
        });

        it('should respect limit option', async () => {
            const results = await adapter.getMany('test:user:*', { limit: 2 });

            expect(results).toHaveLength(2);
        });
    });

    describe('Query object', () => {
        it('should query by tag', async () => {
            const results = await adapter.getMany({
                tag: 'profile'
            });

            expect(results).toHaveLength(2);
            expect(results.every(r => r.key.includes('profile'))).toBe(true);
        });

        it('should query with filters', async () => {
            const results = await adapter.getMany({
                tag: 'profile',
                filters: [
                    { path: 'status', operator: '=', value: 'active' }
                ]
            });

            expect(results).toHaveLength(1);
            expect(results[0].key).toBe('test:user:123:profile');
            expect(results[0].value).toEqual({
                name: 'John Doe',
                email: 'john@example.com',
                status: 'active'
            });
        });

        it('should query with multiple filters', async () => {
            const results = await adapter.getMany({
                tag: 'profile',
                filters: [
                    { path: 'status', operator: '=', value: 'active' },
                    { path: 'name', operator: 'CONTAINS', value: 'John' }
                ]
            });

            expect(results).toHaveLength(1);
            expect(results[0].key).toBe('test:user:123:profile');
        });

        it('should respect limit in query object', async () => {
            const results = await adapter.getMany({
                tag: 'user',
                limit: 2
            });

            expect(results).toHaveLength(2);
        });
    });

    describe('Pattern with options', () => {
        it('should combine pattern with limit option', async () => {
            const results = await adapter.getMany('test:user:*', { limit: 1 });

            expect(results).toHaveLength(1);
        });

        it('should combine pattern with ordering option', async () => {
            const results = await adapter.getMany('test:user:*', {
                orderBy: { path: 'createdAt', direction: 'asc' }
            });

            expect(results).toHaveLength(3);
            // Results should be ordered by creation time
        });
    });

    describe('Edge cases', () => {
        it('should return empty array for non-matching pattern', async () => {
            const results = await adapter.getMany('test:nonexistent:*');

            expect(results).toHaveLength(0);
        });

        it('should return empty array for non-matching query', async () => {
            const results = await adapter.getMany({
                tag: 'nonexistent'
            });

            expect(results).toHaveLength(0);
        });

        it('should handle patterns with SQL special characters', async () => {
            await adapter.set('test:special:%_chars', { value: 'special' });

            const results = await adapter.getMany('test:special:%_chars');

            expect(results).toHaveLength(1);
            expect(results[0].key).toBe('test:special:%_chars');
        });
    });
}); 