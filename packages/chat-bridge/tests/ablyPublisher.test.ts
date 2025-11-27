import { AblyPublisher } from '../src/internal/realtime/ablyPublisher.js';

describe('AblyPublisher', () => {
    const originalEnv = process.env.ENABLE_REALTIME;
    const originalKey = process.env.ABLY_API_KEY;

    afterEach(() => {
        process.env.ENABLE_REALTIME = originalEnv;
        process.env.ABLY_API_KEY = originalKey;
    });

    it('is disabled when ENABLE_REALTIME is not true', async () => {
        process.env.ENABLE_REALTIME = 'false';
        const pub = new AblyPublisher();
        await expect(pub.publish('ch', { type: 'completed', taskId: 't', seq: 1, ts: '', output: undefined })).resolves.toBeUndefined();
    });

    it('does not create client when key missing even if enabled', async () => {
        process.env.ENABLE_REALTIME = 'true';
        delete process.env.ABLY_API_KEY;
        const pub = new AblyPublisher();
        await pub.publish('ch', { type: 'reply', taskId: 't', seq: 1, ts: '', text: 'hi' }); // should no-op
    });
});
