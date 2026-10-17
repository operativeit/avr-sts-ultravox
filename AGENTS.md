# AGENTS.md — Guidelines for `avr-sts-ultravox`

This repository implements the **Ultravox Speech-to-Speech (S2S) WebSocket bridge** for **Agent Voice Response (`avr-core`) / Asterisk**. It connects 8 kHz telephony audio streams from Asterisk to Ultravox's real-time WebSocket API, dynamically loads agent configurations, RAG knowledge, and conversational memory from an external HTTP backend (`/init`, `/stage`, `/rag`, `/memory`), and executes telephony tools (`avr_hangup`, `avr_transfer`, `changeStage`, `searchKnowledge`).

---

## 1. Project Architecture & Key Files

- **[`index.js`](./index.js)**: Main WebSocket server. Handles the `avr-core` client protocol (`init`, `audio`, `tool_result`, `interruption`), creates Ultravox calls (`POST https://api.ultravox.ai/api/calls`), manages bidirectional PCM audio streaming, and dispatches client/data-connection tool invocations.
- **[`configProvider.js`](./configProvider.js)**: Fetches and normalizes agent configuration from the backend API (`API_URL` + `API_AGENT_ENDPOINT`), maps snake_case aliases (`FIELD_ALIASES`) to Ultravox camelCase fields, enriches `systemPrompt` with date/time/greeting/caller variables (`{{current_greeting}}`, `{{current_time}}`, `{{current_date}}`, `{{caller_phone}}`), and handles `/rag` and `/memory` requests.
- **[`loadTools.js`](./loadTools.js)**: Dynamically loads Ultravox tools from `avr_tools/` (core Asterisk AMI tools) and `tools/` (custom agent tools).
- **[`avr_tools/avr_hangup.js`](./avr_tools/avr_hangup.js)**: Terminates the Asterisk call via `POST ${AMI_URL}/hangup` with a playback safety delay (`AVR_HANGUP_DELAY_MS`, default `4000ms`) and `agentReaction: "listens"` so farewell TTS audio finishes playing without repeating before the channel is cut.
- **[`avr_tools/avr_transfer.js`](./avr_tools/avr_transfer.js)**: Transfers the Asterisk call via `POST ${AMI_URL}/transfer`.
- **[`tools/changeStage.js`](./tools/changeStage.js)**: Transitions the Ultravox call to a new Call Stage (`responseType: "new-stage"`), loading the target stage configuration from the backend API.
- **[`tools/searchKnowledge.js`](./tools/searchKnowledge.js)**: Queries the backend RAG vector database (`pgvector`) for documentation and FAQs.
- **[`tools/validateSpanishId.js`](./tools/validateSpanishId.js)**: Validates Spanish NIF/DNI, NIE, and company CIF numbers using official Ministry of Interior / AEAT checksum algorithms.
- **[`tools/saveCallNote.js`](./tools/saveCallNote.js)**: Receives and logs the verified caller contact JSON payload (`customerType`, `companyName`, `fullName`, `documentId`, `phone`, `email`, `reason`) before ending the call.

---

## 2. Critical Audio, VAD & Telephony Rules

1. **Never send `{ type: "interruption" }` on `state === "listening"`**:
   - Ultravox transitions its state to `"listening"` as soon as it finishes **generating** TTS audio, while `avr-core` / Asterisk still has buffered audio left to play.
   - Sending `interruption` on `state === "listening"` cuts off the last words of every agent sentence.
   - **Rule**: Only forward `{ type: "interruption" }` to `clientWs` when Ultravox emits `case "playback_clear_buffer":` (true user barge-in).
2. **Real-Time Audio Pacing (`clientBufferSizeMs: 60`)**:
   - Always pass `clientBufferSizeMs: ULTRAVOX_CLIENT_BUFFER_SIZE_MS` (default `60`) inside `medium.serverWebSocket` so Ultravox paces outbound audio at 1x real-time instead of bursting the entire response buffer at once.
