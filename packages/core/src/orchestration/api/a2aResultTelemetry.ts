/** Non-enumerable telemetry attached to A2A `sendTaskToAgent` results (child trace + agent node). */
export const A2A_RESULT_TELEMETRY_SYM = Symbol.for('callagent.a2aResultTelemetry');

export type A2aResultTelemetry = {
    /** Child task `AgentNode` id created in `executeTargetAgent`. */
    childAgentNodeId?: string;
    /** Child context `telemetry.traceId` after the child run. */
    childTraceId?: string;
};

export function attachA2aResultTelemetry(result: unknown, telemetry: A2aResultTelemetry): void {
    if (result != null && typeof result === 'object') {
        Object.defineProperty(result, A2A_RESULT_TELEMETRY_SYM, {
            value: telemetry,
            enumerable: false,
            configurable: true,
        });
    }
}

export function readA2aResultTelemetry(result: unknown): A2aResultTelemetry | undefined {
    if (result != null && typeof result === 'object' && A2A_RESULT_TELEMETRY_SYM in result) {
        return (result as Record<symbol, A2aResultTelemetry>)[A2A_RESULT_TELEMETRY_SYM];
    }
    return undefined;
}
