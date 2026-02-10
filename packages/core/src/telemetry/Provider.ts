
import { TelemetryNode, UsageInfo } from './nodes/TelemetryNode.js';

export interface TelemetryProvider {
    name: string;

    // Lifecycle hooks
    onNodeStart(node: TelemetryNode): Promise<void> | void;
    onNodeEnd(node: TelemetryNode): Promise<void> | void;
    onNodeFailure(node: TelemetryNode, error: Error): Promise<void> | void;

    // Usage updates
    onUsageUpdate(node: TelemetryNode, usage: UsageInfo): Promise<void> | void;
}
