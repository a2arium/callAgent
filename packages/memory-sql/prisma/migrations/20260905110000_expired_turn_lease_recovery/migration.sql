-- Bounded keyset discovery for durable task-turn claims whose canonical lease
-- has expired. ISO timestamps are emitted by CallAgent with toISOString(), so
-- their text ordering is chronological and remains indexable.
CREATE INDEX "wm_sessions_expired_turn_claim_idx"
    ON "wm_sessions" (
        (snapshot #>> '{meta,turnCoordinator,active,expiresAt}'),
        "tenant_id",
        "session_id"
    )
    WHERE snapshot #> '{meta,turnCoordinator,active}' IS NOT NULL
      AND snapshot #> '{meta,turnCoordinator,dispatchIntent}' IS NULL;
