
import { TelemetryNode, UsageInfo } from './TelemetryNode.js';

export class ToolNode extends TelemetryNode {
    public readonly toolName: string;

    constructor(toolName: string, parentId: string, id?: string, traceId?: string) {
        super('tool', parentId, id, traceId);
        this.toolName = toolName;
    }
}
