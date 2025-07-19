import { MemorySQLAdapter } from './MemorySQLAdapter.js';

/**
 * Helper functions for blob storage operations
 * These provide a simple interface for agents to store and retrieve binary data
 */

export type BlobMetadata = {
    filename?: string;
    mimeType?: string;
    description?: string;
    category?: string;
    [key: string]: any;
};

export type BlobStorageOptions = {
    tags?: string[];
    tenantId?: string;
    metadata?: BlobMetadata;
};

/**
 * Store an image with automatic metadata detection
 */
export async function storeImage(
    adapter: MemorySQLAdapter,
    imageId: string,
    imageBuffer: Buffer,
    options: BlobStorageOptions = {}
): Promise<void> {
    const metadata: BlobMetadata = {
        mimeType: detectImageMimeType(imageBuffer),
        category: 'image',
        ...options.metadata
    };

    await (adapter as any).setBlob(imageId, imageBuffer, metadata, {
        tags: ['image', ...(options.tags || [])],
        tenantId: options.tenantId
    });
}

/**
 * Store a general file
 */
export async function storeFile(
    adapter: MemorySQLAdapter,
    fileId: string,
    fileBuffer: Buffer,
    options: BlobStorageOptions = {}
): Promise<void> {
    const metadata: BlobMetadata = {
        category: 'file',
        ...options.metadata
    };

    await (adapter as any).setBlob(fileId, fileBuffer, metadata, {
        tags: ['file', ...(options.tags || [])],
        tenantId: options.tenantId
    });
}

/**
 * Get an image by ID
 */
export async function getImage(
    adapter: MemorySQLAdapter,
    imageId: string,
    tenantId?: string
): Promise<{ buffer: Buffer; metadata: BlobMetadata } | null> {
    return (adapter as any).getBlob(imageId, tenantId);
}

/**
 * Get a file by ID
 */
export async function getFile(
    adapter: MemorySQLAdapter,
    fileId: string,
    tenantId?: string
): Promise<{ buffer: Buffer; metadata: BlobMetadata } | null> {
    return (adapter as any).getBlob(fileId, tenantId);
}

/**
 * List all images for a tenant
 */
export async function listImages(
    adapter: MemorySQLAdapter,
    tenantId?: string,
    limit: number = 50
): Promise<Array<{
    key: string;
    metadata: BlobMetadata;
    tags: string[];
    createdAt: Date;
    updatedAt: Date;
}>> {
    return (adapter as any).listBlobs(tenantId, {
        limit,
        tags: ['image']
    });
}

/**
 * List all files for a tenant
 */
export async function listFiles(
    adapter: MemorySQLAdapter,
    tenantId?: string,
    limit: number = 50
): Promise<Array<{
    key: string;
    metadata: BlobMetadata;
    tags: string[];
    createdAt: Date;
    updatedAt: Date;
}>> {
    return (adapter as any).listBlobs(tenantId, {
        limit,
        tags: ['file']
    });
}

/**
 * Check if an image exists
 */
export async function hasImage(
    adapter: MemorySQLAdapter,
    imageId: string,
    tenantId?: string
): Promise<boolean> {
    return (adapter as any).hasBlob(imageId, tenantId);
}

/**
 * Delete an image
 */
export async function deleteImage(
    adapter: MemorySQLAdapter,
    imageId: string,
    tenantId?: string
): Promise<void> {
    return (adapter as any).deleteBlob(imageId, tenantId);
}

/**
 * Get just the metadata for an image (without binary data)
 */
export async function getImageMetadata(
    adapter: MemorySQLAdapter,
    imageId: string,
    tenantId?: string
): Promise<BlobMetadata | null> {
    return (adapter as any).getBlobMetadata(imageId, tenantId);
}

/**
 * Simple image MIME type detection based on file headers
 */
function detectImageMimeType(buffer: Buffer): string {
    if (buffer.length < 4) {
        return 'application/octet-stream';
    }

    const header = buffer.subarray(0, 4);

    // PNG: 89 50 4E 47
    if (header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4E && header[3] === 0x47) {
        return 'image/png';
    }

    // JPEG: FF D8 FF
    if (header[0] === 0xFF && header[1] === 0xD8 && header[2] === 0xFF) {
        return 'image/jpeg';
    }

    // GIF: 47 49 46
    if (header[0] === 0x47 && header[1] === 0x49 && header[2] === 0x46) {
        return 'image/gif';
    }

    // WebP: 52 49 46 46 (RIFF) + WEBP at offset 8
    if (buffer.length >= 12 &&
        header[0] === 0x52 && header[1] === 0x49 && header[2] === 0x46 && header[3] === 0x46) {
        const webpHeader = buffer.subarray(8, 12);
        if (webpHeader.toString() === 'WEBP') {
            return 'image/webp';
        }
    }

    return 'application/octet-stream';
} 