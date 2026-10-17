/**
 * index.js
 * Entry point for the Ultravox Speech-to-Speech streaming WebSocket server.
 * This server handles real-time audio streaming between clients and Ultravox's API,
 * performing necessary audio format conversions and WebSocket communication.
 * Supports both agent-specific calls and generic calls.
 *
 * Client Protocol:
 * - Send {"type": "init", "uuid": "uuid"} to initialize session
 * - Send {"type": "audio", "audio": "base64_encoded_audio"} to stream audio
 * - Send {"type": "tool_result", "invocationId": "...", "result": "..."} after handling a tool_invocation (optional: responseType, agentReaction, source, errors)
 * - Receive {"type": "audio", "audio": "base64_encoded_audio"} for responses
 * - Receive {"type": "tool_invocation", "toolName", "invocationId", "parameters", "source?"} for Ultravox client/data-connection tools
 * - Receive {"type": "error", "message": "error_message"} for errors
 *
 * @author Agent Voice Response <info@agentvoiceresponse.com>
 * @see https://www.agentvoiceresponse.com
 */

const WebSocket = require("ws");
const axios = require("axios");
const { loadTools, getToolHandler } = require("./loadTools");
const {
  getConfig,
  syncMemory,
  enrichPromptWithDateTime,
} = require("./configProvider");

require("dotenv").config();

/** Upper bound for inline server tool handlers (default: AMI_REQUEST_TIMEOUT_MS + 2s). */
const AVR_TOOL_EXECUTION_TIMEOUT_MS = (() => {
  const amiDefault = parseInt(process.env.AMI_REQUEST_TIMEOUT_MS || "10000", 10);
  const amiMs =
    Number.isFinite(amiDefault) && amiDefault > 0 ? amiDefault : 10000;
  const raw = parseInt(process.env.AVR_TOOL_EXECUTION_TIMEOUT_MS || "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : amiMs + 2000;
})();

/** Timeout for Ultravox REST `POST …/calls` that returns joinUrl (default 60s). */
const ULTRAVOX_JOIN_HTTP_TIMEOUT_MS = (() => {
  const raw = parseInt(
    process.env.ULTRAVOX_JOIN_HTTP_TIMEOUT_MS || "60000",
    10
  );
  return Number.isFinite(raw) && raw > 0 ? raw : 60000;
})();

/**
 * Maps an OpenAI-style JSON Schema (function parameters) to Ultravox dynamicParameters.
 * @param {Record<string, unknown>|undefined} schema
 * @returns {Array<Record<string, unknown>>}
 */
function jsonSchemaToDynamicParameters(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [];
  const props =
    schema.properties && typeof schema.properties === "object"
      ? schema.properties
      : {};
  const required = new Set(
    Array.isArray(schema.required) ? schema.required : []
  );
  return Object.entries(props).map(([name, propSchema]) => ({
    name,
    location: "PARAMETER_LOCATION_BODY",
    schema: propSchema,
    required: required.has(name),
  }));
}

/**
 * Converts tools from loadTools() into Ultravox selectedTools entries (temporary client tools).
 * @returns {Array<Record<string, unknown>>}
 */
function avrToolsAsUltravoxSelectedTools() {
  const tools = loadTools();
  return tools.map((t) => ({
    temporaryTool: {
      modelToolName: t.name,
      description: t.description || "",
      dynamicParameters: jsonSchemaToDynamicParameters(t.parameters),
      client: {},
    },
  }));
}

/** @returns {Array<Record<string, unknown>>|null} */
function buildGenericSelectedTools() {
  try {
    const avr = avrToolsAsUltravoxSelectedTools();
    if (avr.length) {
      console.log(
        `Registering ${avr.length} AVR tool(s) from avr_tools/tools (Ultravox selectedTools)`
      );
      return avr;
    }
  } catch (e) {
    console.warn("Could not load AVR tools for generic call:", e.message);
  }
  return null;
}

/** @returns {Record<string, unknown>|null} */
function buildAgentToolOverrides() {
  try {
    const add = avrToolsAsUltravoxSelectedTools();
    if (add.length) {
      console.log(
        `Registering ${add.length} AVR tool(s) from avr_tools/tools (Ultravox toolOverrides.add)`
      );
      return { add };
    }
  } catch (e) {
    console.warn("Could not load AVR tools for agent call:", e.message);
  }
  return null;
}

/**
 * @param {string} toolName
 * @returns {((uuid: string, args: object) => Promise<unknown>)|null}
 */
function tryGetToolHandler(toolName) {
  try {
    return getToolHandler(toolName);
  } catch {
    return null;
  }
}

/**
 * Builds a client_tool_result or data_connection_tool_result message for Ultravox.
 * @param {Record<string, unknown>} message Parsed client message (type tool_result).
 * @returns {Record<string, unknown>}
 */
function buildUltravoxToolResultPayload(message) {
  const source = message.source;
  const ultravoxType =
    source === "data_connection"
      ? "data_connection_tool_result"
      : "client_tool_result";

  const payload = {
    type: ultravoxType,
    invocationId: message.invocationId,
  };

  if (message.errorType) {
    payload.errorType = message.errorType;
    if (message.errorMessage != null) payload.errorMessage = message.errorMessage;
    return payload;
  }

  if (message.result !== undefined) {
    payload.result =
      typeof message.result === "string"
        ? message.result
        : JSON.stringify(message.result);
  }
  if (message.responseType != null) payload.responseType = message.responseType;
  if (message.agentReaction != null) payload.agentReaction = message.agentReaction;
  if (message.updateCallState !== undefined)
    payload.updateCallState = message.updateCallState;

  return payload;
}

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} label
 * @returns {Promise<T>}
 */
