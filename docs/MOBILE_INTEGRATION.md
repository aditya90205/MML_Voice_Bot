# Mobile Developer Integration Guide (React Native)

Hand this file to the **app developer**. They only work on the React Native side.

When backend runs:

```bash
POST /api/v1/calls
{ "userId": "user_123" }
```

…the app that registered as `user_123` must show an **incoming AI call** (Accept / Reject).

---

## What you need from backend team

| Item | Example |
|------|---------|
| Socket / API base URL | `http://192.168.1.20:4000` (LAN IP while testing APK) |
| Test `userId` | `user_123` (must match API body) |
| Audio uplink | PCM 16-bit LE, mono, **16000 Hz**, base64 |
| Audio downlink | MP3 chunks, base64 |

**Do not** put Sarvam API key or admin `x-api-key` inside the app.

On a real phone, **never use `localhost`**. Use the PC’s Wi‑Fi IP. Phone and PC must be on the same network.

---

## Steps (mobile side only)

1. Install Socket.IO client (+ audio libs when you implement talk).
2. On app open / after login → connect socket → `emit('register', { userId, deviceId })`.
3. Listen for `incoming_ai_call` → show Accept / Reject UI.
4. On Accept → `emit('call_accept')` → start mic → send `audio_chunk` → play `ai_audio_chunk`.
5. On Reject / Hang up → `emit('call_reject')` or `emit('call_end')`.

Until step 2 works, triggering the API returns **USER_OFFLINE**.

### Critical: play AI audio or you will hear silence

After Accept, backend sends:

1. `call_started`
2. then `ai_speaking: true`
3. then one or more `ai_audio_chunk` events (base64 **MP3**)
4. then `ai_speaking: false`

If the app does **not** decode/play `ai_audio_chunk`, the call looks connected but there is **no voice**.

Minimal player handler (example):

```javascript
import { Platform } from 'react-native';
import Sound from 'react-native-sound'; // or react-native-track-player / expo-av
import RNFS from 'react-native-fs';

socket.on('ai_audio_chunk', async ({ callId, audio, encoding }) => {
  // audio = base64 MP3 string
  const path = `${RNFS.CachesDirectoryPath}/ai_${Date.now()}.mp3`;
  await RNFS.writeFile(path, audio, 'base64');

  Sound.setCategory('Playback');
  const track = new Sound(path, '', (err) => {
    if (err) {
      console.log('play error', err);
      return;
    }
    track.play(() => track.release());
  });
});
```

Also log this on device when testing:

```javascript
socket.on('ai_audio_chunk', (p) => {
  console.log('AI AUDIO received', p.encoding, p.audio?.length);
});
socket.on('ai_speaking', (p) => console.log('AI speaking', p.speaking));
socket.on('transcript', (p) => console.log('transcript', p));
```

If backend logs `Sending ai_audio_chunk to mobile` but phone log never shows `AI AUDIO received`, the app socket listener is missing.  
If phone receives it but no sound, the **player** is missing/wrong (not backend).

---

## 1) Install

```bash
npm install socket.io-client @react-native-async-storage/async-storage
# later for real voice:
# npm install react-native-live-audio-stream  (or your preferred PCM mic lib)
# + an MP3 player for AI audio chunks
```

---

## 2) Full script to paste (Socket + incoming call)

Create a file in the RN project, e.g. `src/services/aiCallSocket.js`:

```javascript
/**
 * MML AI Voice Call — React Native Socket client
 * Backend: MML_Voice_Backend (Socket.IO)
 *
 * REPLACE SOCKET_URL with backend LAN/public URL.
 * REPLACE getCurrentUserId() with your real logged-in user id.
 */
import { io } from 'socket.io-client';
import AsyncStorage from '@react-native-async-storage/async-storage';

// ========== CONFIG (ask backend team) ==========
const SOCKET_URL = 'http://192.168.1.20:4000'; // <-- CHANGE THIS
// ===============================================

let socket = null;
let listenersBound = false;

/** Stable device id for this app install */
export async function getDeviceId() {
  const KEY = 'mml_device_id';
  let id = await AsyncStorage.getItem(KEY);
  if (!id) {
    id = `rn-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    await AsyncStorage.setItem(KEY, id);
  }
  return id;
}

/**
 * Call this AFTER login, when you know userId.
 * Example: connectAiCallSocket('user_123')
 */
