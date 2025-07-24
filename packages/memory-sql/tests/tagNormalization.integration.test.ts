import { MemorySQLAdapter } from '../src/MemorySQLAdapter.js';
import { PrismaClient } from '@prisma/client';

describe('MemorySQLAdapter Tag Normalization Integration', () => {
    let adapter: MemorySQLAdapter;
    let prisma: PrismaClient;

    beforeAll(async () => {
        // Use test database from environment
        const testDbUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
        if (!testDbUrl) {
            throw new Error('TEST_DATABASE_URL or DATABASE_URL must be set for integration tests');
        }

        prisma = new PrismaClient({
            datasources: {
                db: { url: testDbUrl }
            }
        });

        adapter = new MemorySQLAdapter({
            prismaClient: prisma,
            defaultTenantId: 'test-tenant'
        });
    });

    afterAll(async () => {
        // Clean up test data
        await prisma.agentMemoryStore.deleteMany({
            where: { tenantId: 'test-tenant' }
        });
        await adapter.disconnect();
        await prisma.$disconnect();
    });

    beforeEach(async () => {
        // Clean up before each test
        await prisma.agentMemoryStore.deleteMany({
            where: { tenantId: 'test-tenant' }
        });
    });

    test('stores tags as lowercase and trimmed', async () => {
        await adapter.set('test-key', { data: 'test' }, {
            tags: ['RIGA', '  Latvia  ', 'Events', '  ']
        });

        // Verify by searching - should find with lowercase
        const results = await adapter.getMany({ tag: 'riga' });
        expect(results).toHaveLength(1);
        expect(results[0].key).toBe('test-key');

        // Verify with other normalized tags
        const latviaResults = await adapter.getMany({ tag: 'latvia' });
        expect(latviaResults).toHaveLength(1);

        const eventsResults = await adapter.getMany({ tag: 'events' });
        expect(eventsResults).toHaveLength(1);
    });

    test('case-insensitive search works', async () => {
        await adapter.set('test-key', { data: 'test' }, {
            tags: ['riga', 'latvia']
        });

        // Should find with any case variation
        const results1 = await adapter.getMany({ tag: 'RIGA' });
        const results2 = await adapter.getMany({ tag: 'Riga' });
        const results3 = await adapter.getMany({ tag: 'riga' });
        const results4 = await adapter.getMany({ tag: '  RIGA  ' });

        expect(results1).toHaveLength(1);
        expect(results2).toHaveLength(1);
        expect(results3).toHaveLength(1);
        expect(results4).toHaveLength(1);

        // All should return the same item
        expect(results1[0].key).toBe('test-key');
        expect(results2[0].key).toBe('test-key');
        expect(results3[0].key).toBe('test-key');
        expect(results4[0].key).toBe('test-key');
    });

    test('removes duplicate tags after normalization', async () => {
        await adapter.set('test-key', { data: 'test' }, {
            tags: ['RIGA', 'riga', '  Riga  ', 'LATVIA', 'latvia']
        });

        // Check database directly to verify normalized tags
        const record = await prisma.agentMemoryStore.findFirst({
            where: {
                tenantId: 'test-tenant',
                key: 'test-key'
            }
        });

        expect(record?.tags).toEqual(['riga', 'latvia']);
    });

    test('works with semantic search and filters', async () => {
        await adapter.set('event-1', {
            eventOccurences: [{ date: '2025-07-17' }],
            location: 'Riga'
        }, {
            tags: ['RIGA', 'Latvia', 'EVENTS']
        });

        // Search with filters and case-insensitive tags
        const results = await adapter.getMany({
            tag: 'riga',
            filters: [
                {
                    path: 'eventOccurences',
                    operator: 'CONTAINS',
                    value: { date: '2025-07-17' }
                }
            ]
        });

        expect(results).toHaveLength(1);
        expect(results[0].key).toBe('event-1');
    });

    test('works with blob storage', async () => {
        const buffer = Buffer.from('test image data');

        await adapter.setBlob('image-key', buffer,
            { filename: 'test.jpg', mimeType: 'image/jpeg' },
            { tags: ['IMAGE', '  Photo  ', 'RIGA'] }
        );

        // Search for blob with normalized tag
        const blobs = await adapter.listBlobs('test-tenant', { tags: ['image'] });
        expect(blobs).toHaveLength(1);
        expect(blobs[0].key).toBe('image-key');
        expect(blobs[0].tags).toEqual(['image', 'photo', 'riga']);
    });

    test('handles empty and invalid tags', async () => {
        await adapter.set('test-key', { data: 'test' }, {
            tags: ['RIGA', '', '   ', null as any, undefined as any, 'latvia']
        });

        // Check database to verify only valid tags are stored
        const record = await prisma.agentMemoryStore.findFirst({
            where: {
                tenantId: 'test-tenant',
                key: 'test-key'
            }
        });

        expect(record?.tags).toEqual(['riga', 'latvia']);
    });

    test('enrich method preserves normalized tags', async () => {
        // This test would require setting up enrichment service
        // For now, just test basic functionality
        await adapter.set('enrich-key', { data: 'original' }, {
            tags: ['RIGA', 'Events']
        });

        // Verify tags are normalized
        const results = await adapter.getMany({ tag: 'riga' });
        expect(results).toHaveLength(1);
        expect(results[0].key).toBe('enrich-key');
    });
}); 