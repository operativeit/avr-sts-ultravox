require("dotenv").config();

const fs = require("fs");
const path = require("path");
const axios = require("axios");

const FIELD_ALIASES = {
  prompt: "systemPrompt",
  system_prompt: "systemPrompt",
  instructions: "systemPrompt",
  language: "languageHint",
  lang: "languageHint",
  language_hint: "languageHint",
  voice_id: "voice",
  external_voice: "externalVoice",
  initial_messages: "initialMessages",
  selected_tools: "selectedTools",
  tool_result_text: "toolResultText",
  vad_settings: "vadSettings",
  first_speaker: "firstSpeaker",
  first_speaker_settings: "firstSpeakerSettings",
  inactivity_messages: "inactivityMessages",
  greeting_config: "greetingConfig",
};

const DEFAULT_GREETING_CONFIG = {
  morning: { from: 6, to: 14, text: "buenos días" },
  afternoon: { from: 14, to: 21, text: "buenas tardes" },
  night: { from: 21, to: 6, text: "buenas noches" },
};

function resolveGreetingConfig(overrideConfig) {
  if (overrideConfig && typeof overrideConfig === "object") {
    return overrideConfig;
  }
  if (typeof overrideConfig === "string") {
    try {
      return JSON.parse(overrideConfig);
    } catch (e) {
      console.warn("Invalid greeting_config JSON from API:", e.message);
    }
  }
  if (process.env.GREETING_CONFIG) {
    try {
      return JSON.parse(process.env.GREETING_CONFIG);
    } catch (e) {
      console.warn("Invalid GREETING_CONFIG in .env:", e.message);
    }
  }
  return DEFAULT_GREETING_CONFIG;
}

function getGreetingForHour(hour, greetingConfig) {
  const slots = Object.values(greetingConfig || DEFAULT_GREETING_CONFIG);
  for (const slot of slots) {
    if (!slot || typeof slot !== "object") continue;
    const from = Number(slot.from);
    const to = Number(slot.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || !slot.text) continue;
    if (from <= to) {
      if (hour >= from && hour < to) return String(slot.text);
    } else {
      // Overnight range (e.g., 21 to 6)
      if (hour >= from || hour < to) return String(slot.text);
    }
  }
  return DEFAULT_GREETING_CONFIG.morning.text;
}

function enrichPromptWithDateTime(prompt, config = {}, extra = {}) {
  if (!prompt || typeof prompt !== "string") return prompt;

  const locale = (
    config.locale ||
    process.env.APP_LOCALE ||
    process.env.LOCALE ||
    config.languageHint ||
    process.env.ULTRAVOX_LANGUAGE_HINT ||
    "es-ES"
  ).trim();

  const timeZone = (
    config.timezone ||
    config.timeZone ||
    process.env.APP_TIMEZONE ||
    process.env.TIMEZONE ||
    process.env.TZ ||
    "Europe/Madrid"
  ).trim();

  const now = new Date();
  let currentTime = "";
  let currentDate = "";
  let currentHour = now.getHours();

  try {
    currentTime = new Intl.DateTimeFormat(locale, {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(now);

    currentDate = new Intl.DateTimeFormat(locale, {
      timeZone,
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    }).format(now);

    const hourParts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      hour12: false,
    }).formatToParts(now);
    const rawHour = parseInt(
      hourParts.find((p) => p.type === "hour")?.value ?? String(currentHour),
      10
    );
    if (Number.isFinite(rawHour)) {
      currentHour = rawHour % 24;
    }
  } catch (err) {
    console.warn(
      `[DateTimeFormat] Fallback for locale="${locale}" timeZone="${timeZone}":`,
      err.message
    );
    currentTime = now.toTimeString().slice(0, 5);
    currentDate = now.toLocaleDateString("es-ES");
  }

  const greetingConfig = resolveGreetingConfig(config.greetingConfig);
  const currentGreeting = getGreetingForHour(currentHour, greetingConfig);
  const callerPhone = String(
    extra.from || extra.callerId || config.callerPhone || ""
  ).trim();

  const hadTimePlaceholder = /\{\{\s*current_time\s*\}\}/i.test(prompt);
  const hadDatePlaceholder = /\{\{\s*current_date\s*\}\}/i.test(prompt);
  const hadCallerPhonePlaceholder = /\{\{\s*caller_phone\s*\}\}/i.test(prompt);

  let enriched = prompt
    .replace(/\{\{\s*current_greeting\s*\}\}/gi, currentGreeting)
    .replace(/\{\{\s*current_time\s*\}\}/gi, currentTime)
    .replace(/\{\{\s*current_date\s*\}\}/gi, currentDate)
    .replace(/\{\{\s*caller_phone\s*\}\}/gi, callerPhone);

  const appendLines = [];
  if (
    callerPhone &&
    !hadCallerPhonePlaceholder &&
    !/\*\*Tel[eé]fono desde el que llama\*\*/i.test(enriched)
  ) {
    appendLines.push(`- **Teléfono desde el que llama**: ${callerPhone}`);
  }
  if (!hadTimePlaceholder && !/\*\*Hora actual\*\*/i.test(enriched)) {
    appendLines.push(`- **Hora actual**: ${currentTime}`);
  }
  if (!hadDatePlaceholder && !/\*\*Fecha\*\*/i.test(enriched)) {
    appendLines.push(`- **Fecha**: ${currentDate}`);
  }

  if (appendLines.length > 0) {
    enriched = `${enriched.trimEnd()}\n${appendLines.join("\n")}\n`;
  }

  return enriched;
}

