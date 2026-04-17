-- Phase 3: enforce thread row literals (online-safe; validates existing rows).

ALTER TABLE "conversation_threads" DROP CONSTRAINT IF EXISTS "conversation_threads_status_chk";
ALTER TABLE "conversation_threads" ADD CONSTRAINT "conversation_threads_status_chk"
    CHECK ("status" IN ('open', 'closed', 'archived'));

ALTER TABLE "conversation_threads" DROP CONSTRAINT IF EXISTS "conversation_threads_close_reason_chk";
ALTER TABLE "conversation_threads" ADD CONSTRAINT "conversation_threads_close_reason_chk"
    CHECK ("close_reason" IS NULL OR "close_reason" IN ('explicit', 'ttl', 'archived'));
