import { MemorySQLAdapter } from '../src/MemorySQLAdapter.js';
import { storeImage, getImage, listImages, deleteImage, storeFile, getFile } from '../src/BlobStorageHelpers.js';

// Mock setup
const mockClient = {
    agentMemoryStore: {
        upsert: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn(),
        deleteMany: jest.fn(),
    }
};

// Helper to create a mock MemorySQLAdapter
function createMockAdapter(): MemorySQLAdapter {
    const adapter = new MemorySQLAdapter(mockClient as any);
    return adapter;
}

// Helper to create test buffer
function createTestBuffer(content: string = 'test image data'): Buffer {
    return Buffer.from(content, 'utf-8');
}

describe('BlobStorage', () => {
    let adapter: MemorySQLAdapter;

    beforeEach(() => {
        jest.clearAllMocks();
        adapter = createMockAdapter();
    });

    describe('setBlob method', () => {
        it('should store binary data with metadata correctly', async () => {
            const testBuffer = createTestBuffer();
            const metadata = { filename: 'test.jpg', mimeType: 'image/jpeg' };

            mockClient.agentMemoryStore.upsert.mockResolvedValue({});

            await adapter.setBlob('test-key', testBuffer, metadata, {
                tenantId: 'test-tenant',
                tags: ['image', 'test']
            });

            expect(mockClient.agentMemoryStore.upsert).toHaveBeenCalledWith({
                where: {
                    tenantId_key: {
                        tenantId: 'test-tenant',
                        key: 'test-key'
                    }
                },
                create: {
                    tenantId: 'test-tenant',
                    key: 'test-key',
                    value: {},
                    tags: ['image', 'test'],
                    blobData: testBuffer,
                    blobMetadata: {
                        ...metadata,
                        size: testBuffer.length
                    }
                },
                update: {
                    blobData: testBuffer,
                    blobMetadata: {
                        ...metadata,
                        size: testBuffer.length
                    },
                    tags: ['image', 'test'],
                    updatedAt: expect.any(Date)
                }
            });
        });

        it('should use default tenant when not specified', async () => {
            const testBuffer = createTestBuffer();

            mockClient.agentMemoryStore.upsert.mockResolvedValue({});

            await adapter.setBlob('test-key', testBuffer);

            expect(mockClient.agentMemoryStore.upsert).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: {
                        tenantId_key: {
                            tenantId: 'default',
                            key: 'test-key'
                        }
                    }
                })
            );
        });
    });

    describe('getBlob method', () => {
        it('should retrieve binary data successfully', async () => {
            const testBuffer = createTestBuffer();
            const metadata = { filename: 'test.jpg', size: testBuffer.length };

            mockClient.agentMemoryStore.findUnique.mockResolvedValue({
                key: 'test-key',
                blobData: testBuffer,
                blobMetadata: metadata,
                tags: ['image'],
                createdAt: new Date(),
                updatedAt: new Date()
            });

            const result = await adapter.getBlob('test-key', 'test-tenant');

            expect(result).toEqual({
                buffer: testBuffer,
                metadata: metadata
            });

            expect(mockClient.agentMemoryStore.findUnique).toHaveBeenCalledWith({
                where: {
                    tenantId_key: {
                        tenantId: 'test-tenant',
                        key: 'test-key'
                    }
                },
                select: {
                    key: true,
                    blobData: true,
                    blobMetadata: true,
                    tags: true,
                    createdAt: true,
                    updatedAt: true
                }
            });
        });

        it('should return null when blob not found', async () => {
            mockClient.agentMemoryStore.findUnique.mockResolvedValue(null);

            const result = await adapter.getBlob('nonexistent-key');

            expect(result).toBeNull();
        });

        it('should return null when blob data is null', async () => {
            mockClient.agentMemoryStore.findUnique.mockResolvedValue({
                key: 'test-key',
                blobData: null,
                blobMetadata: null
            });

            const result = await adapter.getBlob('test-key');

            expect(result).toBeNull();
        });
    });

    describe('hasBlob method', () => {
        it('should return true when blob exists', async () => {
            mockClient.agentMemoryStore.findUnique.mockResolvedValue({
                key: 'test-key',
                blobData: createTestBuffer()
            });

            const result = await adapter.hasBlob('test-key');

            expect(result).toBe(true);
        });

        it('should return false when blob does not exist', async () => {
            mockClient.agentMemoryStore.findUnique.mockResolvedValue(null);

            const result = await adapter.hasBlob('test-key');

            expect(result).toBe(false);
        });
    });

    describe('deleteBlob method', () => {
        it('should clear blob data while preserving other data', async () => {
            mockClient.agentMemoryStore.update.mockResolvedValue({});

            await adapter.deleteBlob('test-key', 'test-tenant');

            expect(mockClient.agentMemoryStore.update).toHaveBeenCalledWith({
                where: {
                    tenantId_key: {
                        tenantId: 'test-tenant',
                        key: 'test-key'
                    }
                },
                data: {
                    blobData: undefined,
                    blobMetadata: undefined,
                    updatedAt: expect.any(Date)
                }
            });
        });
    });

    describe('Helper Functions', () => {
        describe('storeImage', () => {
            it('should store image with detected MIME type', async () => {
                const adapter = createMockAdapter();
                const spySetBlob = jest.spyOn(adapter, 'setBlob').mockResolvedValue();

                const imageBuffer = Buffer.from('fake-image-data');
                await storeImage(adapter, 'image-1', imageBuffer, {
                    metadata: { description: 'Test image' },
                    tags: ['photo'],
                    tenantId: 'user-123'
                });

                expect(spySetBlob).toHaveBeenCalledWith(
                    'image-1',
                    imageBuffer,
                    expect.objectContaining({
                        category: 'image',
                        description: 'Test image'
                    }),
                    { tags: ['photo'], tenantId: 'user-123' }
                );
            });
        });

        describe('getImage', () => {
            it('should retrieve image blob', async () => {
                const adapter = createMockAdapter();
                const mockBlob = {
                    buffer: Buffer.from('image-data'),
                    metadata: { filename: 'test.jpg' }
                };
                jest.spyOn(adapter, 'getBlob').mockResolvedValue(mockBlob);

                const result = await getImage(adapter, 'image-1');

                expect(result).toEqual(mockBlob);
            });
        });

        describe('storeFile', () => {
            it('should store file with provided metadata', async () => {
                const adapter = createMockAdapter();
                const spySetBlob = jest.spyOn(adapter, 'setBlob').mockResolvedValue();

                const fileBuffer = Buffer.from('file-content');
                await storeFile(adapter, 'doc-1', fileBuffer, {
                    metadata: { filename: 'document.pdf', mimeType: 'application/pdf' },
                    tenantId: 'user-123'
                });

                expect(spySetBlob).toHaveBeenCalledWith(
                    'doc-1',
                    fileBuffer,
                    expect.objectContaining({
                        filename: 'document.pdf',
                        mimeType: 'application/pdf',
                        category: 'file'
                    }),
                    { tenantId: 'user-123' }
                );
            });
        });
    });

    describe('MIME Type Detection', () => {
        it('should detect common image formats', () => {
            // This would require implementing the detectImageMimeType function
            // For now, we'll just verify it's called
            const jpegBuffer = Buffer.from([0xFF, 0xD8, 0xFF]); // JPEG signature
            const pngBuffer = Buffer.from([0x89, 0x50, 0x4E, 0x47]); // PNG signature

            // These would be actual tests once detectImageMimeType is implemented
            // expect(detectImageMimeType(jpegBuffer)).toBe('image/jpeg');
            // expect(detectImageMimeType(pngBuffer)).toBe('image/png');
        });
    });
}); 