import { describe, expect, it, jest } from '@jest/globals';
import {
    AgentResultCache,
    ArtifactImpl,
} from '@a2arium/callagent-memory-engine';
import {
    ARTIFACT_STORAGE_UNAVAILABLE,
    createArtifactFactory,
} from '../src/context/artifactFactory.js';

function createArtifactCache() {
    const values = new Map<string, unknown>();
    const storeArtifact = jest.fn(async (
        tenantId: string,
        artifactId: string | undefined,
        value: unknown
    ) => {
        const id = artifactId ?? `artifact-${values.size + 1}`;
        values.set(`${tenantId}:${id}`, value);
        return { artifactId: id, size: JSON.stringify(value).length };
    });
    const getCachedResult = jest.fn(async (
        _agentName: string,
        input: { artifactId: string },
        _excludePaths: string[],
        tenantId: string
    ) => values.get(`${tenantId}:${input.artifactId}`) ?? null);
    return {
        cache: { storeArtifact, getCachedResult } as unknown as AgentResultCache,
        getCachedResult,
        storeArtifact,
    };
}

describe('createArtifactFactory', () => {
    it('returns synchronous writable handles for create, text, and json', async () => {
        const { cache } = createArtifactCache();
        const resolveCache = jest.fn(() => cache);
        const artifacts = createArtifactFactory({
            tenantId: 'tenant-a',
            resolveCache,
        });

        const empty = artifacts.create<string>();
        const text = artifacts.text('hello');
        const json = artifacts.json({ ok: true });

        for (const handle of [empty, text, json]) {
            expect(handle).not.toBeInstanceOf(Promise);
            expect(typeof (handle as any).set).toBe('function');
            expect(typeof (handle as any).load).toBe('function');
            expect(typeof (handle as any).then).toBe('function');
        }
        expect((text as any).mimeType).toBe('text/plain');
        expect((json as any).mimeType).toBe('application/json');

        await (empty as any).set('later');
        await expect(Promise.resolve(empty)).resolves.toBe('later');
        await expect(Promise.resolve(text)).resolves.toBe('hello');
        await expect(Promise.resolve(json)).resolves.toEqual({ ok: true });
        expect(resolveCache).toHaveBeenCalledTimes(1);
    });

    it('keeps artifact loads tenant-scoped', async () => {
        const { cache } = createArtifactCache();
        const artifacts = createArtifactFactory({
            tenantId: 'tenant-a',
            resolveCache: () => cache,
        });
        const handle = artifacts.text('tenant-a-secret') as ArtifactImpl<string>;
        await handle.set('tenant-a-secret');

        const crossTenant = new ArtifactImpl<string>(
            handle.id,
            cache,
            'tenant-b',
            'text/plain'
        );
        await expect(crossTenant.load()).rejects.toThrow('Artifact not found');
    });

    it('rejects awaited writes with a stable error when storage is unavailable', async () => {
        const artifacts = createArtifactFactory({
            tenantId: 'tenant-a',
            resolveCache: () => undefined,
        });
        const handle = artifacts.create<string>() as ArtifactImpl<string>;

        await expect(handle.set('value')).rejects.toMatchObject({
            code: ARTIFACT_STORAGE_UNAVAILABLE,
        });
    });

    it('keeps background write failures observable through the handle', async () => {
        const failure = new Error('store unavailable');
        const cache = {
            storeArtifact: jest.fn(async () => {
                throw failure;
            }),
        } as unknown as AgentResultCache;
        const onFailure = jest.fn();
        const artifacts = createArtifactFactory({
            tenantId: 'tenant-a',
            resolveCache: () => cache,
            onFailure,
        });

        const handle = artifacts.text('value') as ArtifactImpl<string>;

        await expect(handle.load()).rejects.toBe(failure);
        expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({
            operation: 'background_write',
            error: failure,
            artifactId: expect.any(String),
        }));
    });
});
