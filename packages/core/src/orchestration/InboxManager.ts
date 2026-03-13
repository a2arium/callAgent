import { logger } from '@a2arium/callagent-utils';
import { normalizeObservationInbox, type ObservationInbox } from '../loop/types.js';
import type { Observation } from '../loop/oneTurn.js';

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
     * Merge remote inbox items into local inbox to preserve concurrent child completions.
     * This prevents the "Lost Update" bug where parent overwrites child completion observations.
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

        // Add child completion observations from remote that we don't have locally
        for (const obs of remoteAll) {
            if (obs.kind === 'child.completed') {
                const token = (obs.payload as any)?.token;
                log.debug('mergeInboxes: Found child.completed in remote', { token, hasToken: !!token });
                // Only merge if this is a pending child AND not already in local
                if (token && pendingChildren[token]) {
                    const alreadyHasInAll = merged.all.some(
                        o => o.kind === 'child.completed' && (o.payload as any)?.token === token
                    );
                    if (!alreadyHasInAll) {
                        merged.all.push(obs);
                        // Also add to current so it gets processed on next turn
                        const alreadyHasInCurrent = merged.current.some(
                            o => o.kind === 'child.completed' && (o.payload as any)?.token === token
                        );
                        if (!alreadyHasInCurrent) {
                            merged.current.push(obs);
                        }
                        log.info('mergeInboxes: ✅ Preserved concurrent child completion', { token });
                    } else {
                        log.debug('mergeInboxes: Already has observation in local', { token });
                    }
                }
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