export async function connectAiCallSocket(userId, handlers = {}) {
  if (!userId) {
    throw new Error('userId is required to register for AI calls');
  }

  if (socket?.connected) {
    socket.emit('register', {
      userId,
      deviceId: await getDeviceId(),
      displayName: handlers.displayName || userId,
    });
    return socket;
  }

  socket = io(SOCKET_URL, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: true,
    reconnectionAttempts: 20,
    reconnectionDelay: 1000,
  });

  socket.on('connect', async () => {
    console.log('[AICall] connected', socket.id);

    const deviceId = await getDeviceId();

    // ★ THIS is the line that makes the user "online" for backend
    socket.emit('register', {
      userId,
      deviceId,
      displayName: handlers.displayName || userId,
      // fcmToken: await getFcmToken(), // add later for background calls
    });
  });

  socket.on('registered', (data) => {
    console.log('[AICall] registered', data);
    handlers.onRegistered?.(data);
  });

  // ★ Incoming call from backend after POST /api/v1/calls
  socket.on('incoming_ai_call', (payload) => {
    console.log('[AICall] incoming', payload);
    // payload: { callId, userId, callerName, language, ringTimeoutMs, createdAt }
    handlers.onIncomingCall?.(payload);
  });

  socket.on('call_started', (payload) => {
    console.log('[AICall] started', payload);
    // payload includes sampleRate, inputEncoding, outputEncoding
    handlers.onCallStarted?.(payload);
  });

  socket.on('ai_audio_chunk', (payload) => {
    // { callId, audio: base64Mp3, encoding, format }
    handlers.onAiAudio?.(payload);
  });

  socket.on('transcript', (payload) => {
    // { callId, role: 'user'|'assistant', text, isFinal }
    handlers.onTranscript?.(payload);
  });

  socket.on('ai_speaking', (payload) => {
    // { callId, speaking: boolean }
    handlers.onAiSpeaking?.(payload);
  });

  socket.on('call_ended', (payload) => handlers.onCallEnded?.(payload));
  socket.on('call_missed', (payload) => handlers.onCallMissed?.(payload));
  socket.on('call_rejected', (payload) => handlers.onCallRejected?.(payload));
  socket.on('call_error', (payload) => handlers.onCallError?.(payload));

  socket.on('disconnect', (reason) => {
    console.log('[AICall] disconnected', reason);
    handlers.onDisconnect?.(reason);
  });

  socket.on('connect_error', (err) => {
    console.log('[AICall] connect_error', err.message);
    handlers.onConnectError?.(err);
  });

  listenersBound = true;
  return socket;
}

export function acceptCall(callId) {
  if (!socket) return;
  socket.emit('call_accept', { callId }, (ack) => {
    console.log('[AICall] accept ack', ack);
  });
}

export function rejectCall(callId) {
  if (!socket) return;
  socket.emit('call_reject', { callId });
}

export function endCall(callId) {
  if (!socket) return;
  socket.emit('call_end', { callId });
}

/**
 * Send mic PCM frame while call is active.
 * audioBase64 = base64 of raw PCM s16le mono @ 16kHz
 */
export function sendAudioChunk(callId, audioBase64, sampleRate = 16000) {
  if (!socket?.connected) return;
  socket.emit('audio_chunk', {
    callId,
    audio: audioBase64,
    encoding: 'pcm_s16le',
    sampleRate,
  });
}

export function flushAudio(callId) {
  if (!socket?.connected) return;
  socket.emit('audio_flush', { callId });
}

export function getSocket() {
  return socket;
}

export function disconnectAiCallSocket() {
  if (socket) {
    socket.emit('unregister');
    socket.disconnect();
    socket = null;
    listenersBound = false;
  }
}
```

---

## 3) Wire it in your App (after login)

Example in your home / root screen:

```javascript
import React, { useEffect, useState } from 'react';
import { View, Text, Button, Modal, Alert } from 'react-native';
import {
  connectAiCallSocket,
  acceptCall,
  rejectCall,
  endCall,
} from './src/services/aiCallSocket';

