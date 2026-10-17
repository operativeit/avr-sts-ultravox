---
name: ultravox-avr-audio-tuning
description: >-
  Use this skill when configuring, debugging, or modifying the Ultravox Speech-to-Speech
  WebSocket server (index.js, configProvider.js, avr_tools/, .env) for Asterisk (avr-core),
  including VAD settings, cut-off sentences, hands-free echo protection, inactivity timers,
  Protobuf duration formatting, AMI hangup delays, and Intl.DateTimeFormat variable injection.
---

# Ultravox + Asterisk (`avr-core`) Audio, VAD & Server Tuning

Use this runbook whenever diagnosing audio cutoffs, missed confirmations (*"Sí"*), initial greeting double-presentations, silence/inactivity timeouts, or backend API configuration mapping in `avr-sts-ultravox`.

---

## 1. Diagnosing & Fixing Common Telephony Symptoms

### Symptom A: Agent's speech is cut off at the end of every sentence
- **Root Cause 1**: Forwarding `{ type: "interruption" }` to `avr-core` when Ultravox sends `{ type: "state", state: "listening" }`. Ultravox enters `"listening"` as soon as TTS generation finishes, while Asterisk still has buffered audio playing.
  - **Fix**: In [`index.js`](../../../index.js), ONLY send `{ type: "interruption" }` inside `case "playback_clear_buffer":`.
- **Root Cause 2**: Missing or huge `clientBufferSizeMs`.
  - **Fix**: Ensure `ULTRAVOX_CLIENT_BUFFER_SIZE_MS=60` in [`.env`](../../../.env) and pass `clientBufferSizeMs: 60` inside `medium.serverWebSocket`.

### Symptom B: Agent greets twice or immediately interrupts itself after the initial greeting
- **Root Cause**: Hands-free acoustic echo or RTP startup noise during the initial greeting is picked up by Ultravox's microphone and queued as a user turn right after the greeting ends.
- **Fix (Two-layer protection in [`index.js`](../../../index.js))**:
  1. Set `firstSpeakerSettings: { agent: { uninterruptible: true, delay: "0.5s" } }` on the Ultravox call creation payload (and delete `firstSpeaker`).
  2. Mute incoming user audio (`ultravoxWebSocket.send(Buffer.alloc(audioBuffer.length))`) while the initial greeting is playing plus a `400ms` echo tail after the first transition from `"speaking"` to `"listening"` (`unmuteUserAudioAt = Date.now() + 400`).

### Symptom C: Agent ignores brief *"Sí"* / *"No"* confirmations or takes too long to advance
- **Root Cause**: On 8 kHz phone lines, a Spanish *"Sí"* consists of an unvoiced sibilant (`s`) and a short vowel (`í`, ~80–120ms). If `frameActivationThreshold` (> `0.30`) or `minimumTurnDuration` (> `0.15s`) is too high, VAD discards the *"Sí"* as noise.
- **Fix in [`.env`](../../../.env)**:
  ```env
  ULTRAVOX_VAD_SETTINGS={"frameActivationThreshold":0.15,"minimumTurnDuration":"0s","minimumInterruptionDuration":"0.45s","turnEndpointDelay":"0.50s"}
  ```
  - `frameActivationThreshold: 0.15` & `minimumTurnDuration: "0s"`: Captures even the shortest monosyllable immediately.
  - `minimumInterruptionDuration: "0.45s"`: Prevents short line clicks from interrupting the agent while she is speaking.
  - `turnEndpointDelay: "0.50s"`: Responds snappily after user confirmations while allowing natural pauses when dictating numbers.

### Symptom D: Agent stays silent forever when the caller stops speaking
- **Root Cause**: An LLM cannot initiate a turn while Ultravox is in `"listening"` state without `inactivityMessages`.
- **Fix in [`index.js`](../../../index.js)**:
  - Configure `inactivityMessages` on the Call creation payload (overridable via `inactivity_messages` from the `/init` API or `ULTRAVOX_INACTIVITY_MESSAGES` in `.env`).
  - Normalize numeric `duration` values (e.g., `8` → `"8s"`) because Ultravox uses `google.protobuf.Duration` strings.
  - When `ultravoxWebSocket.on("close")` fires while `clientWs` is still open (after `END_BEHAVIOR_HANG_UP_SOFT`), trigger `avr_hangup` so Asterisk closes the telephony channel.

### Symptom E: Farewell message is cut off when `avr_hangup` is called
- **Root Cause**: Ultravox sends `client_tool_invocation` (`avr_hangup`) while the farewell TTS audio is still streaming to Asterisk.
- **Fix in [`avr_tools/avr_hangup.js`](../../../avr_tools/avr_hangup.js)**:
  - Schedule `axios.post("${url}/hangup", { uuid })` inside a `setTimeout` (`AVR_HANGUP_DELAY_MS`, default `4000ms`) and immediately return `"Call hangup initiated."` so the farewell finishes playing before AMI cuts the line.

---

## 2. Dynamic Variables & Greeting Configuration (`configProvider.js`)

[`configProvider.js`](../../../configProvider.js) automatically enriches `systemPrompt` on both `/init` and `/stage` responses using `Intl.DateTimeFormat`:

- **Environment variables in [`.env`](../../../.env)**:
  ```env
  APP_LOCALE=es-ES
  APP_TIMEZONE=Europe/Madrid
  GREETING_CONFIG={"morning":{"from":6,"to":14,"text":"buenos días"},"afternoon":{"from":14,"to":21,"text":"buenas tardes"},"night":{"from":21,"to":6,"text":"buenas noches"}}
  ```
- **Supported placeholders**:
  - `{{current_greeting}}`: Resolved from `GREETING_CONFIG` and current hour in `APP_TIMEZONE`.
  - `{{current_time}}`: 24-hour time formatted via `Intl.DateTimeFormat` (e.g., `22:45`).
  - `{{current_date}}`: Full localized date (e.g., `sábado, 17 de octubre de 2026`).
  - If `{{current_time}}` or `{{current_date}}` are not present in the prompt, `configProvider.js` automatically appends `- **Hora actual**: ...` and `- **Fecha**: ...` to the end of `systemPrompt`.

---

## 3. Verification Checklist After Making Changes

1. Validate syntax across modified files:
   ```bash
   node -c index.js && node -c configProvider.js && node -c avr_tools/avr_hangup.js
   ```
2. Verify that all Ultravox duration fields in `requestBody` end with `"s"`.
3. Restart the Node.js process after editing `.env`, `index.js`, or `configProvider.js`.