function getBaseUrl() {
  return (
    process.env.API_URL ||
    process.env.AGENT_API_URL ||
    process.env.ELOKIA_BASE_URL ||
    ""
  )
    .trim()
    .replace(/\/+$/, "");
}

function getCustomHeaders() {
  const rawHeaders =
    process.env.API_HEADERS ||
    process.env.AGENT_API_HEADERS ||
    process.env.AGENT_CONFIG_HEADERS;
  if (!rawHeaders) return {};
  try {
    return JSON.parse(rawHeaders);
  } catch (e) {
    console.warn("Invalid API_HEADERS:", e.message);
    return {};
  }
}

function getTimeoutMs() {
  return parseInt(
    process.env.API_TIMEOUT_MS ||
      process.env.AGENT_API_TIMEOUT_MS ||
      process.env.AGENT_CONFIG_TIMEOUT_MS ||
      "10000",
    10
  );
}

function normalizeConfig(raw, extra = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const source = raw.data && typeof raw.data === "object" ? raw.data : raw;

  const normalized = Object.entries(source).reduce((acc, [key, value]) => {
    if (value !== undefined && value !== null) {
      acc[FIELD_ALIASES[key] || key] = value;
    }
    return acc;
  }, {});

  if (typeof normalized.systemPrompt === "string") {
    normalized.systemPrompt = enrichPromptWithDateTime(
      normalized.systemPrompt,
      normalized,
      extra
    );
  }

  delete normalized.greetingConfig;
  delete normalized.locale;
  delete normalized.timezone;
  delete normalized.timeZone;

  return normalized;
}

/**
 * Formatea la respuesta de un endpoint RAG o de Memoria en texto plano para el LLM.
 * Soporta respuestas tipo string, `{ context/memory/text: "..." }` o arrays `{ results/memories/chunks/data: [...] }`.
 * @param {unknown} raw
 * @returns {string}
 */
function formatContextResponse(raw) {
  if (!raw) return "";
  if (typeof raw === "string") return raw.trim();
  if (typeof raw !== "object") return "";

  if (typeof raw.memory === "string") return raw.memory.trim();
  if (typeof raw.context === "string") return raw.context.trim();
  if (typeof raw.text === "string") return raw.text.trim();
  if (typeof raw.answer === "string") return raw.answer.trim();

  const items = Array.isArray(raw)
    ? raw
    : raw.memories || raw.results || raw.chunks || raw.documents || raw.data;

  if (!Array.isArray(items) || items.length === 0) return "";

  return items
    .map((item, idx) => {
      if (typeof item === "string") return item.trim();
      if (!item || typeof item !== "object") return "";
      const text =
        item.memory || item.content || item.text || item.chunk || item.body || "";
      const title = item.title || item.source || item.date || "";
      if (!text) return "";
      return title ? `[${idx + 1}] (${title}): ${text}` : `[${idx + 1}] ${text}`;
    })
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Obtiene la configuración de un agente (inicial o sub-agente/stage) desde archivo JSON local o backend HTTP.
 *
 * @param {string} agentId - ID o handle del agente/stage a consultar
 * @param {string} callId - UUID de la llamada
 * @param {Record<string, unknown>} [extra] - Datos adicionales (ej. from/callerId, parentAgentId, context)
 * @returns {Promise<Record<string, unknown>>}
 */
async function getConfig(agentId, callId, extra = {}) {
  if (!agentId) return {};

  // 1. Modo archivo JSON local (opcional)
  const configFile = process.env.AGENT_CONFIG_FILE;
  if (configFile) {
    const filePath = path.isAbsolute(configFile)
      ? configFile
      : path.join(__dirname, configFile);
    const allAgents = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!allAgents[agentId]) {
      throw new Error(`Agent "${agentId}" not found in ${filePath}`);
    }
    return normalizeConfig(allAgents[agentId], extra);
  }

  // 2. Modo Backend HTTP (API_URL)
  const baseUrl = getBaseUrl();
  if (!baseUrl) return {};

  const endpoint = (
    process.env.API_AGENT_ENDPOINT ||
    process.env.AGENT_API_ENDPOINT ||
    "/init"
  ).replace(/^\/+/, "");
  const url = `${baseUrl}/${endpoint}`;
  const callerId = extra.from || extra.callerId || "";

  const response = await axios.get(url, {
    params: { agentId, callId, ...extra },
    headers: {
      Accept: "application/json",
      "X-Agent-Id": agentId,
      "X-Call-Id": callId || "",
      ...(callerId ? { "X-Caller-Id": String(callerId) } : {}),
      ...(extra.parentAgentId
        ? { "X-Parent-Agent-Id": String(extra.parentAgentId) }
        : {}),
      ...getCustomHeaders(),
    },
    timeout: getTimeoutMs(),
  });

  console.log(
    `[getConfig] Payload recibido de ${url} (agent=${agentId}):`,
    response.data
  );

  return normalizeConfig(response.data, extra);
}

