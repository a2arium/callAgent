import type { InteractiveTaskResult } from '../../shared/types/A2ATypes.js';
import type { TaskStatus, Artifact } from '../../shared/types/index.js';
import { logger } from '@callagent/utils';

const interactiveLogger = logger.createLogger({ prefix: 'InteractiveTask' });

/**
 * Implementation for interactive task communication
 * This is a placeholder for future streaming/interactive features
 */
export class InteractiveTaskHandler implements InteractiveTaskResult {
    private statusCallbacks: ((status: TaskStatus) => void)[] = [];
    private artifactCallbacks: ((artifact: Artifact) => void)[] = [];
    private inputCallbacks: ((prompt: string) => Promise<string>)[] = [];
    private completed = false;
    private result: unknown = null;

    constructor(
        private taskId: string,
        private targetAgent: string
    ) { }

    onStatusUpdate(callback: (status: TaskStatus) => void): void {
        this.statusCallbacks.push(callback);
        interactiveLogger.debug('Status callback registered', {
            taskId: this.taskId,
            callbackCount: this.statusCallbacks.length
        });
    }

    onArtifactUpdate(callback: (artifact: Artifact) => void): void {
        this.artifactCallbacks.push(callback);
        interactiveLogger.debug('Artifact callback registered', {
            taskId: this.taskId,
            callbackCount: this.artifactCallbacks.length
        });
    }

    onInputRequired(callback: (prompt: string) => Promise<string>): void {
        this.inputCallbacks.push(callback);
        interactiveLogger.debug('Input callback registered', {
            taskId: this.taskId,
            callbackCount: this.inputCallbacks.length
        });
    }

    async sendInput(input: string): Promise<void> {
        interactiveLogger.info('Input sent to task', {
            taskId: this.taskId,
            input: input.substring(0, 100)
        });
        // Future: implement actual input forwarding
    }

    async cancel(reason?: string): Promise<void> {
        interactiveLogger.info('Task cancellation requested', {
            taskId: this.taskId,
            reason
        });
        // Future: implement actual cancellation
    }

    async waitForCompletion(): Promise<unknown> {
        // For now, return immediately since we're doing synchronous execution
        if (this.completed) {
            return this.result;
        }

        // Future: implement actual waiting for async tasks
        interactiveLogger.debug('Waiting for task completion', { taskId: this.taskId });
        return this.result;
    }

    async getStatus(): Promise<TaskStatus> {
        // Future: return actual task status
        return {
            state: this.completed ? 'completed' : 'working',
            message: undefined,
            timestamp: new Date().toISOString()
        };
    }

    // Internal method to mark completion
    markCompleted(result: unknown): void {
        this.completed = true;
        this.result = result;
        interactiveLogger.debug('Task marked as completed', {
            taskId: this.taskId,
            hasResult: !!result
        });
    }
} 