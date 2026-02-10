
import { TelemetryNode } from './TelemetryNode.js';

export class WorkflowNode extends TelemetryNode {
    public readonly name: string;

    constructor(name: string, parentId: string, id?: string, traceId?: string) {
        super('workflow', parentId, id, traceId);
        this.name = name;
    }
}
