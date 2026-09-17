import { jest } from '@jest/globals';
import {
    installLoggingContextConsoleBridge,
    withLoggingContext,
    updateLoggingContext,
} from '../src/loggingContext.js';
import { ComponentLogger } from '../src/logger.js';

describe('ComponentLogger and loggingContext', () => {
    it('includes logging context in prefixes and metadata', async () => {
        await withLoggingContext({ taskId: 'task-12345678', tenantId: 'tenant', agentId: 'agent', turn: 3 }, async () => {
            const logger = new ComponentLogger({ level: 'debug', prefix: 'Test' });
            const child = logger.createLogger({ prefix: 'Child' });

            const spy = jest.spyOn(console, 'debug').mockImplementation(() => { });
            logger.debug('hello', { a: 1 });
            expect(spy).toHaveBeenCalled();
            spy.mockRestore();

            const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => { });
            child.warn('warned', { b: 2 });
            expect(warnSpy).toHaveBeenCalled();
            warnSpy.mockRestore();
        });
    });

    it('serializes error contexts safely', async () => {
        await withLoggingContext({ taskId: 'err-task' }, async () => {
            updateLoggingContext({ stage: 'test' });
            const logger = new ComponentLogger({ level: 'error', prefix: 'Err' });
            const errSpy = jest.spyOn(console, 'error').mockImplementation(() => { });
            const circular: any = { foo: 'bar' };
            circular.self = circular;
            logger.error('boom', new Error('kaboom'), { circular });
            expect(errSpy).toHaveBeenCalled();
            errSpy.mockRestore();
        });
    });

    it('forwards scoped console output to a logging sink', async () => {
        installLoggingContextConsoleBridge();
        const sink = jest.fn(() => undefined);

        await withLoggingContext({ taskId: 'sink-task', logSink: sink }, async () => {
            console.info('hello', { value: 1 });
        });

        expect(sink).toHaveBeenCalledWith(expect.objectContaining({
            level: 'info',
            message: expect.stringContaining('hello'),
            context: expect.objectContaining({ taskId: 'sink-task' }),
        }));
    });
});
