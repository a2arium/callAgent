import { TelemetryNode } from './TelemetryNode.js';
import type { TurnTrace } from '../../types/turnTrace.js';

export class TurnNode extends TelemetryNode {
    public readonly turnIndex: number;
    public turnTrace?: TurnTrace;

    constructor(turnIndex: number, parentId: string, id?: string, traceId?: string) {
        super('turn', parentId, id, traceId);
        this.turnIndex = turnIndex;
    }
}
