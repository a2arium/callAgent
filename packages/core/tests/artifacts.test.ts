import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { ArtifactImpl, isArtifactMarker } from '../src/core/orchestration/ArtifactImpl.js';
import { AgentResultCache } from '../src/core/cache/AgentResultCache.js';
import { hydrateArtifacts } from '../src/core/memory/utils/hydrateArtifacts.js';
import { getMemoryPrismaClient } from '../src/core/memory/prismaSingleton.js';

import { Artifact, LOCAL_ARTIFACT_KIND } from '../src/shared/types/artifacts.js';
import { LocalArtifactImpl } from '../src/core/orchestration/LocalArtifactImpl.js';
import { offloadArtifacts } from '../src/core/memory/utils/offloadArtifacts.js';

describe('Artifact<T> System', () => {
    let cache: AgentResultCache;
    const tenantId = 'test-tenant';

    beforeAll(async () => {
        const prisma = await getMemoryPrismaClient();
        cache = new AgentResultCache(prisma);
    });

    afterAll(async () => {
        const prisma = await getMemoryPrismaClient();
        await prisma.$disconnect();
    });

    describe('LocalArtifact (Value Wrapper)', () => {
        it('should create a LocalArtifact via factory', () => {
            const value = 'test-value';
            const local = Artifact.create(value);
            expect(local.kind).toBe(LOCAL_ARTIFACT_KIND);
            expect(local.value).toBe(value);
        });

        it('should be awaitable (thenable)', async () => {
            const value = 'test-value';
            const local = Artifact.create(value);
            const result = await local;
            expect(result).toBe(value);
        });
    });

    describe('offloadArtifacts', () => {
        it('should offload a LocalArtifact and replace it with a marker', async () => {
            const value = 'offload-me';
            const local = Artifact.create(value, { mimeType: 'text/plain' });
            const state = { data: local };

            // Offload
            const nextState = await offloadArtifacts(state, cache, tenantId);

            // Check replacement
            const marker = (nextState as any).data;
            expect(isArtifactMarker(marker)).toBe(true);
            expect(marker.mimeType).toBe('text/plain');

            // Verify data is in cache
            const loaded = await cache.loadArtifact<string>(tenantId, marker.id);
            expect(loaded).toBe(value);
        });

        it('should handle nested structures recursively', async () => {
            const state = {
                list: [
                    Artifact.create('item1'),
                    { nested: Artifact.create('item2') }
                ]
            };

            const nextState = await offloadArtifacts(state, cache, tenantId);
            const list = (nextState as any).list;

            expect(isArtifactMarker(list[0])).toBe(true);
            expect(isArtifactMarker(list[1].nested)).toBe(true);

            const item1 = await cache.loadArtifact<string>(tenantId, list[0].id);
            expect(item1).toBe('item1');
        });
    });

    describe('ArtifactImpl', () => {
        it('should create an empty artifact', () => {
            const artifact = new ArtifactImpl(undefined, cache, tenantId);
            expect(artifact.kind).toBe('artifact');
            expect(artifact.id).toBeUndefined();
        });

        it('should store and load a string value', async () => {
            const artifact = new ArtifactImpl(undefined, cache, tenantId, 'text/plain');
            const testValue = 'Hello, World!';
            
            await artifact.set(testValue);
            expect(artifact.id).toBeDefined();
            
            const loaded = await artifact.load();
            expect(loaded).toBe(testValue);
        });

        it('should store and load a large JSON object', async () => {
            const artifact = new ArtifactImpl(undefined, cache, tenantId, 'application/json');
            const testData = {
                users: Array.from({ length: 1000 }, (_, i) => ({
                    id: i,
                    name: `User ${i}`,
                    email: `user${i}@example.com`,
                    metadata: { created: new Date().toISOString(), active: true }
                }))
            };
            
            await artifact.set(testData);
            expect(artifact.id).toBeDefined();
            expect(artifact.estimatedSize).toBeGreaterThan(0);
            
            const loaded = await artifact.load();
            expect(loaded).toEqual(testData);
        });

        it('should be awaitable (thenable)', async () => {
            const artifact = new ArtifactImpl(undefined, cache, tenantId);
            const testValue = { foo: 'bar', nested: { value: 42 } };
            
            await artifact.set(testValue);
            
            // Test that we can await the artifact directly
            const result = await artifact;
            expect(result).toEqual(testValue);
        });

        it('should serialize to a lightweight marker', async () => {
            const artifact = new ArtifactImpl(undefined, cache, tenantId, 'text/plain');
            await artifact.set('test data');
            
            const json = artifact.toJSON();
            expect(json.kind).toBe('artifact');
            expect(json.id).toBeDefined();
            expect(json.mimeType).toBe('text/plain');
            expect(json.estimatedSize).toBeGreaterThan(0);
            
            // Ensure serialized form is small
            const serialized = JSON.stringify(json);
            expect(serialized.length).toBeLessThan(500);
        });

        it('should throw when serializing without an ID', async () => {
            const artifact = new ArtifactImpl(undefined, cache, tenantId);
            expect(() => artifact.toJSON()).toThrow('Cannot serialize an Artifact without an ID');
        });
    });

    describe('isArtifactMarker', () => {
        it('should identify artifact markers', () => {
            const marker = {
                kind: 'artifact',
                id: 'test-id-123',
                mimeType: 'text/plain',
                estimatedSize: 100
            };
            expect(isArtifactMarker(marker)).toBe(true);
        });

        it('should reject non-artifacts', () => {
            expect(isArtifactMarker(null)).toBe(false);
            expect(isArtifactMarker(undefined)).toBe(false);
            expect(isArtifactMarker({})).toBe(false);
            expect(isArtifactMarker({ kind: 'other' })).toBe(false);
            expect(isArtifactMarker({ kind: 'artifact' })).toBe(false); // Missing id
        });
    });

    describe('hydrateArtifacts', () => {
        it('should hydrate a single artifact marker', () => {
            const marker = {
                kind: 'artifact',
                id: 'test-id-456',
                mimeType: 'application/json'
            };
            
            const hydrated = hydrateArtifacts(marker, cache, tenantId);
            expect(hydrated).toBeInstanceOf(ArtifactImpl);
            expect((hydrated as ArtifactImpl).id).toBe('test-id-456');
            expect((hydrated as ArtifactImpl).mimeType).toBe('application/json');
        });

        it('should hydrate nested artifacts in objects', () => {
            const obj = {
                result: {
                    kind: 'artifact',
                    id: 'nested-id',
                    mimeType: 'text/plain'
                },
                metadata: {
                    timestamp: Date.now(),
                    status: 'ok'
                }
            };
            
            const hydrated = hydrateArtifacts(obj, cache, tenantId) as any;
            expect(hydrated.result).toBeInstanceOf(ArtifactImpl);
            expect(hydrated.result.id).toBe('nested-id');
            expect(hydrated.metadata).toEqual(obj.metadata);
        });

        it('should hydrate artifacts in arrays', () => {
            const arr = [
                { kind: 'artifact', id: 'id-1', mimeType: 'text/plain' },
                { data: 'plain object' },
                { kind: 'artifact', id: 'id-2', mimeType: 'application/json' }
            ];
            
            const hydrated = hydrateArtifacts(arr, cache, tenantId) as any[];
            expect(hydrated[0]).toBeInstanceOf(ArtifactImpl);
            expect(hydrated[0].id).toBe('id-1');
            expect(hydrated[1]).toEqual({ data: 'plain object' });
            expect(hydrated[2]).toBeInstanceOf(ArtifactImpl);
            expect(hydrated[2].id).toBe('id-2');
        });

        it('should handle deeply nested structures', () => {
            const deep = {
                level1: {
                    level2: {
                        level3: {
                            artifact: {
                                kind: 'artifact',
                                id: 'deep-id',
                                mimeType: 'text/plain'
                            }
                        }
                    }
                }
            };
            
            const hydrated = hydrateArtifacts(deep, cache, tenantId) as any;
            expect(hydrated.level1.level2.level3.artifact).toBeInstanceOf(ArtifactImpl);
            expect(hydrated.level1.level2.level3.artifact.id).toBe('deep-id');
        });

        it('should preserve non-artifact values unchanged', () => {
            const obj = {
                string: 'test',
                number: 42,
                boolean: true,
                null: null,
                array: [1, 2, 3],
                nested: { a: 1, b: 2 }
            };
            
            const hydrated = hydrateArtifacts(obj, cache, tenantId);
            expect(hydrated).toEqual(obj);
        });
    });

    describe('Round-trip: Serialize → Hydrate', () => {
        it('should maintain data integrity through serialize/hydrate cycle', async () => {
            // Create artifact with data
            const original = new ArtifactImpl(undefined, cache, tenantId, 'application/json');
            const testData = { message: 'Large payload', items: Array.from({ length: 100 }, (_, i) => i) };
            await original.set(testData);
            
            // Serialize to marker
            const marker = original.toJSON();
            
            // Simulate saving to database (marker is what gets saved in mental state)
            const savedState = { result: marker };
            
            // Simulate loading from database and hydrating
            const loadedState = hydrateArtifacts(savedState, cache, tenantId) as any;
            
            // Verify hydrated artifact can load the original data
            expect(loadedState.result).toBeInstanceOf(ArtifactImpl);
            const loadedData = await loadedState.result.load();
            expect(loadedData).toEqual(testData);
        });
    });
});
