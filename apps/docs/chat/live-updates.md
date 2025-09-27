# Live Updates (Realtime)

The chat bridge supports real-time status updates for loop-first agents with auto-resume capabilities.

## Delivery Options

- **SSE**: Stream events over EventSource (server-hosted SSE)
- **WebSockets via broker** (e.g., Ably): Publish ChatEvents to `channelKey = ${network}:${conversationId}` and subscribe from client

## Auto-Resume Status Events

The bridge publishes these status events when a RealtimePublisher is provided:

### Core Status Events
- `input_required`: Agent awaiting user input (with `token` in metadata)
- `working`: Agent processing or awaiting tool/child completion
- `completed`: Agent finished successfully
- `failed`: Agent encountered an error
- `cancelled`: Agent was cancelled

### Auto-Resume Events
- **Input provided → auto-resume**: `input_required` → (user input) → `working` → `completed`/`failed`
- **Tool completion → auto-resume**: `working` (awaiting tool) → (tool result) → `working` (processing) → `completed`/`failed`
- **Child completion → auto-resume**: `working` (awaiting child) → (child result) → `working` (processing) → `completed`/`failed`

## Event Payload Structure

```typescript
type ChatEvent = {
  type: 'status' | 'message' | 'error';
  conversationId: string;
  taskId: string;
  timestamp: string;
  data: {
    status?: 'input_required' | 'working' | 'completed' | 'failed' | 'cancelled';
    token?: string;           // For input_required events
    awaiting?: string;        // For working events: 'tool' | 'child'
    message?: ChatMessage;    // For message events
    error?: string;          // For error events
  };
};
```

## Client Implementation

```typescript
// SSE example
const eventSource = new EventSource(`/chat/${conversationId}/stream`);

eventSource.onmessage = (event) => {
  const chatEvent: ChatEvent = JSON.parse(event.data);
  
  switch (chatEvent.data.status) {
    case 'input_required':
      // Show input prompt, store token for response
      showInputPrompt(chatEvent.data.token);
      break;
      
    case 'working':
      // Show loading indicator
      if (chatEvent.data.awaiting) {
        showStatus(`Waiting for ${chatEvent.data.awaiting}...`);
      } else {
        showStatus('Processing...');
      }
      break;
      
    case 'completed':
      hideStatus();
      break;
      
    case 'failed':
      showError(chatEvent.data.error || 'Task failed');
      break;
  }
};

// Provide input (triggers auto-resume)
async function provideInput(token: string, value: string) {
  await fetch(`/tasks/${taskId}/input`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, input: value })
  });
  // Auto-resume will trigger new status events
}
```
