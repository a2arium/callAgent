import type { TelemetryNode, UsageInfo } from './nodes/TelemetryNode.js';
import type { TurnTrace } from '../types/turnTrace.js';

export type TelemetryProvider = {
    name: string;

    onNodeStart(node: TelemetryNode): Promise<void> | void;
    onNodeEnd(node: TelemetryNode): Promise<void> | void;
    onNodeFailure(node: TelemetryNode, error: Error): Promise<void> | void;
    onUsageUpdate(node: TelemetryNode, usage: UsageInfo): Promise<void> | void;

    /** Called exactly once per turn with the complete TurnTrace. This is the authoritative structured turn export hook. */
    onTurnTrace(trace: TurnTrace): Promise<void> | void;
};
