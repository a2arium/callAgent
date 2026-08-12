import { PluginManager } from '@a2arium/callagent-core';
import type { RuntimeWorkspaceDescriptor } from '@a2arium/callagent-core';

export type RegisteredWorkspaceAgents = {
    fingerprint: string;
    agentIds: string[];
};

/**
 * Imports exactly the agents recorded in a descriptor. Environment and workspace files are
 * deliberately not consulted here: the parent process has already resolved them once.
 */
export async function registerWorkspaceAgents(
    descriptor: RuntimeWorkspaceDescriptor
): Promise<RegisteredWorkspaceAgents> {
    const agentIds: string[] = [];
    for (const workspace of descriptor.workspaces) {
        for (const agent of workspace.agents) {
            const loaded = await PluginManager.loadAgent(agent.modulePath);
            if (!loaded) throw new Error(`Descriptor agent could not be loaded: ${agent.id}`);
            const actualId = loaded.resolved.agentCard.name;
            if (actualId !== agent.id) {
                throw new Error(`Descriptor agent identity mismatch: expected ${agent.id}, loaded ${actualId}`);
            }
            agentIds.push(actualId);
        }
    }
    return { fingerprint: descriptor.fingerprint, agentIds: agentIds.sort() };
}
