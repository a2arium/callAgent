/** Set `CALLAGENT_DEBUG_TURN_OPIK=1` for verbose turn → Opik diagnostics (loopRunner, collector, provider). */
export function turnOpikDiagEnabled(): boolean {
    const v = process.env.CALLAGENT_DEBUG_TURN_OPIK;
    return v === '1' || v === 'true' || v === 'yes';
}
