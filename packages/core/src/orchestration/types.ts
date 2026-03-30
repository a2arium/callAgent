
import type { TaskContext } from '../shared/types/index.js';
import type { TaskStatus } from '../shared/types/StreamingEvents.js';
import { Artifact } from '../shared/types/index.js';

export { HYDRATED_ARTIFACT_HANDLE_SYMBOL } from './ArtifactHydrationService.js';

/**
 * Task entity with the necessary properties for the task engine
 */
export type TaskEntity = {
    id: string;
    input: unknown;
    status?: TaskStatus;
    artifacts?: Artifact[];
};

/**
 * Clean child task result extracted from TaskEntity wrapper
 */
export interface CleanChildResult {
    result: unknown;
    childTaskId?: string;
    executionMetadata?: {
        timings?: unknown;
        rewards?: unknown;
        state?: string;
        timestamp?: string;
    };
}

/**
 * Parameters for starting a task
 */
export type StartTaskParams = {
    task: TaskEntity;
    isStreaming: boolean;
    agentId?: string;
    tenantId?: string;
    initialContext?: TaskContext; // use prebuilt context when provided
    parentTelemetryNodeId?: string; // Telemetry ID for sub-agent linking
    skipTelemetryNodeCreation?: boolean; // Prevents taskEngine from wrapping execution in another AgentNode
    options?: {
        maxTurns?: number;
    };
};
