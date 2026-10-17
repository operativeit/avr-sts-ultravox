---
name: ultravox-prompt-architect
description: >-
  Use this skill when creating, optimizing, or debugging Spanish voice AI system prompts
  for Ultravox Speech-to-Speech (S2S) agents connected to Asterisk (avr-sts-ultravox),
  including receptionists/secretaries, customer support agents, phonetic spelling,
  boosted keywords, step-by-step confirmation flows, and dynamic variables.
---

# Ultravox S2S Voice Prompt Architect (`avr-sts-ultravox`)

This skill provides the tested architecture, phonetic rules, and flow patterns for designing Spanish voice AI prompts on Ultravox Speech-to-Speech (`fixie-ai/ultravox`) over 8 kHz Asterisk telephone lines.

---

## 1. Mandatory Prompt Structure (No `---` Separators)

Always structure prompts in clean Markdown using these sections (without duplicating rules across sections and **without `---` horizontal rules**, which are unnecessary):

1. `# IDENTIDAD`: Who the agent is (`{{agent_name}}`), role (`asistente virtual de...`), company (`{{company_name}}`), and high-level mission. **Do NOT include style or active-listening instructions here.**
2. `# OBJETIVOS`: Numbered list of concrete goals for the call (initial audio check, step-by-step data collection, `validateSpanishId`, `saveCallNote`, flexible objection handling, pre-hangup check, `avr_hangup`).
3. `# CONTEXTO`: Operational context of the call and why accuracy matters.
4. `# VOCABULARIO CLAVE Y RECONOCIMIENTO FONÉTICO`: Input-only ASR/S2S phonetic correction rules, Spanish phonetic alphabet mapping, double-letter rules, Spanish & international phone numbering rules (`6`/`7` mobile, `8`/`9` landline, `+`/`00` international prefixes), email domains, brief 8 kHz confirmation tokens, and `{{boosted_keywords}}`.
5. `# DIRECTRICES DE ESTILO`: Tone, brevity (1–2 short sentences max per turn, 1 question per turn), `## ESCUCHA ACTIVA`, and `## CÓMO CONFIRMAR CADA DATO`.
6. `# MANEJO DE OBJECIONES`: Flexible 2-step handling when the caller hesitates or refuses to provide mandatory data (or asks for a human agent), allowing the caller to change their mind and resume at any time.
7. `# DIRECTRICES DE RESPUESTA`: Operational rules for immediate advancement after `"Sí"`, handling `"No"` / corrections, poor audio/coverage fallback, and inactivity handling with `avr_hangup`.
8. `# RESTRICCIONES`: Strict negative guardrails (no off-topic/small talk, never invent/fill missing data, no city-name phonetic spelling when speaking, 1-by-1 DNI/NIE/CIF, preserve caller's phone grouping, never write `@` or `.com` attached when speaking emails, no double presentation or double farewell).
9. `# FLUJO DE CONVERSACIÓN`: Numbered steps (`PASO 1` to `PASO 8`) with exact phrasing templates.
10. `# VARIABLES DE ENTRADA`: List of injected variables (`{{contact_name}}`, `{{agent_name}}`, `{{company_name}}`, `{{caller_phone}}`, `{{current_time}}`, `{{current_date}}`).

## 2. Golden Rules Learned from Production Testing

### A. Single Direct Greeting with `{{current_greeting}}` (Never Use Conditionals on `{{contact_name}}`)
- The backend (`/init`) replaces `{{contact_name}}` with the literal string **before** `index.js` receives the prompt.
- Writing `Si conoces {{contact_name}}: ... Si no conoces {{contact_name}}: ...` turns into `Si conoces Carlos: ... Si no conoces Carlos: ...`, which confuses the LLM into greeting twice.
- **Always use a single direct greeting in `PASO 1`** using `{{current_greeting}}` (which `configProvider.js` automatically resolves to `"buenos días"`, `"buenas tardes"`, or `"buenas noches"` based on `GREETING_CONFIG` and `APP_TIMEZONE`):
  > *"Hola, {{current_greeting}}. Soy {{agent_name}} de {{company_name}}, tu asistente virtual... Antes de nada, ¿me escuchas bien?"*

### B. Phonetic Understanding (Input) vs Simple Confirmation (Output)
- **Input (Understanding the caller)**:
  - Recognize when the caller spells using Spanish city/word examples (*"C de Casa, R de Roma, A de Albacete, M de Madrid, T de Tarragona, X de Xilófono..."*) and extract only the initial letter.
  - Recognize double-letter clarifications (*"con dos T" / "doble T"* → `TT`, e.g., **Cramatte**; *"con dos L"* → `LL`; *"con dos N"* → `NN`).
- **Output (How the agent confirms data)**:
  - **FORBIDDEN**: The agent must **NEVER** use *"C de Casa, M de Madrid, X de Xilófono"* when speaking aloud—it is slow and tedious for the caller.
  - **Names, Surnames & Companies**: Pronounce the full name and spell only the surname (or complex company name) simply letter-by-letter: *"Cramatte, deletreado C - R - A - M - A - T - T - E, ¿es correcto?"*.
  - **DNI / NIE / CIF (`validateSpanishId` + 1-by-1 confirmation)**: Always invoke the `validateSpanishId` tool first. If `valid: true`, confirm character-by-character **1 by 1**: *"Tomo nota: X - 6 - 3 - 0 - 0 - 0 - 7 - 8 - X, ¿es correcto?"*. If `valid: false`, politely inform the caller that the check letter/digit doesn't match and ask them to repeat it.
  - **Phone Numbers (`{{caller_phone}}` first + caller's grouping)**:
    - First ask if they want to use the same phone number they are calling from (`{{caller_phone}}`, mapped from `clientWs.meta.from`).
    - **If they say yes**: Always repeat `{{caller_phone}}` aloud (e.g., in blocks of 3) and ask *"¿Es correcto?"* to confirm.
    - **If they give another number**: Accept 9-digit Spanish numbers (`6`/`7` mobile, `8`/`9` landline) or international numbers starting with `+` / `00` (any length), and repeat it using **the exact same grouping** used by the caller (1-by-1, 3-by-3, or 3+2+2+2).
  - **Emails (Optional + Natural Spanish TTS)**:
    - Email is **optional**. If the caller doesn't want to leave one, skip directly to the call reason.
    - When confirming an email, **NEVER write `@` or `.com`/`.es` attached**, or TTS switches to an English accent. Always spell the part before `@` letter-by-letter with hyphens and write `"arroba"` and `"punto"` as Spanish words: *"S - C - R - A - M - A - T - T - E, arroba, gmail punto com, ¿es correcto?"*.

### C. Immediate Transition on Short Confirmations (`"Sí"`) & Corrections (`"No"`)
- Over 8 kHz phone audio, the initial `s` of *"sí"* can be soft, so ASR may hear *"sí"*, *"si"*, *"i"*, *"y"*, *"ajá"*, *"vale"*, *"ok"*, or *"correcto"*. Treat any of these after *"¿Es correcto?"* as an immediate **YES** and **ask the next step's question in the very same response turn**.
- When the caller says *"No"* or corrects part of a datum, apply the modification immediately to the datum already captured and repeat the corrected datum for confirmation.

### D. 2-Step Flexible Objection Handling & Final `saveCallNote` + `avr_hangup`
- If a caller hesitates or refuses a mandatory datum, first explain why it's needed and ask if they prefer to provide it now or call back later. If they change their mind at any point (even in `PASO 8`), immediately resume data collection from the missing step.
- Once all data is confirmed in `PASO 7`, invoke `saveCallNote` with the structured JSON payload (`customerType`, `companyName`, `fullName`, `documentId`, `phone`, `email`, `reason`) before asking if they need anything else and ending the call with `avr_hangup`.

## 3. Reference Files & Templates

- **Complete Secretary / Receptionist Prompt Template (v2 — Particular/Empresa, `validateSpanishId`, `{{caller_phone}}`, `saveCallNote`)**: [examples/secretary-prompt.md](./examples/secretary-prompt.md)
- **Base Secretary / Receptionist Prompt Reference (v1)**: [examples/secretary-prompt-v1-reference.md](./examples/secretary-prompt-v1-reference.md)
- **Telecom (Fiber & Mobile) Boosted Keywords Reference**: [references/telecom-boosted-keywords.md](./references/telecom-boosted-keywords.md)
