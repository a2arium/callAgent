/**
 * Binary Data Processor - Smart detection and processing of various data types
 *
 * This module provides automatic detection and processing of:
 * - URLs (http/https) → Download and convert to Buffer
 * - Data URLs (data:image/png;base64,xxx) → Parse and convert to Buffer
 * - Base64 strings → Decode to Buffer
 * - Buffers → Pass through directly
 * - Regular data → Pass through unchanged
 */
export type DataType = 'buffer' | 'url' | 'dataUrl' | 'base64' | 'unknown';
export type ProcessedData = {
    buffer: Buffer;
    metadata: {
        originalData?: any;
        dataType: DataType;
        mimeType?: string;
        filename?: string;
        originalUrl?: string;
        downloadedAt?: Date;
        size: number;
        hash?: string;
        [key: string]: any;
    };
};
export type DownloadOptions = {
    timeout?: number;
    maxSize?: number;
    retries?: number;
    userAgent?: string;
};
export type BinaryProcessorConfig = {
    maxDownloadSize: number;
    timeout: number;
    retries: number;
    allowedDomains?: string[];
    cacheDownloads: boolean;
    generateHashes: boolean;
};
export declare const DEFAULT_CONFIG: BinaryProcessorConfig;
/**
 * Detects the type of data provided
 */
export declare function detectDataType(data: any): DataType;
/**
 * Extracts filename from URL path
 */
export declare function extractFilenameFromUrl(url: string): string | undefined;
/**
 * Extracts filename from Content-Disposition header
 */
export declare function extractFilenameFromContentDisposition(contentDisposition: string): string | undefined;
/**
 * Parses data URL (data:image/png;base64,xxx)
 */
export declare function parseDataUrl(dataUrl: string): {
    buffer: Buffer;
    mimeType?: string;
    encoding?: string;
};
/**
 * Downloads data from URL with error handling and retries
 */
export declare function downloadUrl(url: string, options?: DownloadOptions): Promise<{
    buffer: Buffer;
    mimeType?: string;
    filename?: string;
    contentLength?: number;
}>;
/**
 * Generates content hash for deduplication
 */
export declare function generateContentHash(buffer: Buffer): string;
/**
 * Main processing function - automatically detects data type and converts to Buffer
 */
export declare function processDataForStorage(data: any, existingMetadata?: any, config?: Partial<BinaryProcessorConfig>): Promise<ProcessedData | null>;
/**
 * Simple MIME type detection from file extension
 */
export declare function detectMimeTypeFromFilename(filename: string): string | undefined;
