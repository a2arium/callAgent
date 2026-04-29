import { logger } from '@a2arium/callagent-utils';
import { normalizeObservationInbox, type ObservationInbox } from '../loop/types.js';
import type { Observation } from '../loop/oneTurn.js';
import { conversationInboxDeliveryKey } from '../loop/conversationInboxIdentity.js';
import type { Observation as ConversationObservation } from '../types/observation.js';

const log = logger.createLogger({ prefix: 'InboxManager' });

export type EngineObservation = Observation;
export type EngineObservationInbox = ObservationInbox;

export class InboxManager {
    static normalizeInbox(value: unknown): ObservationInbox {
        return normalizeObservationInbox(value);
    }

    static addObservationToInbox(inboxValue: unknown, observation: EngineObservation): EngineObservationInbox {
        const inbox = this.normalizeInbox(inboxValue);
        inbox.current.push(observation);
        inbox.all.push(observation);
        return inbox;
    }

    static addObservationToInboxIfMissing(
        inboxValue: unknown,
        observation: EngineObservation,
        predicate: (obs: EngineObservation) => boolean
    ): EngineObservationInbox {
        const inbox = this.normalizeInbox(inboxValue);
        const hasInAll = inbox.all.some(predicate);
        const hasInCurrent = inbox.current.some(predicate);

        if (!hasInAll) {
            inbox.all.push(observation);
        }
        if (!hasInCurrent) {
            inbox.current.push(observation);
        }

        return inbox;
    }

    /**
     * Merge remote inbox items into local inbox to preserve concurrent runtime deliveries.
     * This prevents lost updates where an active turn overwrites observations routed into
     * the same session while the turn was running.
     * 
     * @param localInbox - The local inbox from env (what the parent saw during execution)
     * @param remoteInbox - The remote inbox from DB (may contain concurrent updates)
     * @param pendingChildren - Map of pending child tokens (only merge observations for these)
     * @returns Merged inbox with all child completion observations preserved
     */
    static mergeInboxes(
        localInbox: EngineObservationInbox,
        remoteInbox: EngineObservationInbox,
        pendingChildren: Record<string, unknown>
    ): EngineObservationInbox {
        const merged = this.normalizeInbox(localInbox);
        const remoteAll = remoteInbox?.all ?? [];

        log.debug('mergeInboxes: Starting merge', {
            localAllCount: merged.all.length,
            remoteAllCount: remoteAll.length,
            remoteKinds: remoteAll.map(o => o.kind),
            pendingChildrenKeys: Object.keys(pendingChildren)
        });

        const appendIfMissing = (obs: EngineObservation, includeCurrent: boolean): boolean => {
            const key = observationMergeKey(obs);
            const hasInAll = merged.all.some((existing) => observationMergeKey(existing) === key);
            if (!hasInAll) {
                merged.all.push(obs);
            }
            if (includeCurrent) {
                const hasInCurrent = merged.current.some((existing) => observationMergeKey(existing) === key);
                if (!hasInCurrent) {
                    merged.current.push(obs);
                }
            }
            return !hasInAll;
        };

        // Add child completion observations from remote that we don't have locally.
        for (const obs of remoteAll) {
            if (obs.kind === 'child.completed') {
                const token = (obs.payload as any)?.token;
                log.debug('mergeInboxes: Found child.completed in remote', { token, hasToken: !!token });
                // Only merge if this is a pending child AND not already in local
                if (token && pendingChildren[token]) {
                    if (appendIfMissing(obs, true)) {
                        log.info('mergeInboxes: ✅ Preserved concurrent child completion', { token });
                    } else {
                        log.debug('mergeInboxes: Already has observation in local', { token });
                    }
                }
            }
        }

        // Add conversation observations routed while this turn was active. These are
        // already filtered by consumed delivery keys by the caller, so current entries
        // here are unconsumed and must remain visible on the next turn.
        const remoteCurrent = remoteInbox?.current ?? [];
        for (const obs of remoteAll) {
            if (obs.source === 'conversation') {
                appendIfMissing(obs, remoteCurrent.some((current) => observationMergeKey(current) === observationMergeKey(obs)));
            }
        }

        log.debug('mergeInboxes: Merge complete', {
            finalAllCount: merged.all.length,
            finalCurrentCount: merged.current.length,
            finalKinds: merged.all.map(o => o.kind)
        });

        return merged;
    }
}

function observationMergeKey(obs: EngineObservation): string {
    const conversationKey = conversationInboxDeliveryKey(obs as unknown as ConversationObservation);
    if (conversationKey !== undefined) {
        return `conversation-delivery:${conversationKey}`;
    }
    if (obs.kind === 'child.completed') {
        const token = (obs.payload as { token?: unknown } | undefined)?.token;
        if (typeof token === 'string' && token.length > 0) {
            return `child.completed:${token}`;
        }
    }
    return `observation:${JSON.stringify(obs)}`;
}
