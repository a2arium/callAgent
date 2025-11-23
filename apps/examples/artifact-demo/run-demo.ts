import { TaskEngine, PluginManager } from '@a2arium/callagent-core';
import { WorkingMemorySessionStore } from '@a2arium/callagent-memory-sql';
import { PrismaClient } from '@prisma/client';
import { logger } from '@a2arium/callagent-utils';
import artifactDemo from './agent.js';

async function run() {
    const prisma = new PrismaClient();
    const sessionStore = new WorkingMemorySessionStore(prisma);
    const engine = new TaskEngine({ sessionStore });

    const registerAgent =
        (PluginManager as any).registerAgent?.bind(PluginManager) ??
        (PluginManager as any).register?.bind(PluginManager);
    if (registerAgent) {
        registerAgent(artifactDemo);
    }

    const tenantId = 'default';
    const taskId = `artifact-demo-${Date.now()}`;

    logger.info('▶️ Starting Parent Task (Turn 1)', { taskId });
    const task = { id: taskId, input: { sizeKB: 256 } };

    const result1 = await engine.startTask({
        task,
        agentId: 'artifact-demo',
        tenantId,
        isStreaming: false
    });

    let inputToken =
        (result1 as any)?.status?.metadata?.token ??
        (result1 as any)?.status?.metadata?.awaitExtra?.token;

    const session1 = await sessionStore.getSessionSnapshot(tenantId, taskId);
    const snapshot = session1?.snapshot as Record<string, unknown> | undefined;
    if (!inputToken) {
        inputToken = (snapshot as any)?.outcome?.token;
    }

    const pendingArtifact = (snapshot as any)?.M?.memory?.vars?.pendingArtifact;

    console.log('[Framework] 🔍 Inspecting Snapshot in DB (Turn 1 End)');
    console.dir(pendingArtifact, { depth: 4 });

    if (pendingArtifact?.kind === 'artifact') {
        console.log('[Framework] ✅ SUCCESS: Artifact is offloaded (Handle found)');
    } else if (pendingArtifact?.kind === 'artifact_local') {
        console.log('[Framework] ❌ FAILURE: Artifact is LOCAL (Offloading failed)');
    } else {
        console.log('[Framework] ❌ FAILURE: Artifact not found in snapshot');
    }

    if (!inputToken) {
        throw new Error('No input token found after first turn');
    }

    logger.info('▶️ Resuming Parent Task (Turn 2) with User Input', { token: inputToken });
    try {
        await engine.resumeInput({
            tenantId,
            taskId,
            token: inputToken,
            input: {
                kind: 'input',
                token: inputToken,
                value: 'continue'
            } as any
        });

        const session2 = await sessionStore.getSessionSnapshot(tenantId, taskId);
        logger.info('🏁 Parent Finished', {
            hasStats: Boolean((session2?.snapshot as any)?.M?.memory?.sensory?.stats)
        });
    } catch (error) {
        logger.warn('Failed to resume task after verification (expected for demo)', {
            error: error instanceof Error ? error.message : String(error)
        });
    }

    await prisma.$disconnect();
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});

