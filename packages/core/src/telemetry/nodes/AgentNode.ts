
import { TelemetryNode } from './TelemetryNode.js';

export class AgentNode extends TelemetryNode {
    public readonly agentName: string;

    constructor(agentName: string, id?: string, parentId?: string, traceId?: string) {
        super('agent', parentId, id, traceId);
        this.agentName = agentName;
    }
}