/**
 * Consulta el endpoint RAG del backend (documentación, FAQs, catálogo en pgvector).
 *
 * @param {string} query - Texto o pregunta a buscar en la base vectorial
 * @param {string} [agentId] - ID o handle del agente
 * @param {string} [callId] - UUID de la llamada
 * @param {Record<string, unknown>} [extra] - Parámetros extra (ej. topK, category)
 * @returns {Promise<string>}
 */
async function searchKnowledge(query, agentId, callId, extra = {}) {
  if (!query || typeof query !== "string" || !query.trim()) return "";

  const baseUrl = getBaseUrl();
  if (!baseUrl) return "";

  const endpoint = (
    process.env.API_RAG_ENDPOINT ||
    process.env.AGENT_RAG_ENDPOINT ||
    "/rag"
  ).replace(/^\/+/, "");
  const url = `${baseUrl}/${endpoint}`;
  const method = (
    process.env.API_RAG_METHOD ||
    process.env.AGENT_RAG_METHOD ||
    "GET"
  ).toUpperCase();
  const payload = {
    query: query.trim(),
    ...(agentId ? { agentId } : {}),
    ...(callId ? { callId } : {}),
    ...extra,
  };

  const response = await axios({
    method,
    url,
    ...(method === "GET" ? { params: payload } : { data: payload }),
    headers: {
      Accept: "application/json",
      "X-Agent-Id": agentId || "",
      "X-Call-Id": callId || "",
      ...getCustomHeaders(),
    },
    timeout: getTimeoutMs(),
  });

  return formatContextResponse(response.data);
}

/**
 * Envía cada intervención (transcript) al backend de Memoria del cliente.
 * Permite tanto guardar hechos del cliente (nombre, preferencias, historial) como
 * recuperar recuerdos relevantes de llamadas anteriores para inyectarlos en la conversación.
 *
 * @param {object} opts
 * @param {string} opts.callId - UUID de la llamada
 * @param {string} [opts.agentId] - ID o handle del agente activo
 * @param {string} [opts.callerId] - Teléfono o identificador del cliente (`meta.from`)
 * @param {'user'|'agent'} opts.role - Quién habló
 * @param {string} opts.text - Texto transcrito
 * @returns {Promise<string>} Recuerdos relevantes devueltos por el backend (vacío si no hay nuevos)
 */
async function syncMemory({ callId, agentId, callerId, role, text } = {}) {
  if (!text || typeof text !== "string" || !text.trim()) return "";

  const baseUrl = getBaseUrl();
  if (!baseUrl) return "";

  const endpoint = (
    process.env.API_MEMORY_ENDPOINT ||
    process.env.AGENT_MEMORY_ENDPOINT ||
    "/memory"
  ).replace(/^\/+/, "");
  const url = `${baseUrl}/${endpoint}`;

  const response = await axios.post(
    url,
    {
      callId,
      agentId: agentId || "",
      callerId: callerId || "",
      role,
      text: text.trim(),
    },
    {
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Agent-Id": agentId || "",
        "X-Call-Id": callId || "",
        ...(callerId ? { "X-Caller-Id": String(callerId) } : {}),
        ...getCustomHeaders(),
      },
      timeout: getTimeoutMs(),
    }
  );

  return formatContextResponse(response.data);
}

module.exports = {
  getConfig,
  searchKnowledge,
  syncMemory,
  enrichPromptWithDateTime,
};
