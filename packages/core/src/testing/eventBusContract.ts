import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import type { IEventBus } from '../public-types/eventbus/types.js';
import { createBusEvent } from '../eventbus/busEventHelpers.js';
import { v7 as uuidv7 } from 'uuid';

export type EventBusContractContext = {
    eventBus: IEventBus;
    close?: () => Promise<void>;
};

export type EventBusContractFactory = () => Promise<EventBusContractContext>;

/**
 * Shared IEventBus contract (5.4c.1). Register with your adapter factory inside a `describe` block or at the root.
 */
export function runEventBusContract(suiteName: string, factory: EventBusContractFactory): void {
    describe(suiteName, () => {
        let bus: IEventBus;
        let close: (() => Promise<void>) | undefined;

        beforeEach(async () => {
            const ctx = await factory();
            bus = ctx.eventBus;
            close = ctx.close;
        });

        afterEach(async () => {
            await close?.();
            close = undefined;
        });

        it('delivers publish to a subscriber on the same channel', async () => {
            const received: string[] = [];
            const { unsubscribe } = await bus.subscribe('contract.ch', async (ev) => {
                received.push(ev.payload.type);
            });
            await bus.publish(
                createBusEvent({
                    channel: 'contract.ch',
                    cloud: {
                        id: uuidv7(),
                        type: 'evt-a',
                        source: '/contract',
                        time: new Date().toISOString(),
                        data: {},
                    },
                })
            );
            await new Promise((r) => setTimeout(r, 80));
            expect(received).toEqual(['evt-a']);
            await unsubscribe();
        });

        it('preserves publication order for a single channel with one subscriber', async () => {
            const types: string[] = [];
            const { unsubscribe } = await bus.subscribe('order.ch', async (ev) => {
                types.push(ev.payload.type);
            });
            for (let i = 0; i < 3; i++) {
                await bus.publish(
                    createBusEvent({
                        channel: 'order.ch',
                        cloud: {
                            id: uuidv7(),
                            type: `seq-${i}`,
                            source: '/contract',
                            time: new Date().toISOString(),
                            data: {},
                        },
                    })
                );
            }
            await new Promise((r) => setTimeout(r, 100));
            expect(types).toEqual(['seq-0', 'seq-1', 'seq-2']);
            await unsubscribe();
        });

        it('stops delivery after unsubscribe', async () => {
            let count = 0;
            const { unsubscribe } = await bus.subscribe('stop.ch', async () => {
                count += 1;
            });
            await unsubscribe();
            await bus.publish(
                createBusEvent({
                    channel: 'stop.ch',
                    cloud: {
                        id: uuidv7(),
                        type: 'x',
                        source: '/contract',
                        time: new Date().toISOString(),
                        data: {},
                    },
                })
            );
            await new Promise((r) => setTimeout(r, 40));
            expect(count).toBe(0);
        });

        it('delivers one copy to each concurrent subscriber on the same channel', async () => {
            const a: string[] = [];
            const b: string[] = [];
            const s1 = await bus.subscribe('fan.ch', async (ev) => {
                a.push(ev.payload.type);
            });
            const s2 = await bus.subscribe('fan.ch', async (ev) => {
                b.push(ev.payload.type);
            });
            await bus.publish(
                createBusEvent({
                    channel: 'fan.ch',
                    cloud: {
                        id: uuidv7(),
                        type: 'fanout',
                        source: '/contract',
                        time: new Date().toISOString(),
                        data: {},
                    },
                })
            );
            await new Promise((r) => setTimeout(r, 100));
            expect(a).toEqual(['fanout']);
            expect(b).toEqual(['fanout']);
            await s1.unsubscribe();
            await s2.unsubscribe();
        });
    });
}
