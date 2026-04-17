import type { TaskContext } from '../shared/types/index.js';
import type { InternalTaskContext } from '../loop/internalContext.js';
import type { EnvironmentState } from '../loop/types.js';

/**
 * Framework default: when {@link import('@a2arium/callagent-types').AgentRuntimeManifest} sets
 * `communication.autoJoinInvitedTopics`, attempt `ctx.conversation.join` for each
 * `topic.invite.received` in the staged inbox before policy runs.
 * Never bypasses join validation; failures are recorded on the internal turn map for trace stamping.
 */
export async function runDefaultAutoJoinInvitedTopics(params: {
    ctx: TaskContext;
    env: EnvironmentState;
    iCtx: InternalTaskContext;
}): Promise<void> {
    const { ctx, env, iCtx } = params;
    if (!ctx.conversation) {
        return;
    }
    const turnMap = iCtx.__turnInviteAutoJoin ?? {};
    iCtx.__turnInviteAutoJoin = turnMap;
    for (const obs of env.inbox.current) {
        if (obs.source !== 'conversation' || obs.payload.kind !== 'topic.invite.received') {
            continue;
        }
        const token = String(obs.payload.token);
        try {
            const receipt = await ctx.conversation.join(obs.payload.topic, {
                inviteToken: obs.payload.token,
            });
            if (receipt.status === 'rejected') {
                const errType = receipt.error.type;
                if (
                    errType === 'InviteNotFound' ||
                    errType === 'InviteExpired' ||
                    errType === 'InviteAlreadyConsumed' ||
                    errType === 'InviteTargetMismatch'
                ) {
                    turnMap[token] = {
                        attempted: true,
                        error: { type: errType, message: receipt.error.message },
                    };
                    continue;
                }
            }
            turnMap[token] = { attempted: true };
        } catch (error) {
            turnMap[token] = {
                attempted: true,
                error: {
                    type: 'InviteNotFound',
                    message: error instanceof Error ? error.message : String(error),
                },
            };
        }
    }
}
