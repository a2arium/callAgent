import { jest } from '@jest/globals';
import { ToolExecutionService } from '../src/runner/ToolExecutionService';

describe('ToolExecutionService', () => {
    let service: ToolExecutionService;

    beforeEach(() => {
        service = new ToolExecutionService();
    });

    it('should register and retrieve tools', () => {
        const mockTool = jest.fn();
        service.register('testParams', mockTool);
        expect(service.has('testParams')).toBe(true);
        expect(service.has('nonExistent')).toBe(false);
    });

    it('should invoke a registered tool', async () => {
        const mockFn = jest.fn(async (args: any) => ({ result: args.value * 2 }));
        service.register('double', mockFn);

        const result = await service.invoke('double', { value: 21 });

        expect(result.success).toBe(true);
        expect(result.output).toEqual({ result: 42 });
        expect(result.durationMs).toBeGreaterThanOrEqual(0);
        expect(mockFn).toHaveBeenCalledWith({ value: 21 }, undefined);
    });

    it('should fail when invoking non-existent tool', async () => {
        const result = await service.invoke('ghost', {});

        expect(result.success).toBe(false);
        expect(result.error).toBeInstanceOf(Error);
        expect((result.error as Error).message).toContain('not found');
    });

    it('should handle tool execution errors', async () => {
        const errorTool = jest.fn(() => { throw new Error('Boom'); });
        service.register('explode', errorTool);

        const result = await service.invoke('explode', {});

        expect(result.success).toBe(false);
        expect(result.error).toBeInstanceOf(Error);
        expect((result.error as Error).message).toBe('Boom');
    });

    it('should provide context to tools', async () => {
        const ctxTool = jest.fn((args, ctx) => ctx);
        service.register('echoCtx', ctxTool);

        const context = { userId: '123' };
        const result = await service.invoke('echoCtx', {}, context);

        expect(result.success).toBe(true);
        expect(result.output).toBe(context);
        expect(ctxTool).toHaveBeenCalledWith({}, context);
    });

    it('should expose context capability compatible interface', async () => {
        const mockFn = jest.fn(async () => 'success');
        service.register('test', mockFn);

        const capability = service.asContextCapability();
        const result = await capability.invoke('test', {});

        expect(result).toBe('success');
    });

    it('capability should throw directly on error', async () => {
        service.register('fail', async () => { throw new Error('Fail'); });
        const capability = service.asContextCapability();

        await expect(capability.invoke('fail', {})).rejects.toThrow('Fail');
    });
});
