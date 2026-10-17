module.exports = {
  name: "saveCallNote",
  description:
    "Guarda en un payload JSON todos los datos verificados del llamante (tipo de cliente particular/empresa, nombre de la empresa si aplica, nombre y apellidos, DNI/NIE/CIF, teléfono, email opcional y motivo de la llamada) antes de finalizar la llamada.",
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
  },
  handler: async (uuid, params = {}, meta = {}) => {
    const payload = {
      callId: uuid,
      timestamp: new Date().toISOString(),
      callerId: meta?.from || meta?.callerId || null,
      agentId: meta?.currentAgent || meta?.to || null,
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

    return {
      ok: true,
      message: "Nota de llamada registrada correctamente.",
    };
  },
};
