import { jest } from '@jest/globals';
import { StreamTransport } from '../src/runner/StreamTransport';
import type { TaskStatus, Artifact as StreamArtifact } from '../src/shared/types/StreamingEvents';

// Mock fs and logger handled by jest auto-mocking or direct spy if needed
// But `console.log` needs to be spied on.

describe('StreamTransport', () => {
    let consoleSpy: any;

    beforeEach(() => {
        consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => { });
    });

    afterEach(() => {
        consoleSpy.mockRestore();
    });

    it('should output JSON when configured', () => {
        const transport = new StreamTransport({ outputType: 'json' });
        const status: TaskStatus = { state: 'working', timestamp: '2023-01-01' } as any;

        transport.handleStatus(status, false);

        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('"type": "status"'));
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('"status": "working"'));
    });

    it('should output SSE when configured', () => {
        const transport = new StreamTransport({ outputType: 'sse' });
        const status: TaskStatus = { state: 'completed', timestamp: '2023-01-01' } as any;

        transport.handleStatus(status, true);

        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('data: {'));
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('"final":true'));
    });

    it('should output Console text by default', () => {
        const transport = new StreamTransport({ outputType: 'console' });
        const status: TaskStatus = { state: 'working', timestamp: '2023-01-01' } as any;

        transport.handleStatus(status, false);

        expect(consoleSpy).toHaveBeenCalledWith('Status: working');
    });

    it('should handle artifacts', () => {
        const transport = new StreamTransport({ outputType: 'console' });
        const artifact: StreamArtifact = {
            id: '1',
            type: 'text',
            parts: [{ type: 'text', text: 'Hello Artifact' }]
        };

        transport.handleArtifact(artifact);

        expect(consoleSpy).toHaveBeenCalledWith('Hello Artifact');
    });

    it('should log working progress with percentage', () => {
        const transport = new StreamTransport({ outputType: 'console' });
        const status: TaskStatus = {
            state: 'working',
            timestamp: '2023-01-01',
            metadata: { progress: 50 },
            message: { parts: [{ type: 'text', text: 'Processing' }] }
        } as any;

        transport.handleStatus(status, false);

        expect(consoleSpy).toHaveBeenCalledWith('Progress: 50% - Processing');
        expect(consoleSpy).toHaveBeenCalledWith('Message: Processing');
    });
});
