import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { runAgentWithStreaming } from '../src/runner/streamingRunner.js';
import { createAgent } from '../src/core/plugin/createAgent.js';
import { PluginManager } from '../src/core/plugin/pluginManager.js';
import path from 'path';
import fs from 'fs';

// Mock PrismaClient for caching
jest.mock('@prisma/client', () => ({
    PrismaClient: jest.fn().mockImplementation(() => ({
        agentResultCache: {
            findUnique: jest.fn(),
            upsert: jest.fn(),
            delete: jest.fn()
        },
        $disconnect: jest.fn()
    }))
}));

describe('Streaming Mode Caching', () => {
    let testAgentPath: string;
    let mockPrismaInstance: any;

    beforeEach(async () => {
        // Reset all mocks
        jest.clearAllMocks();

        // Get the mocked PrismaClient instance
        const { PrismaClient } = await import('@prisma/client');
        mockPrismaInstance = new (PrismaClient as any)();

        // Create a test agent with caching enabled
        const testAgent = createAgent({
            manifest: {
                name: 'streaming-cache-test-agent',
                version: '1.0.0',
                cache: {
                    enabled: true,
                    ttlSeconds: 60,
                    excludePaths: ['timestamp']
                }
            },
            async handleTask(ctx) {
                // Simulate expensive operation
                await new Promise(resolve => setTimeout(resolve, 100));
                return {
                    result: 'test-result',
                    processedAt: new Date().toISOString(),
                    executionTime: 100
                };
            }
        }, import.meta.url);

        // Register the test agent
        PluginManager.registerAgent(testAgent);

        // Create a temporary agent file for testing
        testAgentPath = path.join(process.cwd(), 'test-streaming-cache-agent.mjs');
        const agentContent = `
import { createAgent } from './packages/core/dist/index.js';

export default createAgent({
    manifest: {
        name: 'streaming-cache-test-agent',
        version: '1.0.0',
        cache: {
            enabled: true,
            ttlSeconds: 60,
            excludePaths: ['timestamp']
        }
    },
    async handleTask(ctx) {
        await new Promise(resolve => setTimeout(resolve, 100));
        return {
            result: 'test-result',
            processedAt: new Date().toISOString(),
            executionTime: 100
        };
    }
}, import.meta.url);
        `;
        fs.writeFileSync(testAgentPath, agentContent);
    });

    afterEach(() => {
        // Clean up test files
        if (fs.existsSync(testAgentPath)) {
            fs.unlinkSync(testAgentPath);
        }
    });

    describe('Non-streaming mode caching', () => {
        it('should cache results in non-streaming mode', async () => {
            const input = { operation: 'test', data: 'non-streaming' };

            // Mock cache miss on first call
            mockPrismaInstance.agentResultCache.findUnique.mockResolvedValueOnce(null);
            mockPrismaInstance.agentResultCache.upsert.mockResolvedValueOnce({});

            // First execution should miss cache and store result
            await runAgentWithStreaming(testAgentPath, input, {
                isStreaming: false,
                outputType: 'json'
            });

            // Verify cache was checked
            expect(mockPrismaInstance.agentResultCache.findUnique).toHaveBeenCalledWith({
                where: {
                    tenantId_agentName_cacheKey: {
                        tenantId: 'default',
                        agentName: 'streaming-cache-test-agent',
                        cacheKey: expect.any(String)
                    }
                }
            });

            // Verify result was cached
            expect(mockPrismaInstance.agentResultCache.upsert).toHaveBeenCalledWith({
                where: {
                    tenantId_agentName_cacheKey: {
                        tenantId: 'default',
                        agentName: 'streaming-cache-test-agent',
                        cacheKey: expect.any(String)
                    }
                },
                update: expect.objectContaining({
                    result: expect.any(Object),
                    expiresAt: expect.any(Date)
                }),
                create: expect.objectContaining({
                    tenantId: 'default',
                    agentName: 'streaming-cache-test-agent',
                    cacheKey: expect.any(String),
                    result: expect.any(Object),
                    expiresAt: expect.any(Date)
                })
            });
        });
    });

    describe('Streaming mode caching', () => {
        it('should cache results in streaming mode (NEW BEHAVIOR)', async () => {
            const input = { operation: 'test', data: 'streaming' };

            // Mock cache miss on first call
            mockPrismaInstance.agentResultCache.findUnique.mockResolvedValueOnce(null);
            mockPrismaInstance.agentResultCache.upsert.mockResolvedValueOnce({});

            // First execution should miss cache and store result
            await runAgentWithStreaming(testAgentPath, input, {
                isStreaming: true,
                outputType: 'json'
            });

            // Allow background caching to complete
            await new Promise(resolve => setTimeout(resolve, 200));

            // Verify cache was checked
            expect(mockPrismaInstance.agentResultCache.findUnique).toHaveBeenCalledWith({
                where: {
                    tenantId_agentName_cacheKey: {
                        tenantId: 'default',
                        agentName: 'streaming-cache-test-agent',
                        cacheKey: expect.any(String)
                    }
                }
            });

            // Verify result was cached (this is the key fix!)
            expect(mockPrismaInstance.agentResultCache.upsert).toHaveBeenCalledWith({
                where: {
                    tenantId_agentName_cacheKey: {
                        tenantId: 'default',
                        agentName: 'streaming-cache-test-agent',
                        cacheKey: expect.any(String)
                    }
                },
                update: expect.objectContaining({
                    result: expect.any(Object),
                    expiresAt: expect.any(Date)
                }),
                create: expect.objectContaining({
                    tenantId: 'default',
                    agentName: 'streaming-cache-test-agent',
                    cacheKey: expect.any(String),
                    result: expect.any(Object),
                    expiresAt: expect.any(Date)
                })
            });
        });

        it('should return cached results in streaming mode', async () => {
            const input = { operation: 'test', data: 'streaming-cached' };
            const cachedResult = {
                id: 'cache-1',
                result: { cached: true, result: 'cached-result' },
                createdAt: new Date(),
                expiresAt: new Date(Date.now() + 60000)
            };

            // Mock cache hit
            mockPrismaInstance.agentResultCache.findUnique.mockResolvedValueOnce(cachedResult);

            // Should return quickly from cache
            const startTime = Date.now();
            await runAgentWithStreaming(testAgentPath, input, {
                isStreaming: true,
                outputType: 'json'
            });
            const executionTime = Date.now() - startTime;

            // Should be fast (cache hit)
            expect(executionTime).toBeLessThan(150); // Much less than 200ms processing time

            // Should not attempt to cache again
            expect(mockPrismaInstance.agentResultCache.upsert).not.toHaveBeenCalled();
        });
    });

    describe('Cache consistency between modes', () => {
        it('should use the same cache key for both streaming and non-streaming', async () => {
            const input = { operation: 'test', data: 'consistency-test' };

            // Mock cache misses
            mockPrismaInstance.agentResultCache.findUnique.mockResolvedValue(null);
            mockPrismaInstance.agentResultCache.upsert.mockResolvedValue({});

            // Run in non-streaming mode
            await runAgentWithStreaming(testAgentPath, input, {
                isStreaming: false,
                outputType: 'json'
            });

            // Run in streaming mode with same input
            await runAgentWithStreaming(testAgentPath, input, {
                isStreaming: true,
                outputType: 'json'
            });

            // Allow background processing
            await new Promise(resolve => setTimeout(resolve, 200));

            // Both calls should use the same cache key
            const nonStreamingCall = mockPrismaInstance.agentResultCache.findUnique.mock.calls[0];
            const streamingCall = mockPrismaInstance.agentResultCache.findUnique.mock.calls[1];

            expect(nonStreamingCall[0].where.tenantId_agentName_cacheKey.cacheKey)
                .toBe(streamingCall[0].where.tenantId_agentName_cacheKey.cacheKey);
        });
    });
}); 