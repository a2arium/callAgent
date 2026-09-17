import type { TaskStatus } from '../shared/types/StreamingEvents.js';

export type TerminalDelivery = {
    deliveryKey: string;
    status: TaskStatus;
};

/** Process-local transport dedupe; the durable terminal record supplies the key. */
export function createTerminalDeliveryGate(
    deliver: (status: TaskStatus) => void
): (terminal: TerminalDelivery) => boolean {
    const delivered = new Set<string>();
    return (terminal) => {
        if (delivered.has(terminal.deliveryKey)) return false;
        delivered.add(terminal.deliveryKey);
        deliver(terminal.status);
        return true;
    };
}
