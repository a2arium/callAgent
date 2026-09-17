import { afterAll, describe, expect, it } from '@jest/globals';
import { createMemoryRegistry } from '../src/createMemoryRegistry.js';

const DB_URL = process.env.MEMORY_DATABASE_URL;
const describeIfDb = DB_URL ? describe : describe.skip;
const CURSOR_KEY = Buffer.alloc(32, 23).toString('base64url');

describeIfDb('semantic pagination public facade', () => {
    const tenantId = `semantic-page-facade-${Date.now()}`;
    const adapters: Array<{ delete(key: string): Promise<void>; disconnect?(): Promise<void> }> = [];

    afterAll(async () => {
        for (const adapter of adapters) {
            for (const key of ['facade:a', 'facade:b', 'facade:c']) {
                await adapter.delete(key).catch(() => undefined);
            }
            await adapter.disconnect?.();
        }
    });

    it('continues a SQL page through a reconstructed registry', async () => {
        const firstRegistry = await createMemoryRegistry(tenantId, 'scheduler', undefined, {
            database: { url: DB_URL! },
            semanticCursorKey: CURSOR_KEY,
        });
        const firstAdapter = firstRegistry.semantic.backends.sql as typeof adapters[number];
        adapters.push(firstAdapter);
        expect(firstRegistry.semantic.readItemsPage).toEqual(expect.any(Function));

        for (const key of ['facade:a', 'facade:b', 'facade:c']) {
            await firstRegistry.semantic.add({ id: key, value: { ready: true }, tags: ['facade', 'ready'] });
        }
        const firstPage = await firstRegistry.semantic.readItemsPage!({
            tags: ['facade', 'ready'],
            backend: 'sql',
            orderBy: { path: 'createdAt', direction: 'asc' },
            limit: 2,
        });
        expect(firstPage.items.map((item) => item.id)).toEqual(['facade:a', 'facade:b']);
        expect(firstPage.nextCursor).toBeDefined();

        const resumedRegistry = await createMemoryRegistry(tenantId, 'scheduler', undefined, {
            database: { url: DB_URL! },
            semanticCursorKey: CURSOR_KEY,
        });
        const resumedAdapter = resumedRegistry.semantic.backends.sql as typeof adapters[number];
        adapters.push(resumedAdapter);
        const secondPage = await resumedRegistry.semantic.readItemsPage!({
            tags: ['ready', 'facade'],
            backend: 'sql',
            orderBy: { path: 'createdAt', direction: 'asc' },
            limit: 5,
            cursor: firstPage.nextCursor,
        });
        expect(secondPage.items.map((item) => item.id)).toEqual(['facade:c']);
        expect(secondPage.nextCursor).toBeUndefined();
    });
});
