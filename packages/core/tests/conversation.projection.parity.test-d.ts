import type { z } from 'zod';
import type { ThreadProjectionEntrySchema, TopicProjectionEntrySchema } from '../src/public-types/conversation/projection.js';

type Th = z.infer<typeof ThreadProjectionEntrySchema>;
type To = z.infer<typeof TopicProjectionEntrySchema>;

/** Lifecycle / archive metadata shared between thread and topic projections (5.4a parity). */
type ThreadParity = Pick<
    Th,
    | 'closedAt'
    | 'closedReason'
    | 'closedReasonText'
    | 'closedByAgentId'
    | 'closedByMemberId'
    | 'archivedAt'
    | 'archivedByAgentId'
    | 'archivedByMemberId'
    | 'archivedReasonText'
>;
type TopicParity = Pick<
    To,
    | 'closedAt'
    | 'closedReason'
    | 'closedReasonText'
    | 'closedByAgentId'
    | 'closedByMemberId'
    | 'archivedAt'
    | 'archivedByAgentId'
    | 'archivedByMemberId'
    | 'archivedReasonText'
>;

const _threadToTopic: TopicParity = {} as ThreadParity;
const _topicToThread: ThreadParity = {} as TopicParity;
void _threadToTopic;
void _topicToThread;
