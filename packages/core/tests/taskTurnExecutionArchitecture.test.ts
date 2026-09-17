import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function source(path: string): string {
    return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('loop task execution architecture', () => {
    it('keeps TaskExecutor behind TurnRunner and TurnRunner behind the segment executor', () => {
        const taskExecutorCallers = [
            'packages/core/src/orchestration/TurnRunner.ts',
            'packages/core/src/orchestration/taskEngine.ts',
            'packages/core/src/runtime/turnRunnerSegmentExecutor.ts',
        ].filter((path) => source(path).includes('TaskExecutor.executeTurn('));
        expect(taskExecutorCallers).toEqual(['packages/core/src/orchestration/TurnRunner.ts']);

        const turnRunnerCallers = [
            'packages/core/src/orchestration/taskEngine.ts',
            'packages/core/src/runtime/turnRunnerSegmentExecutor.ts',
            'packages/core/src/runtime/inProcessRuntimeDriver.ts',
        ].filter((path) => source(path).includes('.turnRunner.runTurn('));
        expect(turnRunnerCallers).toEqual(['packages/core/src/runtime/turnRunnerSegmentExecutor.ts']);

        const taskEngine = source('packages/core/src/orchestration/taskEngine.ts');
        expect(taskEngine).not.toContain('TaskExecutor.executeTurn(');
        expect(taskEngine).not.toContain('.turnRunner.runTurn(');
    });
});
