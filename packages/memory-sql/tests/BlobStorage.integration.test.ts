import fs from 'fs';
import path from 'path';
import { MemorySQLAdapter } from '../src/MemorySQLAdapter.js';
import { storeImage, getImage, listImages, deleteImage } from '../src/BlobStorageHelpers.js';

// Only run integration tests if database is available
const hasDatabase = process.env.MEMORY_DATABASE_URL && process.env.MEMORY_DATABASE_URL.includes('localhost');

describe('BlobStorage Integration Tests', () => {
    let adapter: MemorySQLAdapter;

    // Skip if no database available
    if (!hasDatabase) {
        it.skip('Database not available - skipping integration tests', () => { });
        return;
    }

    beforeAll(async () => {
        // Import Prisma client after confirming database is available
        const { PrismaClient } = await import('@prisma/client');
        const prisma = new PrismaClient();
        adapter = new MemorySQLAdapter(prisma);
    });

    afterAll(async () => {
        // Cleanup test data
        if (adapter) {
            try {
                await adapter.deleteBlob('test-image-1', 'test-integration');
                await adapter.deleteBlob('test-image-2', 'test-integration');
            } catch (error) {
                // Ignore cleanup errors
            }
        }
    });

    describe('Basic Blob Operations', () => {
        it('should store and retrieve binary data', async () => {
            const testData = Buffer.from('test image data for integration test');
            const metadata = {
                filename: 'test-integration.jpg',
                mimeType: 'image/jpeg',
                description: 'Integration test image'
            };

            // Store the blob
            await adapter.setBlob('test-image-1', testData, metadata, {
                tenantId: 'test-integration',
                tags: ['integration-test', 'image']
            });

            // Retrieve the blob
            const result = await adapter.getBlob('test-image-1', 'test-integration');

            expect(result).not.toBeNull();
            expect(result!.buffer.equals(testData)).toBe(true);
            expect(result!.metadata).toMatchObject({
                filename: 'test-integration.jpg',
                mimeType: 'image/jpeg',
                description: 'Integration test image'
            });
        });

        it('should check blob existence', async () => {
            const exists = await adapter.hasBlob('test-image-1', 'test-integration');
            expect(exists).toBe(true);

            const notExists = await adapter.hasBlob('non-existent-key', 'test-integration');
            expect(notExists).toBe(false);
        });

        it('should delete blob data', async () => {
            // Verify it exists first
            let exists = await adapter.hasBlob('test-image-1', 'test-integration');
            expect(exists).toBe(true);

            // Delete the blob
            await adapter.deleteBlob('test-image-1', 'test-integration');

            // Verify it's gone
            exists = await adapter.hasBlob('test-image-1', 'test-integration');
            expect(exists).toBe(false);
        });
    });

    describe('Helper Functions', () => {
        it('should store and retrieve images using helper functions', async () => {
            const imageBuffer = Buffer.from('fake image data for helper test');

            // Store image using helper
            await storeImage(adapter, 'test-image-2', imageBuffer, {
                metadata: { description: 'Helper function test' },
                tags: ['helper-test'],
                tenantId: 'test-integration'
            });

            // Retrieve image using helper
            const result = await getImage(adapter, 'test-image-2', 'test-integration');

            expect(result).not.toBeNull();
            expect(result!.buffer.equals(imageBuffer)).toBe(true);
            expect(result!.metadata.description).toBe('Helper function test');
            expect(result!.metadata.category).toBe('image');
        });

        it('should list stored images', async () => {
            const images = await listImages(adapter, 'test-integration');

            expect(Array.isArray(images)).toBe(true);
            expect(images.length).toBeGreaterThan(0);

            const testImage = images.find(img => img.key === 'test-image-2');
            expect(testImage).toBeDefined();
            expect(testImage!.metadata.description).toBe('Helper function test');
        });

        it('should delete image using helper', async () => {
            // Verify exists
            let result = await getImage(adapter, 'test-image-2', 'test-integration');
            expect(result).not.toBeNull();

            // Delete using helper
            await deleteImage(adapter, 'test-image-2', 'test-integration');

            // Verify deleted
            result = await getImage(adapter, 'test-image-2', 'test-integration');
            expect(result).toBeNull();
        });
    });

    describe('Edge Cases', () => {
        it('should handle empty buffers', async () => {
            const emptyBuffer = Buffer.alloc(0);

            await adapter.setBlob('empty-test', emptyBuffer, {}, {
                tenantId: 'test-integration'
            });

            const result = await adapter.getBlob('empty-test', 'test-integration');
            expect(result).not.toBeNull();
            expect(result!.buffer.length).toBe(0);

            // Clean up
            await adapter.deleteBlob('empty-test', 'test-integration');
        });

        it('should handle large metadata objects', async () => {
            const testData = Buffer.from('test data');
            const largeMetadata = {
                filename: 'test.jpg',
                description: 'A'.repeat(1000), // Large description
                customField: { nested: { deeply: { nested: 'value' } } },
                arrayField: [1, 2, 3, 4, 5]
            };

            await adapter.setBlob('metadata-test', testData, largeMetadata, {
                tenantId: 'test-integration'
            });

            const result = await adapter.getBlob('metadata-test', 'test-integration');
            expect(result).not.toBeNull();
            expect(result!.metadata.description.length).toBe(1000);
            expect(result!.metadata.customField.nested.deeply.nested).toBe('value');

            // Clean up
            await adapter.deleteBlob('metadata-test', 'test-integration');
        });
    });
}); 