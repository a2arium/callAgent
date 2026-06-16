import { describe, it, expect, afterEach } from '@jest/globals';
import {
    bootstrapCompositionRoot,
    bootstrapCompositionRootInternal,
} from '../../src/runtime/bootstrapCompositionRoot.js';
import { EngineLocator } from '../../src/orchestration/EngineLocator.js';
import { TaskEngine } from '../../src/orchestration/taskEngine.js';
import { InProcessRuntimeDriver } from '../../src/runtime/inProcessRuntimeDriver.js';
import { createInMemoryEventBus } from '../../src/eventbus/inMemoryEventBus.js';

describe('bootstrapCompositionRoot', () => {
    afterEach(() => {
        EngineLocator.setEngine(null);
    });

    it('constructs TaskEngine and registers EngineLocator by default', async () => {
        const root = await bootstrapCompositionRoot();

        expect(root.engine).toBeInstanceOf(TaskEngine);
        expect(root.eventBus).toBeDefined();
        expect(EngineLocator.getEngine()).toBe(root.engine);

        root.shutdown();
        expect(EngineLocator.getEngine()).toBeNull();
    });

    it('runs registerAgents before constructing the engine', async () => {
        const order: string[] = [];
        const root = await bootstrapCompositionRoot({
            registerAgents: async () => {
                order.push('agents');
            },
            taskEngine: {
                eventBus: createInMemoryEventBus(),
            },
        });

        order.push('after');
        expect(order).toEqual(['agents', 'after']);
        root.shutdown();
    });

    it('skips EngineLocator when registerEngineLocator is false', async () => {
        const prior = EngineLocator.getEngine();
        const root = await bootstrapCompositionRoot({ registerEngineLocator: false });
        expect(EngineLocator.getEngine()).toBe(prior);
        root.shutdown();
    });

    it('internal bootstrap exposes in-process runtime seam handles', async () => {
        const root = await bootstrapCompositionRootInternal();

        expect(root.runtimeDriver).toBeInstanceOf(InProcessRuntimeDriver);
        expect(root.turnExecutor).toBe(root.runtimeDriver.getTurnExecutor());
        expect(root.engine.getCompositionRuntimeDriver()).toBe(root.runtimeDriver);

        root.shutdown();
    });
});
