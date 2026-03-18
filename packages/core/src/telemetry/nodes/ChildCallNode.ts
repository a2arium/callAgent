import { TelemetryNode } from './TelemetryNode.js';

export class ChildCallNode extends TelemetryNode {
    public readonly childToken: string;
    public readonly childAgentId?: string;
    public childTaskId?: string;

    constructor(
        childToken: string,
        parentId: string,
        childAgentId?: string,
        id?: string,
        traceId?: string
    ) {
        super('child', parentId, id, traceId);
        this.childToken = childToken;
        this.childAgentId = childAgentId;
    }
}
