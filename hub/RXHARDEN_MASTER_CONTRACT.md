# RxHarden Master Contract - Casa Trejo Hub Chat Use Case Optimization

## 2a. Shared Interfaces & Types

### ChatMessage Interface
```typescript
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp?: string
}
```

### Chat API Request Payload
```typescript
interface ChatRequestPayload {
  messages: ChatMessage[]
  useCase?: 'deep_dive' | 'interview' | 'recall' | 'execute'
}
```

## 2b. Global State Shapes
- **Active Mobile Tab State:** `MobileTab = 'chat' | 'command' | 'execution' | 'google_chat'`
- **Chat State:** Array of `ChatMessage` objects stored in `messages` state in [page.tsx](file:///C:/Users/danie/Documents/antigravity/vibrant-chandrasekhar/hub/app/page.tsx).

## 2c. Database Schemas & API Payloads
### `/api/chat` POST Endpoint
- **Request Body:** `ChatRequestPayload` (JSON-encoded)
- **Response Format:** Server-Sent Events (SSE) stream (`text/event-stream`) returning SSE data blocks of shape `{ text: string }` or `{ error: string }`.

## 2d. Immutability Rule
> **MASTER CONTRACT IMMUTABILITY RULE:** No following task may deviate from this Master Contract without explicit reconciliation via the Cascade Diff Check (Step 3k). Any deviation without reconciliation is a CRITICAL VIOLATION requiring immediate halt.
