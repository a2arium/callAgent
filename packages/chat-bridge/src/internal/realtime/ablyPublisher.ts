import type { RealtimePublisher, ChatEvent } from '../../types.js';

export class AblyPublisher implements RealtimePublisher {
    private client: any;
    constructor(apiKey?: string) {
        if (process.env.ENABLE_REALTIME !== 'true') {
            this.client = null;
            return;
        }
        const key = apiKey || process.env.ABLY_API_KEY;
        if (!key) {
            this.client = null;
            return;
        }
        this.client = (require('ably')).Realtime.Promise({ key });
    }
    async publish(channelKey: string, event: ChatEvent): Promise<void> {
        if (!this.client) return; // gate disabled
        const ch = this.client.channels.get(channelKey);
        await ch.publish(event.type, event);
    }
}