3. **Initial Greeting Protection (Echo & RTP Stabilization)**:
   - Use `firstSpeakerSettings: { agent: { uninterruptible: true, delay: "0.5s" } }` (and remove conflicting `firstSpeaker`) so the initial greeting waits 500ms for the Asterisk RTP path to stabilize and cannot be cut off by initial line noise.
   - While the initial greeting is playing (plus a `400ms` echo tail after the first transition to `"listening"`, tracked via `unmuteUserAudioAt`), send digital silence (`Buffer.alloc(audioBuffer.length)`) to Ultravox so hands-free speakerphone echo is not queued as an immediate user turn.
4. **8 kHz Telephony VAD Tuning (`ULTRAVOX_VAD_SETTINGS`)**:
   - On 8 kHz phone lines, short Spanish confirmations like *"Sí"* have an unvoiced sibilant (`s`) followed by a very brief vowel (`í`, ~80–120ms).
   - If `frameActivationThreshold` (> `0.30`) or `minimumTurnDuration` (> `0.15s`) is set too high, Ultravox completely ignores brief *"Sí"* / *"No"* responses.
   - **Recommended settings**:
     ```json
     {
       "frameActivationThreshold": 0.15,
       "minimumTurnDuration": "0s",
       "minimumInterruptionDuration": "0.45s",
       "turnEndpointDelay": "0.50s"
     }
     ```
   - `minimumInterruptionDuration: "0.45s"` protects the agent while speaking without blocking short answers when the agent is listening.
5. **Protobuf Duration Strings in Ultravox API**:
   - All duration fields sent to Ultravox (`joinTimeout`, `maxDuration`, `inactivityMessages[].duration`, `vadSettings.*`, `firstSpeakerSettings.agent.delay`) must be strings ending in `"s"` (e.g. `"8s"`, `"0.50s"`).
   - `index.js` automatically normalizes numeric durations (e.g. `duration: 8` → `"8s"`) in `inactivityMessages` so the backend API can send numbers or strings.
6. **Inactivity & Graceful Hangup (`inactivityMessages` + `avr_hangup`)**:
   - An LLM cannot initiate speech during user silence unless `inactivityMessages` is configured on the Ultravox call.
   - When Ultravox closes the WebSocket after `END_BEHAVIOR_HANG_UP_SOFT` while `clientWs` is still open, `index.js` automatically invokes `avr_hangup` so Asterisk hangs up the SIP/PSTN channel after the farewell audio finishes playing.

---

## 3. Prompt Engineering Standards for Ultravox S2S

When writing or updating voice agent prompts for this platform (see `.agents/skills/ultravox-prompt-architect/SKILL.md` for full templates):
- **Use the 9-section Markdown structure**:
  1. `# IDENTIDAD`
  2. `# OBJETIVOS`
  3. `# CONTEXTO`
  4. `# VOCABULARIO CLAVE Y RECONOCIMIENTO FONÉTICO`
  5. `# DIRECTRICES DE ESTILO`
  6. `# DIRECTRICES DE RESPUESTA`
  7. `# RESTRICCIONES`
  8. `# FLUJO DE CONVERSACIÓN`
  9. `# VARIABLES DE ENTRADA`
- **No section duplication**: Keep Active Listening (`## ESCUCHA ACTIVA`) inside `# DIRECTRICES DE ESTILO`, never duplicated inside `# IDENTIDAD`.
- **Never use conditional `Si conoces {{contact_name}}` in the prompt**: The backend API replaces `{{contact_name}}` with the literal value before sending the prompt, turning conditionals into confusing text (`Si conoces Carlos: ... Si no conoces Carlos: ...`) that causes the agent to greet twice. Always use a single direct greeting in Step 1 with `{{current_greeting}}`.
- **Separate phonetic understanding (Input) from agent confirmation (Output)**:
  - **Input**: Understand Spanish phonetic words (*"C de Casa, M de Madrid, X de Xilófono"*), double letters (*"con dos T"* → `TT`), and short 8 kHz telephony confirmations (*"sí", "si", "i", "y", "ajá", "vale"*).
  - **Output**: Never recite city names when confirming. Pronounce the name and spell complex surnames simply letter-by-letter (`C - R - A - M - A - T - T - E`), confirm DNI/NIE character-by-character 1-by-1 (`X - 6 - 3 - 0 - 0 - 0 - 7 - 8 - X`), and confirm phone numbers using the exact same digit grouping spoken by the caller.
