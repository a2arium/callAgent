export type DeletionGateStatus = 'candidate' | 'approved' | 'deleted';

export type DeletionGateSurface = {
    id: string;
    description: string;
    files: string[];
    replacementPath: string;
    parityTest?: string;
    failureDrill?: string;
    rollbackFlag?: string;
    metricsCoverage?: string;
    retentionBehavior?: string;
    approver?: string;
    approvedAt?: string;
    status: DeletionGateStatus;
};

export const deletionGateSurfaces: DeletionGateSurface[] = [
    {
        id: 'outbox-poller',
        description: 'Legacy outbox poll loop for migrated event types.',
        files: ['packages/core/src/eventbus/outboxPublisher.ts', 'packages/core/src/orchestration/taskEngine.ts'],
        replacementPath: 'aplret.outbox.dispatch Hatchet task plus semantic run effects',
        status: 'candidate',
    },
    {
        id: 'legacy-resume-auto-schedule',
        description: 'In-process auto-resume handlers for input/tool/external events.',
        files: ['packages/core/src/orchestration/taskEngine.ts'],
        replacementPath: 'durable segment wake tasks and runtime timers',
        status: 'candidate',
    },
    {
        id: 'child-completion-cas-retry',
        description: 'Child completion in-flight/CAS retry coordination.',
        files: ['packages/core/src/orchestration/taskEngine.ts', 'packages/core/src/orchestration/A2AService.ts'],
        replacementPath: 'Hatchet child completion routing and semantic edge resolution',
        status: 'candidate',
    },
    {
        id: 'active-loop-injection',
        description: 'LoopRegistry active-loop injection for in-process wake routing.',
        files: ['packages/core/src/orchestration/LoopRegistry.ts', 'packages/core/src/orchestration/TaskExecutor.ts'],
        replacementPath: 'TurnRunnerSegmentExecutor and durable wake dispatch',
        status: 'candidate',
    },
];

export function validateDeletionGate(surface: DeletionGateSurface): string[] {
    if (surface.status !== 'approved' && surface.status !== 'deleted') return [];
    const missing: string[] = [];
    for (const key of ['parityTest', 'failureDrill', 'rollbackFlag', 'metricsCoverage', 'retentionBehavior', 'approver', 'approvedAt'] as const) {
        if (!surface[key]) missing.push(key);
    }
    return missing;
}

export function assertDeletionGateRegistryValid(surfaces: DeletionGateSurface[] = deletionGateSurfaces): void {
    const failures = surfaces
        .map((surface) => ({ surface, missing: validateDeletionGate(surface) }))
        .filter((item) => item.missing.length > 0);
    if (failures.length > 0) {
        const message = failures
            .map((item) => `${item.surface.id}: missing ${item.missing.join(', ')}`)
            .join('; ');
        throw new Error(`Deletion gate approval evidence is incomplete: ${message}`);
    }
}
