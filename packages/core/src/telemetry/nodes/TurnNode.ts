
import { TelemetryNode } from './TelemetryNode.js';

export class TurnNode extends TelemetryNode {
    public readonly turnIndex: number;

    constructor(turnIndex: number, parentId: string, id?: string, traceId?: string) {
        super('turn', parentId, id, traceId);
        this.turnIndex = turnIndex;
    }
}
