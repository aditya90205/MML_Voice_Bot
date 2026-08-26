# MML Voice Backend

Production-oriented Node.js backend for **in-app AI voice calls** (no Twilio/PSTN).

Flow:

```text
Admin/API  →  POST /api/v1/calls
                ↓
         Socket.IO: incoming_ai_call
                ↓
         React Native Accept
                ↓
   Mic PCM  →  Node  →  Sarvam STT → Chat → TTS  →  AI audio to app
```

## Features

- REST API to trigger an AI call to a connected app user
- Socket.IO presence (`userId` ↔ `socketId`)
- Incoming-call signaling (ring / accept / reject / miss / end)
- Real-time audio bridge over Socket.IO
- Sarvam pipeline: **STT (Saaras) → Chat → TTS (Bulbul)**
- API key auth, rate limiting, helmet, structured logging, graceful shutdown
- `.env` validation with Zod

## Requirements

- Node.js 20+
- Sarvam API key from [dashboard.sarvam.ai](https://dashboard.sarvam.ai)

## Setup

```bash
cp .env.example .env
# edit .env — set SARVAM_API_KEY and API_KEY

npm install
npm run dev
```

Server listens on `http://0.0.0.0:4000` by default.

## Environment

| Variable | Purpose |
|---|---|
| `API_KEY` | Protects trigger/admin REST routes (`x-api-key`) |
| `SARVAM_API_KEY` | Sarvam subscription key |
| `CORS_ORIGINS` | `*` for local RN, or comma-separated origins in prod |
| `CALL_RING_TIMEOUT_MS` | Missed-call timeout while ringing |
| `AI_GREETING_TEXT` | Spoken greeting after accept |
| `AI_SYSTEM_PROMPT` | Chat persona for the voice agent |

See `.env.example` for the full list.

## REST API

All `/api/v1/*` routes (except health) require:

```http
x-api-key: <API_KEY>
```

### Health

```http
GET /api/health
```

### List online users

```http
GET /api/v1/presence/online
```

### Trigger AI call

```http
POST /api/v1/calls
Content-Type: application/json
x-api-key: your-api-key

{
  "userId": "user_123",
  "language": "en-IN",
  "greetingText": "Hi! Thanks for picking up.",
  "systemPrompt": "You are a helpful order support agent. Keep answers short."
}
```

Response `201`:

```json
{
  "success": true,
  "data": {
    "callId": "call_...",
    "userId": "user_123",
    "status": "ringing",
    "language": "en-IN",
    "ringTimeoutMs": 45000
  }
}
```

If the user is offline → `409 USER_OFFLINE`.

### End call (admin)

```http
POST /api/v1/calls/:callId/end
```

### Get call

```http
GET /api/v1/calls/:callId
```

## Socket.IO contract (React Native)

Connect to the same host (HTTP upgrade):

```js
import { io } from 'socket.io-client';

const socket = io('http://YOUR_LAN_IP:4000', {
  transports: ['websocket'],
});

socket.emit('register', {
  userId: 'user_123',
  deviceId: 'android-device-1',
  displayName: 'Demo User',
});
```

### Events

| Direction | Event | Payload |
|---|---|---|
| C→S | `register` | `{ userId, deviceId?, displayName?, fcmToken? }` |
| S→C | `registered` | `{ userId, socketId, isOnline }` |
| S→C | `incoming_ai_call` | `{ callId, callerName, language, ringTimeoutMs }` |
| C→S | `call_accept` | `{ callId }` |
| C→S | `call_reject` | `{ callId }` |
| S→C | `call_started` | `{ callId, sampleRate, inputEncoding, outputEncoding }` |
| C→S | `audio_chunk` | `{ callId, audio: base64PCM, encoding?, sampleRate? }` |
| C→S | `audio_flush` | `{ callId }` |
| S→C | `ai_audio_chunk` | `{ callId, audio: base64, encoding, format }` |
| S→C | `transcript` | `{ callId, role, text, isFinal }` |
| S→C | `ai_speaking` | `{ callId, speaking }` |
| C→S | `call_end` | `{ callId }` |
| S→C | `call_ended` / `call_missed` / `call_rejected` | `{ callId, reason }` |

### Audio format (Phase 1)

- **Uplink (app → server):** base64 **PCM 16-bit LE mono @ 16 kHz** (`pcm_s16le`)
- **Downlink (server → app):** base64 **MP3** chunks (configurable via `SARVAM_TTS_CODEC`)

On `call_started`, start capturing mic frames (~20–40 ms), base64-encode, and emit `audio_chunk`.

Play `ai_audio_chunk` as they arrive (queue/concat).

## Quick curl test

1. Start backend + open RN app so it registers `user_123`.
2. Confirm online:

```bash
curl -s http://localhost:4000/api/v1/presence/online \
  -H "x-api-key: $API_KEY" | jq
```

3. Trigger call:

```bash
curl -s -X POST http://localhost:4000/api/v1/calls \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d '{"userId":"user_123"}' | jq
```

## Project layout

```text
src/
  index.js                 # HTTP + Socket.IO bootstrap
  app.js                   # Express app
  config/                  # env, logger, constants
  middleware/              # API key + errors
  routes/                  # REST
  sockets/                 # Socket.IO handlers
  services/
    presenceStore.js
    callStore.js
    callService.js
    sarvam/                # STT / Chat / TTS / pipeline
```

## Production notes

- Keep `SARVAM_API_KEY` only on the server (never in the APK).
- Replace in-memory presence/call stores with **Redis** when you run multiple Node instances.
- For background/killed Android apps, add **FCM** high-priority data messages (Phase 2) — Socket.IO alone only works while the app process can receive events.
- Put the API behind HTTPS (nginx / Caddy / cloud LB) and restrict `CORS_ORIGINS`.
- Rotate `API_KEY` and use a secrets manager in real deployments.

## Scripts

```bash
npm run dev    # watch mode
npm start      # production start
```
