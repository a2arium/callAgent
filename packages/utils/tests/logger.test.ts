import { jest } from '@jest/globals';
import { withLoggingContext, updateLoggingContext } from '../src/loggingContext.js';
import { ComponentLogger } from '../src/logger.js';

describe('ComponentLogger and loggingContext', () => {
    it('includes logging context in prefixes and metadata', () => {
        return withLoggingContext({ taskId: 'task-12345678', tenantId: 'tenant', agentId: 'agent', turn: 3 }, () => {
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

    it('serializes error contexts safely', () => {
        return withLoggingContext({ taskId: 'err-task' }, () => {
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
});
