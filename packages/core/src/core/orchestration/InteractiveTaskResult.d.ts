import type { InteractiveTaskResult } from '../../shared/types/A2ATypes.js';
import type { TaskStatus, Artifact } from '../../shared/types/index.js';
/**
 * Implementation for interactive task communication
 * This is a placeholder for future streaming/interactive features
 */
export declare class InteractiveTaskHandler implements InteractiveTaskResult {
    private taskId;
    private targetAgent;
    private statusCallbacks;
    private artifactCallbacks;
    private inputCallbacks;
    private completed;
    private result;
    constructor(taskId: string, targetAgent: string);
    onStatusUpdate(callback: (status: TaskStatus) => void): void;
    onArtifactUpdate(callback: (artifact: Artifact) => void): void;
    onInputRequired(callback: (prompt: string) => Promise<string>): void;
    sendInput(input: string): Promise<void>;
    cancel(reason?: string): Promise<void>;
    waitForCompletion(): Promise<unknown>;
    getStatus(): Promise<TaskStatus>;
    markCompleted(result: unknown): void;
}
