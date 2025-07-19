import { describe, test, expect, beforeAll, afterAll, jest } from '@jest/globals';
import {
    detectDataType,
    processDataForStorage,
    downloadUrl,
    parseDataUrl,
    extractFilenameFromUrl,
    extractFilenameFromContentDisposition,
    generateContentHash,
    detectMimeTypeFromFilename
} from '../src/BinaryDataProcessor.js';

// Mock fetch for testing downloads
global.fetch = jest.fn() as jest.MockedFunction<typeof fetch>;

describe('BinaryDataProcessor', () => {
    beforeAll(() => {
        // Mock fetch globally
        jest.clearAllMocks();
    });

    afterAll(() => {
        jest.restoreAllMocks();
    });

    describe('detectDataType', () => {
        test('should detect Buffer data', () => {
            const buffer = Buffer.from('test data');
            expect(detectDataType(buffer)).toBe('buffer');
        });

        test('should detect HTTP URLs', () => {
            expect(detectDataType('https://example.com/file.jpg')).toBe('url');
            expect(detectDataType('http://example.com/file.png')).toBe('url');
        });

        test('should detect data URLs', () => {
            const dataUrl = 'data:image/png;base64,iVBORw0KGg';
            expect(detectDataType(dataUrl)).toBe('dataUrl');
        });

        test('should detect base64 strings', () => {
            const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
            expect(detectDataType(base64)).toBe('base64');
        });

        test('should return unknown for other data types', () => {
            expect(detectDataType('plain text')).toBe('unknown');
            expect(detectDataType(123)).toBe('unknown');
            expect(detectDataType({ key: 'value' })).toBe('unknown');
            expect(detectDataType(null)).toBe('unknown');
        });

        test('should not detect short strings as base64', () => {
            expect(detectDataType('short')).toBe('unknown');
            expect(detectDataType('ABC123')).toBe('unknown'); // Too short
        });
    });

    describe('extractFilenameFromUrl', () => {
        test('should extract filename from URL path', () => {
            expect(extractFilenameFromUrl('https://example.com/image.jpg')).toBe('image.jpg');
            expect(extractFilenameFromUrl('https://example.com/folder/document.pdf')).toBe('document.pdf');
        });

        test('should return undefined for URLs without filename', () => {
            expect(extractFilenameFromUrl('https://example.com/')).toBeUndefined();
            expect(extractFilenameFromUrl('https://example.com/folder')).toBeUndefined();
        });

        test('should handle invalid URLs', () => {
            expect(extractFilenameFromUrl('not-a-url')).toBeUndefined();
        });
    });

    describe('extractFilenameFromContentDisposition', () => {
        test('should extract filename from Content-Disposition header', () => {
            expect(extractFilenameFromContentDisposition('attachment; filename="test.pdf"')).toBe('test.pdf');
            expect(extractFilenameFromContentDisposition('attachment; filename=image.jpg')).toBe('image.jpg');
        });

        test('should return undefined for invalid headers', () => {
            expect(extractFilenameFromContentDisposition('')).toBeUndefined();
            expect(extractFilenameFromContentDisposition('attachment')).toBeUndefined();
        });
    });

    describe('parseDataUrl', () => {
        test('should parse base64 data URL', () => {
            const dataUrl = 'data:image/png;base64,iVBORw0KGg';
            const result = parseDataUrl(dataUrl);

            expect(result.mimeType).toBe('image/png');
            expect(result.encoding).toBe('base64');
            expect(Buffer.isBuffer(result.buffer)).toBe(true);
        });

        test('should throw error for invalid data URL', () => {
            expect(() => parseDataUrl('invalid-data-url')).toThrow('Invalid data URL format');
            expect(() => parseDataUrl('data:image/png;unsupported,data')).toThrow('Unsupported data URL encoding');
        });
    });

    describe('generateContentHash', () => {
        test('should generate consistent hash for same content', () => {
            const buffer1 = Buffer.from('test data');
            const buffer2 = Buffer.from('test data');
            const buffer3 = Buffer.from('different data');

            const hash1 = generateContentHash(buffer1);
            const hash2 = generateContentHash(buffer2);
            const hash3 = generateContentHash(buffer3);

            expect(hash1).toBe(hash2);
            expect(hash1).not.toBe(hash3);
            expect(hash1).toMatch(/^[a-f0-9]{64}$/); // SHA256 hex format
        });
    });

    describe('detectMimeTypeFromFilename', () => {
        test('should detect common image MIME types', () => {
            expect(detectMimeTypeFromFilename('image.jpg')).toBe('image/jpeg');
            expect(detectMimeTypeFromFilename('photo.jpeg')).toBe('image/jpeg');
            expect(detectMimeTypeFromFilename('logo.png')).toBe('image/png');
            expect(detectMimeTypeFromFilename('icon.gif')).toBe('image/gif');
        });

        test('should detect document MIME types', () => {
            expect(detectMimeTypeFromFilename('document.pdf')).toBe('application/pdf');
            expect(detectMimeTypeFromFilename('sheet.xlsx')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        });

        test('should handle case insensitive extensions', () => {
            expect(detectMimeTypeFromFilename('IMAGE.JPG')).toBe('image/jpeg');
            expect(detectMimeTypeFromFilename('Document.PDF')).toBe('application/pdf');
        });

        test('should return undefined for unknown extensions', () => {
            expect(detectMimeTypeFromFilename('file.unknown')).toBeUndefined();
            expect(detectMimeTypeFromFilename('noextension')).toBeUndefined();
        });
    });

    describe('downloadUrl', () => {
        test('should download URL successfully', async () => {
            const mockResponse = {
                ok: true,
                status: 200,
                headers: {
                    get: (header: string) => {
                        if (header === 'content-type') return 'image/jpeg';
                        if (header === 'content-length') return '1024';
                        return null;
                    }
                },
                arrayBuffer: () => Promise.resolve(new ArrayBuffer(10))
            };

            (global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce(mockResponse as any);

            const result = await downloadUrl('https://example.com/image.jpg');

            expect(result.buffer).toBeDefined();
            expect(result.mimeType).toBe('image/jpeg');
            expect(result.filename).toBe('image.jpg');
            expect(result.contentLength).toBe(1024);
        });

        test('should handle download errors', async () => {
            const mockResponse = {
                ok: false,
                status: 404,
                statusText: 'Not Found'
            };

            (global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce(mockResponse as any);

            await expect(downloadUrl('https://example.com/notfound.jpg')).rejects.toThrow('HTTP 404: Not Found');
        });

        test('should handle content too large error', async () => {
            const mockResponse = {
                ok: true,
                status: 200,
                headers: {
                    get: (header: string) => {
                        if (header === 'content-length') return '100000000'; // 100MB
                        return null;
                    }
                }
            };

            (global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce(mockResponse as any);

            await expect(downloadUrl('https://example.com/huge.jpg', { maxSize: 1024 })).rejects.toThrow('Content too large');
        });
    });

    describe('processDataForStorage', () => {
        test('should process Buffer data', async () => {
            const buffer = Buffer.from('test data');
            const result = await processDataForStorage(buffer, { filename: 'test.txt' });

            expect(result).not.toBeNull();
            expect(result!.buffer).toBe(buffer);
            expect(result!.metadata.dataType).toBe('buffer');
            expect(result!.metadata.filename).toBe('test.txt');
            expect(result!.metadata.size).toBe(buffer.length);
        });

        test('should process base64 data', async () => {
            const base64 = 'aGVsbG8gd29ybGQ='; // "hello world" in base64
            const result = await processDataForStorage(base64, { filename: 'hello.txt' });

            expect(result).not.toBeNull();
            expect(result!.buffer.toString()).toBe('hello world');
            expect(result!.metadata.dataType).toBe('base64');
            expect(result!.metadata.filename).toBe('hello.txt');
        });

        test('should process data URL', async () => {
            const dataUrl = 'data:text/plain;base64,aGVsbG8gd29ybGQ=';
            const result = await processDataForStorage(dataUrl);

            expect(result).not.toBeNull();
            expect(result!.buffer.toString()).toBe('hello world');
            expect(result!.metadata.dataType).toBe('dataUrl');
            expect(result!.metadata.mimeType).toBe('text/plain');
        });

        test('should return null for unknown data types', async () => {
            const result = await processDataForStorage('plain text');
            expect(result).toBeNull();
        });

        test('should generate hash when enabled', async () => {
            const buffer = Buffer.from('test data');
            const result = await processDataForStorage(buffer, {}, { generateHashes: true });

            expect(result).not.toBeNull();
            expect(result!.metadata.hash).toBeDefined();
            expect(result!.metadata.hash).toMatch(/^[a-f0-9]{64}$/);
        });

        test('should auto-detect MIME type from filename', async () => {
            const buffer = Buffer.from('test data');
            const result = await processDataForStorage(buffer, { filename: 'test.jpg' });

            expect(result).not.toBeNull();
            expect(result!.metadata.mimeType).toBe('image/jpeg');
        });
    });

    describe('URL processing integration', () => {
        test('should process URL with mock download', async () => {
            const mockResponse = {
                ok: true,
                status: 200,
                headers: {
                    get: (header: string) => {
                        if (header === 'content-type') return 'image/png';
                        if (header === 'content-disposition') return 'attachment; filename="test.png"';
                        return null;
                    }
                },
                arrayBuffer: () => Promise.resolve(Buffer.from('fake image data').buffer)
            };

            (global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce(mockResponse as any);

            const url = 'https://example.com/image.png';
            const result = await processDataForStorage(url);

            expect(result).not.toBeNull();
            expect(result!.metadata.dataType).toBe('url');
            expect(result!.metadata.originalUrl).toBe(url);
            expect(result!.metadata.mimeType).toBe('image/png');
            expect(result!.metadata.filename).toBe('test.png');
            expect(result!.metadata.downloadedAt).toBeInstanceOf(Date);
        });
    });
}); 