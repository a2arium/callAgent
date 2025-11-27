import { jest } from '@jest/globals';
import { createCallMessengerChatSender, normalizeFromCallMessengerEvent } from '../src/integrations/callMessenger.js';

describe('callMessenger integration helpers', () => {
    it('createCallMessengerChatSender sends markdown message and image media', async () => {
        const sent: any[] = [];
        const cm = { send: jest.fn(async (_dest: string, markup: any) => { sent.push(markup); }) };
        const sender = createCallMessengerChatSender(cm);
        const route = { network: 'cm', conversationId: 'conv1' } as any;

        await sender.sendMessage(route, 'hello world');
        expect(cm.send).toHaveBeenCalledWith('cm:conv1', expect.objectContaining({ kind: 'text', markdown: 'hello world' }));

        await sender.sendMedia(route, { type: 'image', url: 'http://img', bytesBase64: 'b64', caption: 'c' });
        expect(cm.send).toHaveBeenCalledWith('cm:conv1', expect.objectContaining({ kind: 'image', url: 'http://img', caption: 'c' }));

        await sender.sendMarkup(route, { kind: 'text', html: 'ok' } as any);
        expect(cm.send).toHaveBeenCalledWith('cm:conv1', expect.objectContaining({ kind: 'text', html: 'ok' }));
    });

    it('normalizeFromCallMessengerEvent maps inbound message with image', () => {
        const evt = {
            type: 'message.received',
            conversationId: 'cm:conv2',
            channel: 'cm',
            userId: 'u1',
            message: { text: 'hi', type: 'image', url: 'http://img' }
        };
        const normalized = normalizeFromCallMessengerEvent(evt);
        expect(normalized).toMatchObject({
            network: 'cm',
            conversationId: 'conv2',
            userId: 'u1',
            text: 'hi'
        });
        expect(normalized?.attachments?.[0]).toMatchObject({ type: 'image', url: 'http://img' });
    });

    it('normalizeFromCallMessengerEvent returns null for invalid input', () => {
        expect(normalizeFromCallMessengerEvent(null as any)).toBeNull();
        expect(normalizeFromCallMessengerEvent({ conversationId: 'missing-channel' } as any)).toBeNull();
    });
});
