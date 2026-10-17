require("dotenv").config();

const axios = require("axios");

function getBaseUrl() {
  return (process.env.API_URL || "").trim().replace(/\/+$/, "");
}

function getCustomHeaders() {
  const rawHeaders = process.env.API_HEADERS;
  if (!rawHeaders) return {};
  try {
    return JSON.parse(rawHeaders);
  } catch (e) {
    console.warn("[saveCallNote] Invalid API_HEADERS:", e.message);
    return {};
  }
}

function getTimeoutMs() {
  return parseInt(process.env.API_TIMEOUT_MS || "10000", 10);
}

module.exports = {
  name: "saveCallNote",
  description:
    "Guarda y envía al backend en un payload JSON todos los datos verificados del llamante (tipo de cliente particular/empresa, nombre de la empresa si aplica, nombre y apellidos, DNI/NIE/CIF, teléfono, email opcional y motivo de la llamada) para solicitar que un agente humano le devuelva la llamada.",
  input_schema: {
    type: "object",
    properties: {
      customerType: {
        type: "string",
        enum: ["particular", "empresa"],
        description: "Indica si el cliente llama como 'particular' o en nombre de una 'empresa'.",
      },
      companyName: {
        type: "string",
        description: "Nombre de la empresa (si customerType es 'empresa'; vacío si es 'particular').",
      },
      fullName: {
        type: "string",
        description: "Nombre y apellidos completos confirmados de la persona que llama.",
      },
      documentId: {
        type: "string",
        description: "Número de DNI, NIE o CIF verificado y confirmado (sin guiones ni espacios).",
      },
      phone: {
        type: "string",
        description: "Número de teléfono de contacto confirmado.",
      },
      email: {
        type: "string",
        description: "Correo electrónico de contacto confirmado (vacío si el cliente no quiso dejarlo).",
      },
      reason: {
        type: "string",
        description: "Resumen breve confirmado del motivo de la llamada.",
      },
    },
    required: ["customerType", "fullName", "documentId", "phone", "reason"],
    additionalProperties: true,
  },
  handler: async (uuid, params = {}, meta = {}) => {
    const callerId = meta?.from || meta?.callerId || null;
    const agentId = meta?.currentAgent || meta?.to || null;

    const payload = {
      callId: uuid,
      timestamp: new Date().toISOString(),
      callerId,
      agentId,
      ...params,
      customerType: params.customerType || "particular",
      companyName: params.companyName || null,
      fullName: params.fullName || null,
      documentId: params.documentId || null,
      phone: params.phone || null,
      email: params.email || null,
      reason: params.reason || null,
    };

    console.log(
      "[saveCallNote] Payload JSON de la llamada:",
      JSON.stringify(payload, null, 2)
    );

    const baseUrl = getBaseUrl();
    if (!baseUrl) {
      console.warn(
        "[saveCallNote] No se encontró API_URL configurada; solo se registró en consola."
      );
      return {
        ok: true,
        message: "Nota de llamada registrada localmente (sin URL de backend configurada).",
      };
    }

    const endpoint = (
      process.env.API_HUMAN_CALL_ENDPOINT || "/request-human-call"
    ).replace(/^\/+/, "");
    const url = `${baseUrl}/${endpoint}`;

    try {
      console.log(`[saveCallNote] Enviando POST a ${url}...`);
      const response = await axios.post(url, payload, {
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Agent-Id": agentId || "",
          "X-Call-Id": uuid || "",
          ...(callerId ? { "X-Caller-Id": String(callerId) } : {}),
          ...getCustomHeaders(),
        },
        timeout: getTimeoutMs(),
      });

      console.log("[saveCallNote] Respuesta de", url, ":", response.data);

      return {
        ok: true,
        message: "Nota de llamada registrada correctamente.",
        data: response.data,
      };
    } catch (error) {
      const status = error?.response?.status;
      const errData = error?.response?.data;
      const errMsg =
        errData?.message ||
        errData?.error ||
        error?.message ||
        String(error);

      console.error(
        `[saveCallNote] Error enviando POST a ${url}${status ? ` (HTTP ${status})` : ""}:`,
        errData || errMsg
      );

      return {
        ok: false,
        error: errMsg,
        message:
          "Se produjo un error al registrar la nota en el servidor, pero los datos han quedado anotados en el registro de la llamada.",
      };
    }
  },
};

