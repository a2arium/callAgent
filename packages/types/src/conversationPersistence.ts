/** Thread row shape shared by SessionStore and SQL-backed implementations. */

export type ConversationThreadCloseReason = 'explicit' | 'ttl';

export type ConversationThreadRecord = {
    tenantId: string;
    conversationId: string;
    ownerAgentId: string;
    participantAgentId: string;
    status: 'open' | 'closed' | 'archived';
    createdAt: string;
    updatedAt: string;
    closedAt?: string | null;
    closeReason?: ConversationThreadCloseReason | null;
    closeReasonText?: string | null;
    closedByAgentId?: string | null;
    archivedAt?: string | null;
    archivedByAgentId?: string | null;
    archivedReasonText?: string | null;
    expiresAt?: string | null;
};

/** Discriminated update: close (to `closed`) or archive (`closed` → `archived`). */
export type UpdateConversationThreadStatusInput =
    | {
          kind: 'close';
          tenantId: string;
          conversationId: string;
          closedAt: string;
          closeReason: ConversationThreadCloseReason;
          closeReasonText?: string | null;
          closedByAgentId?: string | null;
      }
    | {
          kind: 'archive';
          tenantId: string;
          conversationId: string;
          archivedAt: string;
          archivedByAgentId?: string | null;
          archivedReasonText?: string | null;
      };

export type ConversationThreadSweepRow = {
    tenantId: string;
    conversationId: string;
    ownerAgentId: string;
    participantAgentId: string;
};
