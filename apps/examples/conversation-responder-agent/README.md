# conversation-responder-agent

Companion agent for the Phase 5.1 conversation example.

Use it with `apps/examples/conversation-reference-agent/` to model two-agent thread communication explicitly.

Behavior: on `message.received`, it **sends one `inform` reply** back to `conversation-reference-agent` on the same thread (`content: { step: 'responder_ack' }`), then completes. Run it on the routed session id `thread-conv-ref-1:child-ref` (or your `threadId:recipientAgentId`) so deliveries land in its inbox; the initiator must have opened the thread first so the thread row exists in storage.
