import type { TaskContext } from '../shared/types/index.js';
import type { InternalTaskContext } from '../loop/internalContext.js';
import {
    TurnTraceExtensionSchema,
    type TurnTraceExtension,
} from '../types/turnTrace.js';

/**
 * Record compact, namespaced telemetry on this turn’s TurnTrace.
 * Invalid items are skipped (do not fail the turn). No-op when traces are not collected.
 * Reserved prefixes `aplret.` and `callagent.` are for framework-owned extensions.
 */
export function recordTurnTraceExtension(ctx: TaskContext, extension: TurnTraceExtension): void {
    const iCtx = ctx as InternalTaskContext;
    if (!iCtx.__turnTraceCollector) return;
    const parsed = TurnTraceExtensionSchema.safeParse(extension);
    if (!parsed.success) return;
    const buffer = iCtx.__turnTraceExtensions ?? [];
    buffer.push(parsed.data);
    iCtx.__turnTraceExtensions = buffer;
}
