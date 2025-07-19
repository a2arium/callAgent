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
export declare function storeImage(adapter: MemorySQLAdapter, imageId: string, imageBuffer: Buffer, options?: BlobStorageOptions): Promise<void>;
/**
 * Store a general file
 */
export declare function storeFile(adapter: MemorySQLAdapter, fileId: string, fileBuffer: Buffer, options?: BlobStorageOptions): Promise<void>;
/**
 * Get an image by ID
 */
export declare function getImage(adapter: MemorySQLAdapter, imageId: string, tenantId?: string): Promise<{
    buffer: Buffer;
    metadata: BlobMetadata;
} | null>;
/**
 * Get a file by ID
 */
export declare function getFile(adapter: MemorySQLAdapter, fileId: string, tenantId?: string): Promise<{
    buffer: Buffer;
    metadata: BlobMetadata;
} | null>;
/**
 * List all images for a tenant
 */
export declare function listImages(adapter: MemorySQLAdapter, tenantId?: string, limit?: number): Promise<Array<{
    key: string;
    metadata: BlobMetadata;
    tags: string[];
    createdAt: Date;
    updatedAt: Date;
}>>;
/**
 * List all files for a tenant
 */
export declare function listFiles(adapter: MemorySQLAdapter, tenantId?: string, limit?: number): Promise<Array<{
    key: string;
    metadata: BlobMetadata;
    tags: string[];
    createdAt: Date;
    updatedAt: Date;
}>>;
/**
 * Check if an image exists
 */
export declare function hasImage(adapter: MemorySQLAdapter, imageId: string, tenantId?: string): Promise<boolean>;
/**
 * Delete an image
 */
export declare function deleteImage(adapter: MemorySQLAdapter, imageId: string, tenantId?: string): Promise<void>;
/**
 * Get just the metadata for an image (without binary data)
 */
export declare function getImageMetadata(adapter: MemorySQLAdapter, imageId: string, tenantId?: string): Promise<BlobMetadata | null>;