function promiseWithTimeout(promise, ms, label) {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms
    );
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutId);
  });
}

/**
 * @param {WebSocket} ultravoxWebSocket
 * @param {Record<string, unknown>} payload
 * @returns {boolean}
 */
function sendUltravoxJson(ultravoxWebSocket, payload) {
  if (!ultravoxWebSocket || ultravoxWebSocket.readyState !== WebSocket.OPEN) {
    console.warn("Cannot forward to Ultravox: WebSocket not open", payload?.type);
    return false;
  }
  try {
    ultravoxWebSocket.send(JSON.stringify(payload));
    return true;
  } catch (err) {
    console.error("Failed sending to Ultravox:", err?.message ?? err);
    return false;
  }
}

function sendClientJson(clientWs, payload) {
  if (!clientWs || clientWs.readyState !== WebSocket.OPEN) {
    console.warn("Cannot send to client: WebSocket not open", payload?.type);
    return false;
  }
  try {
    clientWs.send(JSON.stringify(payload));
    return true;
  } catch (err) {
    console.error("Failed sending to client:", err?.message ?? err);
    return false;
  }
}

/**
 * Intenta parsear el resultado de la herramienta de forma segura.
 * @param {unknown} res
 * @returns {Record<string, unknown>|null}
 */
function parseToolResult(res) {
  if (res && typeof res === "object" && !Array.isArray(res)) return res;
  if (typeof res === "string") {
    try {
      const parsed = JSON.parse(res);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed
        : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Extrae el body de configuración del nuevo stage y lo serializa a JSON string
 * como exige el protocolo WebSocket de Ultravox en `client_tool_result.result`.
 * @param {Record<string, unknown>} parsedResult
 * @returns {string}
 */
function serializeNewStageResult(parsedResult) {
  let stageBody = parsedResult.body ?? parsedResult.result;
  if (stageBody === undefined) {
    const {
      responseType: _rt,
      agentReaction: _ar,
      updateCallState: _ucs,
      ...rest
    } = parsedResult;
    stageBody = rest;
  }
  return typeof stageBody === "string" ? stageBody : JSON.stringify(stageBody);
}

/**
 * Runs a registered disk tool server-side and always attempts an Ultravox tool result envelope.
 * @param {object} opts
 * @param {WebSocket|null} opts.ultravoxWebSocket
 * @param {WebSocket} opts.clientWs
 * @param {string|null} opts.sessionUuid
 * @param {string} opts.toolName
 * @param {unknown} opts.invocationId
 * @param {Record<string, unknown>} opts.parameters
 * @param {'client'|'data_connection'} opts.channel
 */
async function executeToolAndSendUltravoxResult(opts) {
  const {
    ultravoxWebSocket,
    clientWs,
    sessionUuid,
    toolName,
    invocationId,
    parameters,
    channel,
  } = opts;

  const handler = tryGetToolHandler(toolName);
  const isSocketOpen = ultravoxWebSocket?.readyState === WebSocket.OPEN;

  if (!handler || !isSocketOpen) {
    sendClientJson(clientWs, {
      type: "tool_invocation",
      ...(channel === "data_connection" ? { source: "data_connection" } : {}),
      toolName,
      invocationId,
      parameters,
    });
    return;
  }

  const resultMessageType =
    channel === "data_connection"
      ? "data_connection_tool_result"
      : "client_tool_result";

  try {
    const rawResult = await promiseWithTimeout(
      handler(sessionUuid, parameters, clientWs?.meta || {}),
      AVR_TOOL_EXECUTION_TIMEOUT_MS,
      toolName
    );

    const parsedResult = parseToolResult(rawResult);
    const isNewStage = parsedResult?.responseType === "new-stage";

    const payload = {
      type: resultMessageType,
      invocationId,
      ...(isNewStage
        ? {
            responseType: "new-stage",
            result: serializeNewStageResult(parsedResult),
            ...(parsedResult.agentReaction && {
              agentReaction: parsedResult.agentReaction,
            }),
            ...(parsedResult.updateCallState !== undefined && {
              updateCallState: parsedResult.updateCallState,
            }),
          }
        : {
            result:
              typeof parsedResult?.result === "string"
                ? parsedResult.result
                : typeof rawResult === "string"
                  ? rawResult
                  : JSON.stringify(rawResult),
            ...(parsedResult?.agentReaction && {
              agentReaction: parsedResult.agentReaction,
            }),
          }),
    };

    sendUltravoxJson(ultravoxWebSocket, payload);

    sendClientJson(clientWs, {
      type: "tool_invocation",
      ...(channel === "data_connection" ? { source: "data_connection" } : {}),
      toolName,
      invocationId,
      parameters,
      serverHandled: true,
    });
  } catch (err) {
    console.error(`Error executing AVR tool ${toolName}:`, err);
    sendUltravoxJson(ultravoxWebSocket, {
      type: resultMessageType,
      invocationId,
      errorType: "implementation-error",
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  }
}

// Configuration for call type
const CALL_TYPE = process.env.ULTRAVOX_CALL_TYPE || 'agent'; // 'agent' or 'generic'
const ULTRAVOX_AGENT_ID = process.env.ULTRAVOX_AGENT_ID;

// Validate configuration based on call type
if (CALL_TYPE === 'agent' && !ULTRAVOX_AGENT_ID) {
  throw new Error("ULTRAVOX_AGENT_ID is required when CALL_TYPE is 'agent'");
}

// Get the configurable Ultravox sample rate
const ULTRAVOX_SAMPLE_RATE = parseInt(
  process.env.ULTRAVOX_SAMPLE_RATE || "8000",
  10
);
const ULTRAVOX_CLIENT_BUFFER_SIZE_MS = parseInt(
  process.env.ULTRAVOX_CLIENT_BUFFER_SIZE_MS || "60",
  10
);

// API URLs based on call type
const getApiUrl = () => {
  if (CALL_TYPE === 'agent') {
    return `https://api.ultravox.ai/api/agents/${ULTRAVOX_AGENT_ID}/calls`;
  } else {
    return 'https://api.ultravox.ai/api/calls';
  }
};

/**
 * Connects to Ultravox API and returns an open WebSocket connection
 * @param {string} uuid - The unique identifier for the call
 * @returns {Promise<WebSocket>} The WebSocket connection to Ultravox
 */
async function connectToUltravox(uuid, params = {}) {
  const apiUrl = getApiUrl();
  console.log(
    `Connecting to Ultravox API (${CALL_TYPE} call)`,
    apiUrl,
    ULTRAVOX_SAMPLE_RATE,
    ULTRAVOX_CLIENT_BUFFER_SIZE_MS
  );

  console.log(params);

  // Prepare the request body based on call type

  let requestBody;
  
  if (CALL_TYPE === 'agent') {
    // Agent-specific call configuration
    requestBody = {
      metadata: {
        uuid: uuid,
      },
      medium: {
        serverWebSocket: {
          inputSampleRate: ULTRAVOX_SAMPLE_RATE,
          outputSampleRate: ULTRAVOX_SAMPLE_RATE,
          clientBufferSizeMs: ULTRAVOX_CLIENT_BUFFER_SIZE_MS,
        },
      },
    };

    const toolOverrides = buildAgentToolOverrides();
    if (toolOverrides) {
      requestBody.toolOverrides = toolOverrides;
    }
  } else {
    // Generic call configuration

    let dynamicConfig = {};
    try {
      dynamicConfig = await getConfig(params?.to, uuid, params);
    } catch (err) {
      console.error("Error loading initial agent config:", err.message);
    }

    const fallbackPrompt = enrichPromptWithDateTime(
      process.env.ULTRAVOX_SYSTEM_PROMPT || "You are a helpful AI assistant.",
      {},
      params || {}
    );

    requestBody = {
      systemPrompt: fallbackPrompt,
      temperature: parseFloat(process.env.ULTRAVOX_TEMPERATURE) || 0,
      model: process.env.ULTRAVOX_MODEL || "fixie-ai/ultravox",
      voice: process.env.ULTRAVOX_VOICE || "Shaun",
      ...(process.env.ULTRAVOX_LANGUAGE_HINT
        ? { languageHint: process.env.ULTRAVOX_LANGUAGE_HINT }
        : {}),
      ...dynamicConfig,
      metadata: {
        uuid: uuid,
      },
      medium: {
        serverWebSocket: {
          inputSampleRate: ULTRAVOX_SAMPLE_RATE,
          outputSampleRate: ULTRAVOX_SAMPLE_RATE,
          clientBufferSizeMs: ULTRAVOX_CLIENT_BUFFER_SIZE_MS,
        },
      },
      recordingEnabled: process.env.ULTRAVOX_RECORDING_ENABLED === 'true' || false,
      joinTimeout: process.env.ULTRAVOX_JOIN_TIMEOUT || "30s",
      maxDuration: process.env.ULTRAVOX_MAX_DURATION || "3600s",
    };

    // Add external voice configuration if provided
    if (process.env.ULTRAVOX_EXTERNAL_VOICE_PROVIDER) {
      const voiceProvider = process.env.ULTRAVOX_EXTERNAL_VOICE_PROVIDER.toLowerCase();
      
      switch (voiceProvider) {
        case 'elevenlabs':
          requestBody.externalVoice = {
            elevenLabs: {
              voiceId: process.env.ULTRAVOX_ELEVENLABS_VOICE_ID,
              model: process.env.ULTRAVOX_ELEVENLABS_MODEL || "eleven_monolingual_v1",
              speed: parseFloat(process.env.ULTRAVOX_ELEVENLABS_SPEED) || 1.0,
              useSpeakerBoost: process.env.ULTRAVOX_ELEVENLABS_USE_SPEAKER_BOOST === 'true' || true,
            }
          };
          break;
        case 'cartesia':
          requestBody.externalVoice = {
            cartesia: {
              voiceId: process.env.ULTRAVOX_CARTESIA_VOICE_ID,
              model: process.env.ULTRAVOX_CARTESIA_MODEL || "cartesia-1",
              speed: parseFloat(process.env.ULTRAVOX_CARTESIA_SPEED) || 1.0,
            }
          };
          break;
        case 'lmnt':
          requestBody.externalVoice = {
            lmnt: {
              voiceId: process.env.ULTRAVOX_LMNT_VOICE_ID,
              model: process.env.ULTRAVOX_LMNT_MODEL || "lmnt-1",
              speed: parseFloat(process.env.ULTRAVOX_LMNT_SPEED) || 1.0,
              conversational: process.env.ULTRAVOX_LMNT_CONVERSATIONAL === 'true' || true,
            }
          };
          break;
        case 'generic':
          requestBody.externalVoice = {
            generic: {
              url: process.env.ULTRAVOX_GENERIC_VOICE_URL,
              headers: JSON.parse(process.env.ULTRAVOX_GENERIC_VOICE_HEADERS || '{}'),
              body: JSON.parse(process.env.ULTRAVOX_GENERIC_VOICE_BODY || '{}'),
              responseSampleRate: parseInt(process.env.ULTRAVOX_GENERIC_VOICE_SAMPLE_RATE) || 24000,
              responseWordsPerMinute: parseInt(process.env.ULTRAVOX_GENERIC_VOICE_WPM) || 150,
              responseMimeType: process.env.ULTRAVOX_GENERIC_VOICE_MIME_TYPE || "audio/wav",
              jsonAudioFieldPath: process.env.ULTRAVOX_GENERIC_VOICE_AUDIO_FIELD || "audio",
            }
          };
          break;
      }
    }

    const selectedFromDisk = buildGenericSelectedTools();
    if (selectedFromDisk) {
      requestBody.selectedTools = selectedFromDisk;
    }

    // Add VAD settings if provided via .env or /init
    if (process.env.ULTRAVOX_VAD_SETTINGS) {
      try {
        requestBody.vadSettings = {
          ...JSON.parse(process.env.ULTRAVOX_VAD_SETTINGS),
          ...(dynamicConfig.vadSettings &&
          typeof dynamicConfig.vadSettings === "object"
            ? dynamicConfig.vadSettings
            : {}),
        };
      } catch (error) {
        console.warn("Invalid ULTRAVOX_VAD_SETTINGS JSON format:", error.message);
      }
    }

    // Add inactivity messages if not already set by /init backend
    if (typeof requestBody.inactivityMessages === "string") {
      try {
        requestBody.inactivityMessages = JSON.parse(
          requestBody.inactivityMessages
        );
      } catch (error) {
        console.warn(
          "Invalid inactivityMessages JSON string from API:",
          error.message
        );
        delete requestBody.inactivityMessages;
      }
    }
    if (!Array.isArray(requestBody.inactivityMessages)) {
      if (process.env.ULTRAVOX_INACTIVITY_MESSAGES) {
        try {
          requestBody.inactivityMessages = JSON.parse(
            process.env.ULTRAVOX_INACTIVITY_MESSAGES
          );
        } catch (error) {
          console.warn(
            "Invalid ULTRAVOX_INACTIVITY_MESSAGES JSON format:",
            error.message
          );
        }
      } else {
        requestBody.inactivityMessages = [
          {
            duration: "8s",
            message: "¿Hola? ¿Sigues ahí? ¿Me escuchas?",
            endBehavior: "END_BEHAVIOR_UNSPECIFIED",
          },
          {
            duration: "6s",
            message:
              "Vaya, parece que no tienes muy buena cobertura ahora mismo o hay ruido en la línea. Si te parece, prueba a llamarnos de nuevo desde un sitio con mejor cobertura o desde otro teléfono para que te podamos atender bien. Muchas gracias por llamar, ¡hasta ahora!",
            endBehavior: "END_BEHAVIOR_HANG_UP_SOFT",
          },
        ];
      }
    }

    if (Array.isArray(requestBody.inactivityMessages)) {
      requestBody.inactivityMessages = requestBody.inactivityMessages.map(
        (item) => ({
          ...item,
          duration:
            typeof item?.duration === "number"
              ? `${item.duration}s`
              : typeof item?.duration === "string" &&
                  /^\d+(\.\d+)?$/.test(item.duration.trim())
                ? `${item.duration.trim()}s`
                : item?.duration,
        })
      );
    }

    // Protect initial greeting from initial WebSocket burst and hands-free echo/noise interruption
    if (
      requestBody.firstSpeaker !== "FIRST_SPEAKER_USER" &&
      !requestBody.firstSpeakerSettings?.user
    ) {
      const existingAgentGreeting =
        requestBody.firstSpeakerSettings?.agent &&
        typeof requestBody.firstSpeakerSettings.agent === "object"
          ? requestBody.firstSpeakerSettings.agent
          : {};
      requestBody.firstSpeakerSettings = {
        agent: {
          uninterruptible: true,
          delay: process.env.ULTRAVOX_FIRST_SPEAKER_DELAY || "0.5s",
          ...existingAgentGreeting,
        },
      };
      delete requestBody.firstSpeaker;
    }
  }

  console.log("Request body:", requestBody);

  const response = await axios.post(
    apiUrl,
    requestBody,
    {
      timeout: ULTRAVOX_JOIN_HTTP_TIMEOUT_MS,
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": process.env.ULTRAVOX_API_KEY,
      },
    }
  );

  console.log("Response:", response.data);

  const joinUrl = response.data.joinUrl;
  if (!joinUrl) {
    throw new Error("Missing Ultravox joinUrl");
  }

  return new WebSocket(joinUrl);
}

/**
 * Handles incoming client WebSocket connection and manages communication with Ultravox's API.
 * Implements buffering for audio chunks received before WebSocket connection is established.
 *
 * @param {WebSocket} clientWs - Client WebSocket connection
 */
const handleClientConnection = (clientWs) => {
  console.log("New client WebSocket connection received");
  let sessionUuid = null;

  let ultravoxWebSocket = null;

  let ultravoxStartTime = null;
  let greetingStarted = false;
  let unmuteUserAudioAt = 0;

  // Handle client WebSocket messages
  clientWs.on("message", (data) => {
    try {
      const message = JSON.parse(data);
      switch (message.type) {
        case "init":
          sessionUuid = message.uuid;

          console.log("Session UUID:", sessionUuid);
          // Initialize Ultravox connection when client is ready
          initializeUltravoxConnection();
          break;

        case "audio":
          // Handle audio data from client
          if (message.audio && ultravoxWebSocket && ultravoxWebSocket.readyState === WebSocket.OPEN) {
            const audioBuffer = Buffer.from(message.audio, "base64");
            const now = Date.now();
            // Send digital silence while the initial greeting is playing (plus 400ms echo tail)
            // so hands-free echo or room noise during the greeting isn't queued as a user turn.
            if (unmuteUserAudioAt === 0 || now < unmuteUserAudioAt) {
              ultravoxWebSocket.send(Buffer.alloc(audioBuffer.length));
            } else {
              ultravoxWebSocket.send(audioBuffer);
            }
          }
          break;

        case "tool_result": {
          if (
            ultravoxWebSocket &&
            ultravoxWebSocket.readyState === WebSocket.OPEN &&
            typeof message.invocationId === "string"
          ) {
            const toolPayload = buildUltravoxToolResultPayload(message);
            ultravoxWebSocket.send(JSON.stringify(toolPayload));
          } else if (!message.invocationId) {
            console.warn("tool_result ignored: missing invocationId");
          } else {
            console.warn("tool_result ignored: Ultravox socket not ready");
            clientWs.send(
              JSON.stringify({
                type: "error",
                message: "Cannot forward tool_result: Ultravox connection not ready",
              })
            );
          }
          break;
        }

        default:
          console.log("Unknown message type from client:", message.type);
          break;
      }
    } catch (error) {
      console.error("Error processing client message:", error);
    }
  });

  // Initialize Ultravox WebSocket connection
  const initializeUltravoxConnection = async () => {
    try {
      ultravoxWebSocket = await connectToUltravox(sessionUuid,clientWs.meta);

      ultravoxWebSocket.on("open", () => {
        console.log("WebSocket connected to Ultravox");
        // Safety fallback: unmute after 12s even if agent greeting state was skipped
        setTimeout(() => {
          if (unmuteUserAudioAt === 0) {
            unmuteUserAudioAt = Date.now();
          }
        }, 12000);
      });

      ultravoxWebSocket.on("message", async (data, isBinary) => {
        if (isBinary) {
          // Handle binary audio data from Ultravox
          clientWs.send(
            JSON.stringify({
              type: "audio",
              audio: data.toString("base64"),
            })
          );
        } else {
          // Handle JSON control messages from Ultravox
          let message;
          try {
            message = JSON.parse(data.toString());
          } catch (parseErr) {
            console.error(
              "Invalid JSON from Ultravox:",
              parseErr?.message ?? parseErr
            );
            return;
          }

          switch (message.type) {
            case "call_started":
              console.log("Call started", message.callId);
              break;

            case "state":
              console.log("State", message.state);
              if (message.state === "speaking") {
                greetingStarted = true;
              } else if (
                message.state === "listening" &&
                greetingStarted &&
                unmuteUserAudioAt === 0
              ) {
                // Wait 400ms after greeting ends for Asterisk playback & hands-free echo to clear
                unmuteUserAudioAt = Date.now() + 400;
              }
              break;

            case "transcript":
              if (message.final) {
                console.log(
                  `${message.role.toUpperCase()} (${message.medium}): ${
                    message.text
                  }`
                );
                // Send transcript to client
                sendClientJson(clientWs, {
                  type: "transcript",
                  role: message.role,
                  text: message.text,
                });

                // Conversational Memory: store turn and inject recalled customer memories if returned
                if (
                  message.text?.trim() &&
                  (process.env.API_MEMORY_ENABLED === "true" ||
                    process.env.AGENT_MEMORY_ENABLED === "true" ||
                    Boolean(process.env.API_MEMORY_ENDPOINT))
                ) {
                  const activeAgentId =
                    clientWs.meta?.currentAgent || clientWs.meta?.to;
                  const callerId = clientWs.meta?.from;

                  syncMemory({
                    callId: sessionUuid,
                    agentId: activeAgentId,
                    callerId,
                    role: message.role,
                    text: message.text,
                  })
                    .then((memoryContext) => {
                      if (memoryContext && message.role === "user") {
                        console.log(
                          `[Memory] Injecting customer memory for call ${sessionUuid}`
                        );
                        sendUltravoxJson(ultravoxWebSocket, {
                          type: "user_text_message",
                          text: `[CUSTOMER MEMORY / CONTEXT]\n${memoryContext}`,
                          urgency:
                            process.env.API_MEMORY_URGENCY ||
                            process.env.AGENT_MEMORY_URGENCY ||
                            "later",
                        });
                      }
                    })
                    .catch((err) => {
                      console.error(
                        "[Memory] Error syncing transcript memory:",
                        err.message
                      );
                    });
                }
              }
              break;

            case "playback_clear_buffer":
              console.log("Playback clear buffer");
              sendClientJson(clientWs, {
                type: "interruption",
              });
              break;

            case "client_tool_invocation": {
              if (message.toolName === "avr_hangup") {
                unmuteUserAudioAt = Number.MAX_SAFE_INTEGER;
              }
              await executeToolAndSendUltravoxResult({
                ultravoxWebSocket,
                clientWs,
                sessionUuid,
                toolName: message.toolName,
                invocationId: message.invocationId,
                parameters: message.parameters ?? {},
                channel: "client",
              });
              break;
            }

            case "data_connection_tool_invocation": {
              await executeToolAndSendUltravoxResult({
                ultravoxWebSocket,
                clientWs,
                sessionUuid,
                toolName: message.toolName,
                invocationId: message.invocationId,
                parameters: message.parameters ?? {},
                channel: "data_connection",
              });
              break;
            }

            case "error":
              console.error("Error", message);
              clientWs.send(
                JSON.stringify({
                  type: "error",
                  message: message.message || "Unknown error occurred",
                })
              );
              break;

            default:
              console.log("Received message type:", message.type);
              break;
          }
        }
      });

      ultravoxWebSocket.on("close", () => {
        console.log("Ultravox WebSocket connection closed");
        if (sessionUuid && clientWs && clientWs.readyState === WebSocket.OPEN) {
          const hangupHandler = tryGetToolHandler("avr_hangup");
          if (hangupHandler) {
            hangupHandler(sessionUuid, {}).catch((err) =>
              console.error("Auto-hangup on Ultravox close failed:", err.message)
            );
          }
          setTimeout(cleanup, 5000);
        } else {
          cleanup();
        }
      });

      ultravoxWebSocket.on("error", (err) => {
        console.error("Ultravox WebSocket error:", err);
        clientWs.send(
          JSON.stringify({
            type: "error",
            message: "Connection to Ultravox failed",
          })
        );
        cleanup();
      });
    } catch (error) {
      console.error("Error initializing Ultravox connection:", error);
      clientWs.send(
        JSON.stringify({
          type: "error",
          message: "Failed to connect to Ultravox",
        })
      );
      cleanup();
    }
  };

  // Handle client WebSocket close
  clientWs.on("close", () => {
    console.log("Client WebSocket connection closed");
    cleanup();
  });

  clientWs.on("error", (err) => {
    console.error("Client WebSocket error:", err);
    cleanup();
  });

  /**
   * Cleans up resources and closes connections.
   */
  function cleanup() {
    if (ultravoxWebSocket) ultravoxWebSocket.close();
    if (clientWs) clientWs.close();
  }
};

// Start WebSocket server
const startServer = async () => {
  try {
    // Create WebSocket server
    const PORT = process.env.PORT || 6031;
    const wss = new WebSocket.Server({ port: PORT });


    wss.on("connection", (clientWs, req) => {

      const url = new URL(req.url, `http://${req.headers.host}`)
      const queryParams = Object.fromEntries(url.searchParams.entries());

      clientWs.meta = queryParams;

      console.log("New client connected");
      handleClientConnection(clientWs);
    });

    console.log(
      `Ultravox Speech-to-Speech WebSocket server running on port ${PORT}`
    );
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
};

// Start the server
startServer();
