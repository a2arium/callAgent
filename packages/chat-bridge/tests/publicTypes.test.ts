import type {
    Invoker,
    ResumeParams,
    RuntimeStreamSink,
    StartParams,
    StreamingInvoker,
} from '../src/types.js';

describe('chat bridge public streaming types', () => {
    test('exposes compatibility and streaming invoker contracts', () => {
        const sink: RuntimeStreamSink = async (_event) => { };
        const startParams: StartParams = {
            id: 'task-public-types',
            agentId: 'agent',
            route: { network: 'web', conversationId: 'c1' },
            input: { route: { network: 'web', conversationId: 'c1' }, text: 'hi' },
        };
        const resumeParams: ResumeParams = {
            id: 'task-public-types',
            token: 'tok',
            route: { network: 'web', conversationId: 'c1' },
            input: { route: { network: 'web', conversationId: 'c1' }, text: 'answer' },
        };

        const invoker: Invoker = {
            async start(_params, streamSink) {
                expect(streamSink).toBe(sink);
                return { id: 'task-public-types', status: 'completed', output: { ok: true } };
            },
            async resume() {
                return { id: 'task-public-types', status: 'input_required', token: 'tok-next' };
            },
        };
        const streamingInvoker: StreamingInvoker = {
            async *startStream() { },
            async *resumeStream() { },
        };

        expect(typeof invoker.start).toBe('function');
        expect(typeof invoker.resume).toBe('function');
        expect(typeof streamingInvoker.startStream).toBe('function');
        expect(typeof streamingInvoker.resumeStream).toBe('function');
        void invoker.start(startParams, sink);
        void invoker.resume(resumeParams, sink);
    });
});