export default function App() {
  // MUST be the same userId backend will call
  const userId = 'user_123';

  const [incoming, setIncoming] = useState(null); // { callId, callerName, ... }
  const [activeCallId, setActiveCallId] = useState(null);

  useEffect(() => {
    let mounted = true;

    connectAiCallSocket(userId, {
      displayName: 'Demo User',

      onIncomingCall: (payload) => {
        if (!mounted) return;
        setIncoming(payload); // show Accept / Reject modal
      },

      onCallStarted: (payload) => {
        setIncoming(null);
        setActiveCallId(payload.callId);
        // TODO: start microphone streaming → sendAudioChunk(payload.callId, base64Pcm)
        // TODO: play ai_audio_chunk MP3 when onAiAudio fires
      },

      onCallEnded: () => {
        setActiveCallId(null);
        setIncoming(null);
        Alert.alert('Call ended');
      },

      onCallMissed: () => {
        setIncoming(null);
        Alert.alert('Missed AI call');
      },

      onCallError: (e) => {
        Alert.alert('Call error', e?.message || 'Unknown error');
      },
    });

    return () => {
      mounted = false;
      // optional: disconnectAiCallSocket();
    };
  }, [userId]);

  return (
    <View style={{ flex: 1, justifyContent: 'center', padding: 24 }}>
      <Text>AI Call demo — userId: {userId}</Text>
      <Text>{activeCallId ? `In call: ${activeCallId}` : 'Waiting for call...'}</Text>

      {!!activeCallId && (
        <Button title="End call" onPress={() => endCall(activeCallId)} />
      )}

      <Modal visible={!!incoming} transparent animationType="slide">
        <View
          style={{
            flex: 1,
            backgroundColor: 'rgba(0,0,0,0.6)',
            justifyContent: 'center',
            padding: 24,
          }}
        >
          <View style={{ backgroundColor: '#fff', padding: 20, borderRadius: 12 }}>
            <Text style={{ fontSize: 20, fontWeight: '700' }}>
              Incoming AI Call
            </Text>
            <Text style={{ marginVertical: 8 }}>
              {incoming?.callerName || 'AI Assistant'} is calling…
            </Text>

            <Button
              title="Accept"
              onPress={() => {
                acceptCall(incoming.callId);
                // keep modal until call_started if you want
              }}
            />
            <View style={{ height: 12 }} />
            <Button
              title="Reject"
              color="#c62828"
              onPress={() => {
                rejectCall(incoming.callId);
                setIncoming(null);
              }}
            />
          </View>
        </View>
      </Modal>
    </View>
  );
}
```

---

## 4) How backend team will test (you don’t need this code)

1. App open → registered as `user_123`
2. Backend:

```bash
curl -X POST http://192.168.1.20:4000/api/v1/calls \
  -H "Content-Type: application/json" \
  -H "x-api-key: <API_KEY_FROM_BACKEND_ENV>" \
  -d '{"userId":"user_123"}'
```

3. App should show **Incoming AI Call** modal.

If nothing happens:
- App not connected / not registered
- Wrong `userId`
- Phone using `localhost` instead of PC LAN IP
- Firewall blocking port 4000

Check online users (backend):

```bash
curl http://192.168.1.20:4000/api/v1/presence/online \
  -H "x-api-key: <API_KEY>"
```

Your `user_123` must appear there before trigger works.

---

## 5) Socket events cheat sheet

| Direction | Event | When |
|-----------|--------|------|
| App → Server | `register` | App open / login |
| Server → App | `registered` | Register OK |
| Server → App | `incoming_ai_call` | API triggered call |
| App → Server | `call_accept` | User taps Accept |
| App → Server | `call_reject` | User taps Reject |
| Server → App | `call_started` | Media session ready |
| App → Server | `audio_chunk` | Mic PCM while talking |
| Server → App | `ai_audio_chunk` | AI voice to play |
| Server → App | `transcript` | Text of what was said |
| App → Server | `call_end` | Hang up |
| Server → App | `call_ended` / `call_missed` / `call_rejected` | Call finished |

---

## 6) Phase order for mobile

**Phase A (required first — do this now)**  
Connect + register + incoming UI + accept/reject. Prove curl triggers the modal.

**Phase B (voice)**  
Mic PCM → `audio_chunk`, play `ai_audio_chunk`.

**Phase C (background)**  
FCM token on `register` + notification full-screen incoming call (backend FCM comes later).

---

## Definition of done (Phase A)

- [ ] App connects to backend Socket.IO URL  
- [ ] `register` sent with correct `userId`  
- [ ] User visible in `/api/v1/presence/online`  
- [ ] After API trigger, Accept/Reject UI appears  
- [ ] Accept → `call_started` received  
- [ ] Reject → call dismissed  
