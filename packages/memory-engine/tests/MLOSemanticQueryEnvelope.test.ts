import { describe, expect, it, jest } from '@jest/globals';
import { MLOSemanticBackend } from '../src/MLOBackends.js';
import { UnifiedMemoryService } from '../src/UnifiedMemoryService.js';

function serviceWithProcessedData(processedData: unknown) {
    const read = jest.fn(async () => []);
    const remove = jest.fn(async () => 0);
    const service = Object.create(UnifiedMemoryService.prototype) as any;
    service.tenantId = 'tenant-a';
    service.logger = { debug: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn() };
    service.mlo = {
        processMemoryItem: jest.fn(async () => ({
            success: true,
            processedItems: [{ data: processedData }],
        })),
    };
    service.semanticMemoryAdapter = { read, remove };
    return { service: service as UnifiedMemoryService, read, remove };
}

function serviceWithProcessor(
    processor: (item: { data: { input: Record<string, any>; options?: Record<string, any> } }) => Promise<any>
) {
    const read = jest.fn(async () => []);
    const remove = jest.fn(async () => 0);
    const service = Object.create(UnifiedMemoryService.prototype) as any;
    service.tenantId = 'tenant-a';
    service.logger = { debug: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn() };
    service.mlo = { processMemoryItem: jest.fn(processor) };
    service.semanticMemoryAdapter = { read, remove };
    return { service: service as UnifiedMemoryService, read, remove };
}

describe('MLO semantic query envelope', () => {
    const input = {
        tags: ['ready', 'site:42'],
        filters: [{ path: 'state', operator: '=' as const, value: 'ready' }],
        limit: 25,
        orderBy: { path: 'updatedAt', direction: 'asc' as const },
    };
    const options = { backend: 'sql', limit: 25, orderBy: input.orderBy };

    it('allows advisory output while executing the exact original query', async () => {
        const { service, read } = serviceWithProcessedData({
            input: structuredClone(input),
            options: structuredClone(options),
            advisory: { trace: 'safe' },
        });
        await service.getManySemanticMemory(input, options);
        expect((read.mock.calls as unknown[][])[0]).toEqual([input, options, 'tenant-a']);
    });

    it.each([
        ['required tags', { ...input, tags: ['ready'] }, options],
        ['filters', { ...input, filters: [] }, options],
        ['limit', { ...input, limit: 100 }, options],
        ['order', { ...input, orderBy: { path: 'createdAt', direction: 'asc' as const } }, options],
        ['backend', input, { ...options, backend: 'custom' }],
    ])('rejects mutation of protected %s before adapter I/O', async (_name, changedInput, changedOptions) => {
        const { service, read } = serviceWithProcessedData({ input: changedInput, options: changedOptions });
        await expect(service.getManySemanticMemory(input, options))
            .rejects.toMatchObject({ code: 'SEMANTIC_QUERY_ENVELOPE_MUTATED' });
        expect(read).not.toHaveBeenCalled();
    });

    it('applies the same protection to structured removal', async () => {
        const { service, remove } = serviceWithProcessedData({
            structured: { input: { ...input, tags: ['ready'] }, options },
        });
        await expect(service.deleteManySemanticMemory(input, options))
            .rejects.toMatchObject({ code: 'SEMANTIC_QUERY_ENVELOPE_MUTATED' });
        expect(remove).not.toHaveBeenCalled();
    });

    it.each([
        ['tags', (data: any) => data.input.tags.pop()],
        ['nested filters', (data: any) => { data.input.filters[0].value = 'draft'; }],
        ['input limit', (data: any) => { data.input.limit = 100; }],
        ['options order', (data: any) => { data.options.orderBy.path = 'createdAt'; }],
        ['options backend', (data: any) => { data.options.backend = 'custom'; }],
    ])('rejects in-place mutation of protected %s before read I/O', async (_name, mutate) => {
        const { service, read } = serviceWithProcessor(async (item) => {
            mutate(item.data);
            return { success: true, processedItems: [item] };
        });
        await expect(service.getManySemanticMemory(structuredClone(input), structuredClone(options)))
            .rejects.toMatchObject({ code: 'SEMANTIC_QUERY_ENVELOPE_MUTATED' });
        expect(read).not.toHaveBeenCalled();
    });

    it('rejects in-place mutation even when MLO subsequently reports failure', async () => {
        const { service, read } = serviceWithProcessor(async (item) => {
            item.data.input.tags.length = 0;
            return { success: false, processedItems: [], metadata: { error: 'processor failed' } };
        });
        await expect(service.getManySemanticMemory(structuredClone(input), structuredClone(options)))
            .rejects.toMatchObject({ code: 'SEMANTIC_QUERY_ENVELOPE_MUTATED' });
        expect(read).not.toHaveBeenCalled();
    });

    it('does not misclassify an ordinary MLO failure as envelope mutation', async () => {
        const { service, read } = serviceWithProcessor(async () => ({
            success: false,
            processedItems: [],
            metadata: { error: 'processor unavailable' },
        }));
        await expect(service.getManySemanticMemory(structuredClone(input), structuredClone(options)))
            .rejects.toThrow('Failed to process semantic memory query: processor unavailable');
        expect(read).not.toHaveBeenCalled();
    });

    it('rejects a dropped envelope before adapter I/O', async () => {
        const { service, remove } = serviceWithProcessor(async () => ({
            success: true,
            processedItems: [{ data: { advisory: true } }],
        }));
        await expect(service.deleteManySemanticMemory(structuredClone(input), structuredClone(options)))
            .rejects.toMatchObject({ code: 'SEMANTIC_QUERY_ENVELOPE_MUTATED' });
        expect(remove).not.toHaveBeenCalled();
    });

    it('executes a frozen prepared copy rather than caller or MLO-owned objects', async () => {
        const callerInput = structuredClone(input);
        const callerOptions = structuredClone(options);
        let observedData: any;
        const { service, read } = serviceWithProcessor(async (item) => {
            observedData = item.data;
            return { success: true, processedItems: [item] };
        });
        await service.getManySemanticMemory(callerInput, callerOptions);
        const [executedInput, executedOptions] = (read.mock.calls as unknown[][])[0] as [any, any];
        expect(executedInput).not.toBe(callerInput);
        expect(executedInput).not.toBe(observedData.input);
        expect(Object.isFrozen(executedInput)).toBe(true);
        expect(Object.isFrozen(executedInput.filters[0])).toBe(true);
        expect(Object.isFrozen(executedOptions)).toBe(true);
    });

    it('advertises only capabilities supplied by the wrapped adapter', () => {
        const service = {} as UnifiedMemoryService;
        expect(new MLOSemanticBackend(service).capabilities).toBeUndefined();
        const capabilities = {
            tagQuery: { allOf: true, returnsStoredTags: true },
            predicateRemoval: { allOfTags: true, predicateRechecked: true, returnsCount: true },
        } as const;
        expect(new MLOSemanticBackend(service, { capabilities }).capabilities).toEqual({
            ...capabilities,
            backendKind: 'mlo',
        });
    });
});
