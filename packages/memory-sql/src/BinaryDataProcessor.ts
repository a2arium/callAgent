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

import crypto from 'crypto';

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

export const DEFAULT_CONFIG: BinaryProcessorConfig = {
    maxDownloadSize: 50 * 1024 * 1024, // 50MB
    timeout: 30000, // 30 seconds
    retries: 3,
    cacheDownloads: true,
    generateHashes: true
};

/**
 * Detects the type of data provided
 */
export function detectDataType(data: any): DataType {
    if (Buffer.isBuffer(data)) {
        return 'buffer';
    }

    if (typeof data === 'string') {
        // Check for URLs
        if (data.startsWith('http://') || data.startsWith('https://')) {
            return 'url';
        }

        // Check for data URLs (data:image/png;base64,xxx)
        if (data.startsWith('data:')) {
            return 'dataUrl';
        }

        // Check for base64 (rough heuristic)
        if (data.length > 10 && /^[A-Za-z0-9+/]+=*$/.test(data)) {
            return 'base64';
        }
    }

    return 'unknown';
}

/**
 * Extracts filename from URL path
 */
export function extractFilenameFromUrl(url: string): string | undefined {
    try {
        const urlObj = new URL(url);
        const pathname = urlObj.pathname;
        const filename = pathname.split('/').pop();
        return filename && filename.includes('.') ? filename : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Extracts filename from Content-Disposition header
 */
export function extractFilenameFromContentDisposition(contentDisposition: string): string | undefined {
    if (!contentDisposition) return undefined;

    const match = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
    if (match && match[1]) {
        return match[1].replace(/['"]/g, '');
    }

    return undefined;
}

/**
 * Parses data URL (data:image/png;base64,xxx)
 */
export function parseDataUrl(dataUrl: string): { buffer: Buffer; mimeType?: string; encoding?: string } {
    const match = dataUrl.match(/^data:([^;]+);([^,]+),(.+)$/);

    if (!match) {
        throw new Error('Invalid data URL format');
    }

    const [, mimeType, encoding, data] = match;

    if (encoding === 'base64') {
        return {
            buffer: Buffer.from(data, 'base64'),
            mimeType,
            encoding
        };
    }

    // Handle URL-encoded data
    if (encoding === 'charset=utf-8' || !encoding) {
        return {
            buffer: Buffer.from(decodeURIComponent(data)),
            mimeType,
            encoding
        };
    }

    throw new Error(`Unsupported data URL encoding: ${encoding}`);
}

/**
 * Downloads data from URL with error handling and retries
 */
export async function downloadUrl(url: string, options: DownloadOptions = {}): Promise<{
    buffer: Buffer;
    mimeType?: string;
    filename?: string;
    contentLength?: number;
}> {
    const { timeout = 30000, maxSize = 50 * 1024 * 1024, retries = 3, userAgent } = options;

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            // Create AbortController for timeout
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeout);

            const response = await fetch(url, {
                signal: controller.signal,
                headers: {
                    'User-Agent': userAgent || 'CallAgent-Framework/1.0'
                }
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            // Check content length
            const contentLengthHeader = response.headers.get('content-length');
            const contentLength = contentLengthHeader ? parseInt(contentLengthHeader) : undefined;

            if (contentLength && contentLength > maxSize) {
                throw new Error(`Content too large: ${contentLength} bytes > ${maxSize} bytes`);
            }

            // Read response with size limit
            const arrayBuffer = await response.arrayBuffer();

            if (arrayBuffer.byteLength > maxSize) {
                throw new Error(`Content too large: ${arrayBuffer.byteLength} bytes > ${maxSize} bytes`);
            }

            const buffer = Buffer.from(arrayBuffer);

            // Extract metadata
            const mimeType = response.headers.get('content-type') || undefined;
            const contentDisposition = response.headers.get('content-disposition');
            let filename = extractFilenameFromContentDisposition(contentDisposition || '');

            if (!filename) {
                filename = extractFilenameFromUrl(url);
            }

            return {
                buffer,
                mimeType,
                filename,
                contentLength: contentLength || buffer.length
            };

        } catch (error) {
            lastError = error as Error;

            // Don't retry on certain errors
            if (error instanceof Error) {
                if (error.message.includes('Content too large') ||
                    error.message.includes('HTTP 4')) {
                    break;
                }
            }

            // Wait before retry (exponential backoff)
            if (attempt < retries - 1) {
                await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
            }
        }
    }

    throw lastError || new Error('Download failed after retries');
}

/**
 * Generates content hash for deduplication
 */
export function generateContentHash(buffer: Buffer): string {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Main processing function - automatically detects data type and converts to Buffer
 */
export async function processDataForStorage(
    data: any,
    existingMetadata: any = {},
    config: Partial<BinaryProcessorConfig> = {}
): Promise<ProcessedData | null> {
    const finalConfig = { ...DEFAULT_CONFIG, ...config };
    const dataType = detectDataType(data);

    // If it's not binary data, return null to indicate no processing needed
    if (dataType === 'unknown') {
        return null;
    }

    let buffer: Buffer;
    let processingMetadata: any = {
        dataType,
        originalData: dataType !== 'buffer' ? data : undefined
    };

    try {
        switch (dataType) {
            case 'buffer':
                buffer = data as Buffer;
                break;

            case 'url':
                const downloaded = await downloadUrl(data, {
                    timeout: finalConfig.timeout,
                    maxSize: finalConfig.maxDownloadSize,
                    retries: finalConfig.retries
                });

                buffer = downloaded.buffer;
                processingMetadata = {
                    ...processingMetadata,
                    originalUrl: data,
                    downloadedAt: new Date(),
                    mimeType: downloaded.mimeType,
                    filename: downloaded.filename,
                    contentLength: downloaded.contentLength
                };
                break;

            case 'dataUrl':
                const parsed = parseDataUrl(data);
                buffer = parsed.buffer;
                processingMetadata = {
                    ...processingMetadata,
                    mimeType: parsed.mimeType,
                    encoding: parsed.encoding
                };
                break;

            case 'base64':
                buffer = Buffer.from(data, 'base64');
                break;

            default:
                throw new Error(`Unsupported data type: ${dataType}`);
        }

        // Generate content hash if enabled
        let hash: string | undefined;
        if (finalConfig.generateHashes) {
            hash = generateContentHash(buffer);
        }

        // Combine metadata
        const metadata = {
            ...processingMetadata,
            ...existingMetadata, // User metadata takes precedence
            size: buffer.length,
            hash
        };

        // Auto-detect MIME type from filename if not present
        if (!metadata.mimeType && metadata.filename) {
            metadata.mimeType = detectMimeTypeFromFilename(metadata.filename);
        }

        return {
            buffer,
            metadata
        };

    } catch (error) {
        throw new Error(`Failed to process ${dataType} data: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}

/**
 * Simple MIME type detection from file extension
 */
export function detectMimeTypeFromFilename(filename: string): string | undefined {
    const ext = filename.toLowerCase().split('.').pop();

    const mimeTypes: Record<string, string> = {
        // Images
        'jpg': 'image/jpeg',
        'jpeg': 'image/jpeg',
        'png': 'image/png',
        'gif': 'image/gif',
        'webp': 'image/webp',
        'svg': 'image/svg+xml',
        'bmp': 'image/bmp',
        'ico': 'image/x-icon',

        // Documents
        'pdf': 'application/pdf',
        'doc': 'application/msword',
        'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'xls': 'application/vnd.ms-excel',
        'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'ppt': 'application/vnd.ms-powerpoint',
        'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',

        // Text
        'txt': 'text/plain',
        'html': 'text/html',
        'css': 'text/css',
        'js': 'text/javascript',
        'json': 'application/json',
        'xml': 'application/xml',

        // Audio
        'mp3': 'audio/mpeg',
        'wav': 'audio/wav',
        'ogg': 'audio/ogg',

        // Video
        'mp4': 'video/mp4',
        'avi': 'video/x-msvideo',
        'mov': 'video/quicktime',

        // Archives
        'zip': 'application/zip',
        'tar': 'application/x-tar',
        'gz': 'application/gzip',
        '7z': 'application/x-7z-compressed'
    };

    return ext ? mimeTypes[ext] : undefined;
} 