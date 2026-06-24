import {
    installLoggingContextConsoleBridge,
    withLoggingContext,
    type LoggingSinkEntry,
} from '@a2arium/callagent-utils';
import {
    compactPayload,
    defaultMetricsRegistry,
    enforcePayloadBudget,
    readDriverMetadataMaxBytes,
} from '@a2arium/callagent-core/unstable';

type HatchetLogger = {
    info?: (message: string, extra?: Record<string, unknown>) => Promise<void> | Promise<void[]> | void;
    debug?: (message: string, extra?: Record<string, unknown>) => Promise<void> | Promise<void[]> | void;
    warn?: (message: string, extra?: Record<string, unknown>) => Promise<void> | Promise<void[]> | void;
    error?: (message: string, extra?: Record<string, unknown>) => Promise<void> | Promise<void[]> | void;
};

type HatchetContextLike = {
    logger?: HatchetLogger;
    workflowRunId?: () => string;
    taskRunExternalId?: () => string;
    retryCount?: () => number;
};

type HatchetTaskInputLike = {
    tenantId?: string;
    taskId?: string;
    agentId?: string;
};

const HATCHET_LOG_MESSAGE_LIMIT = 1000;
const HATCHET_LOG_SAFE_LIMIT = 900;

export function withHatchetTaskLogging<T>(
    input: HatchetTaskInputLike,
    ctx: HatchetContextLike,
    operation: string,
    fn: () => Promise<T>
): Promise<T> {
    installLoggingContextConsoleBridge();

    const workflowRunId = safeRead(() => ctx.workflowRunId?.());
    const taskRunExternalId = safeRead(() => ctx.taskRunExternalId?.());
    const retryCount = safeRead(() => ctx.retryCount?.());
    const timer = defaultMetricsRegistry.startTimer('runtime.worker_task_ms', {
        operation,
    });
    defaultMetricsRegistry.increment('runtime.worker_task_total', {
        operation,
        status: 'started',
    });

    return withLoggingContext(
        {
            tenantId: input.tenantId,
            taskId: input.taskId,
            agentId: input.agentId,
            correlationId: workflowRunId,
            hatchetTaskRunExternalId: taskRunExternalId,
            hatchetOperation: operation,
            logSink: (entry) => forwardLogToHatchet(ctx, operation, entry),
        },
        async () => {
            await callHatchetLogger(ctx, 'info', `${operation} started`, {
                operation,
                tenantId: input.tenantId,
                taskId: input.taskId,
                agentId: input.agentId,
                workflowRunId,
                taskRunExternalId,
                retryCount,
            });
            try {
                const result = await fn();
                defaultMetricsRegistry.increment('runtime.worker_task_total', {
                    operation,
                    status: 'completed',
                });
                timer({ status: 'completed' });
                await callHatchetLogger(ctx, 'info', `${operation} completed`, {
                    operation,
                    tenantId: input.tenantId,
                    taskId: input.taskId,
                    agentId: input.agentId,
                    workflowRunId,
                    taskRunExternalId,
                    retryCount,
                });
                return result;
            } catch (error) {
                defaultMetricsRegistry.increment('runtime.worker_task_total', {
                    operation,
                    status: 'failed',
                    errorCode: error instanceof Error ? error.name : 'Error',
                });
                timer({ status: 'failed' });
                await callHatchetLogger(ctx, 'error', `${operation} failed: ${errorMessage(error)}`, {
                    operation,
                    tenantId: input.tenantId,
                    taskId: input.taskId,
                    agentId: input.agentId,
                    workflowRunId,
                    taskRunExternalId,
                    retryCount,
                    error: serializeError(error),
                });
                throw error;
            }
        }
    ) as Promise<T>;
}

async function forwardLogToHatchet(
    ctx: HatchetContextLike,
    operation: string,
    entry: LoggingSinkEntry
): Promise<void> {
    await callHatchetLogger(ctx, entry.level, truncateHatchetLog(entry.message), {
        ...entry.context,
        operation,
    });
}

async function callHatchetLogger(
    ctx: HatchetContextLike,
    level: LoggingSinkEntry['level'],
    message: string,
    extra?: Record<string, unknown>
): Promise<void> {
    const logger = ctx.logger;
    const method = logger?.[level] ?? logger?.info;
    if (!method) {
        return;
    }
    try {
        await method.call(logger, truncateHatchetLog(message), sanitizeMetadata(extra));
    } catch (error) {
        defaultMetricsRegistry.increment('observability.log_sink_failure_total', {
            level,
            operation: typeof extra?.operation === 'string' ? extra.operation : undefined,
            errorCode: error instanceof Error ? error.name : 'Error',
        });
    }
}

function truncateHatchetLog(message: string): string {
    if (message.length <= HATCHET_LOG_MESSAGE_LIMIT) {
        return message;
    }
    return `${message.slice(0, HATCHET_LOG_SAFE_LIMIT)}... [truncated ${message.length} chars]`;
}

function sanitizeMetadata(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    if (!value) {
        return undefined;
    }
    const sanitized = JSON.parse(JSON.stringify(value, (_key, nested) => {
        if (typeof nested === 'function') {
            return undefined;
        }
        if (nested instanceof Error) {
            return serializeError(nested);
        }
        return nested;
    })) as Record<string, unknown>;
    const budget = enforcePayloadBudget(sanitized, {
        code: 'LIMIT_DRIVER_METADATA_TOO_LARGE',
        limitBytes: readDriverMetadataMaxBytes(),
        summary: 'Hatchet log metadata exceeded the configured budget.',
    });
    if (!budget.ok) {
        defaultMetricsRegistry.increment('payload.budget_failure_total', {
            code: budget.code,
            surface: 'hatchet.log_metadata',
        });
    }
    return (budget.ok ? sanitized : compactPayload(budget.value)) as Record<string, unknown>;
}

function serializeError(error: unknown): Record<string, unknown> {
    if (error instanceof Error) {
        return {
            name: error.name,
            message: error.message,
            stack: error.stack,
        };
    }
    return { message: String(error) };
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function safeRead<T>(fn: () => T): T | undefined {
    try {
        return fn();
    } catch {
        return undefined;
    }
}
