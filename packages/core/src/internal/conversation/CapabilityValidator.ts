import type { z } from 'zod';
import { SpeechActSchema } from '../../public-types/conversation/schemas.js';
import type { ConversationError } from '../../public-types/conversation/types.js';

type SpeechAct = z.infer<typeof SpeechActSchema>;

export type ResolvedAgentCommunication = {
    threadable?: boolean;
    wakeOnTopicMessage?: boolean;
    acceptedSpeechActs?: readonly string[];
    acceptedContentTypes?: readonly string[];
    jsonSchemas?: unknown;
    topicPoliciesSupported?: readonly string[];
};

function normalizeMimeList(list: readonly string[] | undefined): string[] | undefined {
    if (!list || list.length === 0) {
        return undefined;
    }
    return [...list];
}

export function validateThreadable(
    comm: ResolvedAgentCommunication | undefined,
    agentId: string
): ConversationError | null {
    if (comm?.threadable === false) {
        return {
            type: 'RecipientNotThreadable',
            message: 'Target agent manifest sets communication.threadable to false.',
            agentId,
        };
    }
    return null;
}

export function validateSpeechActAccepted(
    comm: ResolvedAgentCommunication | undefined,
    speechAct: SpeechAct
): ConversationError | null {
    const allowed = normalizeMimeList(comm?.acceptedSpeechActs as string[] | undefined);
    if (!allowed) {
        return null;
    }
    if (!allowed.includes(speechAct)) {
        return {
            type: 'SpeechActNotAccepted',
            message: `Speech act "${speechAct}" is not listed in the recipient manifest acceptedSpeechActs.`,
            speechAct,
        };
    }
    return null;
}

export function extractContentMime(content: unknown): string | undefined {
    if (content && typeof content === 'object' && content !== null && 'mimeType' in content) {
        const m = (content as { mimeType?: unknown }).mimeType;
        return typeof m === 'string' ? m : undefined;
    }
    return undefined;
}

export function validateContentTypeAccepted(
    comm: ResolvedAgentCommunication | undefined,
    content: unknown
): ConversationError | null {
    const allowed = normalizeMimeList(comm?.acceptedContentTypes as string[] | undefined);
    if (!allowed) {
        return null;
    }
    const mime = extractContentMime(content);
    if (mime === undefined) {
        return {
            type: 'ContentTypeNotAccepted',
            message: 'Message content has no mimeType; recipient requires acceptedContentTypes.',
        };
    }
    if (!allowed.includes(mime)) {
        return {
            type: 'ContentTypeNotAccepted',
            message: `Content type "${mime}" is not accepted by the recipient manifest.`,
            contentType: mime,
        };
    }
    return null;
}
