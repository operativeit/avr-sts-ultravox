const { getConfig } = require("../configProvider");

/**
 * Propiedades permitidas por Ultravox al hacer un cambio de Call Stage (`new-stage`).
 * Filtra campos de nivel llamada (como `model` o `maxDuration`) si el backend devuelve un agente completo.
 * @see https://docs.ultravox.ai/agents/call-stages#stages-call-properties
 */
const ALLOWED_STAGE_KEYS = new Set([
  "systemPrompt",
  "temperature",
  "voice",
  "externalVoice",
  "languageHint",
  "initialMessages",
  "selectedTools",
  "toolResultText",
]);

module.exports = {
  name: "changeStage",
  description:
    "Transitions the current call to a specialized sub-agent or new conversation stage using its handle (e.g., 'sales', 'support', 'billing', 'manager'). Use this tool when the conversation needs to change phase or be handled by a specific sub-agent.",
  input_schema: {
    type: "object",
    properties: {
      handle: {
        type: "string",
        description:
          "Unique handle or identifier of the target sub-agent / stage (e.g., 'support', 'sales', 'billing').",
      },
      context: {
        type: "string",
        description:
          "Brief summary of the user's request or collected information to pass to the new stage.",
      },
    },
    required: ["handle"],
  },
  handler: async (uuid, { handle, context } = {}, meta = {}) => {
    if (!handle || typeof handle !== "string") {
      throw new Error("Parameter 'handle' is required to change stage");
    }

    console.log(
      `[changeStage] Loading agent/stage "${handle}" for call UUID=${uuid}`
    );

    const agentConfig = await getConfig(handle, uuid, {
      from: meta?.from,
      parentAgentId: meta?.to,
      ...(context ? { context } : {}),
    });

    if (meta && typeof meta === "object") {
      meta.currentAgent = handle;
    }

    const stageBody = Object.entries(agentConfig).reduce((acc, [k, v]) => {
      if (ALLOWED_STAGE_KEYS.has(k)) acc[k] = v;
      return acc;
    }, {});

    if (!stageBody.toolResultText && context) {
      stageBody.toolResultText = `(New Stage) Context: ${context}`;
    }

    return {
      responseType: "new-stage",
      body: stageBody,
    };
  },
};
