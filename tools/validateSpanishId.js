const DNI_LETTERS = "TRWAGMYFPDXBNJZSQVHLCKE";
const CIF_CONTROL_LETTERS = "JABCDEFGHI";

/**
 * Valida un NIF (DNI / K,L,M), NIE (X,Y,Z) o CIF español según el algoritmo oficial del Ministerio del Interior / AEAT.
 * @param {string} rawValue
 * @returns {{ valid: boolean, type: string|null, normalized: string, message: string }}
 */
function verifySpanishDocument(rawValue) {
  if (!rawValue || typeof rawValue !== "string") {
    return {
      valid: false,
      type: null,
      normalized: "",
      message: "No se ha proporcionado ningún documento para validar.",
    };
  }

  const normalized = rawValue.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();

  if (normalized.length !== 9) {
    return {
      valid: false,
      type: null,
      normalized,
      message: `Longitud incorrecta (${normalized.length} caracteres). Un NIF, NIE o CIF español debe tener exactamente 9 caracteres.`,
    };
  }

  // 1. DNI estándar: 8 dígitos + 1 letra
  if (/^\d{8}[A-Z]$/.test(normalized)) {
    const numberPart = parseInt(normalized.slice(0, 8), 10);
    const letter = normalized[8];
    const expectedLetter = DNI_LETTERS[numberPart % 23];
    const isValid = letter === expectedLetter;
    return {
      valid: isValid,
      type: "DNI",
      normalized,
      message: isValid
        ? `DNI ${normalized} válido.`
        : `El DNI ${normalized} NO es válido: la letra o alguno de los números no coincide con el dígito de control oficial. Pide al cliente que verifique su DNI.`,
    };
  }

  // 2. NIE: X, Y o Z + 7 dígitos + 1 letra
  if (/^[XYZ]\d{7}[A-Z]$/.test(normalized)) {
    const prefixMap = { X: "0", Y: "1", Z: "2" };
    const numericString = prefixMap[normalized[0]] + normalized.slice(1, 8);
    const numberPart = parseInt(numericString, 10);
    const letter = normalized[8];
    const expectedLetter = DNI_LETTERS[numberPart % 23];
    const isValid = letter === expectedLetter;
    return {
      valid: isValid,
      type: "NIE",
      normalized,
      message: isValid
        ? `NIE ${normalized} válido.`
        : `El NIE ${normalized} NO es válido: la letra o alguno de los números no coincide con el dígito de control oficial. Pide al cliente que verifique su NIE.`,
    };
  }

  // 3. CIF (personas jurídicas / empresas) y NIF especiales (K, L, M)
  if (/^[ABCDEFGHJNPQRSUVW KLM]\d{7}[0-9A-J]$/.test(normalized)) {
    const firstChar = normalized[0];
    const digits = normalized.slice(1, 8);
    const control = normalized[8];

    // Para NIF especiales K, L, M también pueden validarse por módulo 23 de DNI
    if ("KLM".includes(firstChar)) {
      const numberPart = parseInt(digits, 10);
      const expectedDniLetter = DNI_LETTERS[numberPart % 23];
      if (control === expectedDniLetter) {
        return {
          valid: true,
          type: "NIF",
          normalized,
          message: `NIF especial ${normalized} válido.`,
        };
      }
    }

    let evenSum = 0;
    let oddSum = 0;

    for (let i = 0; i < digits.length; i++) {
      const digit = parseInt(digits[i], 10);
      if ((i + 1) % 2 === 0) {
        // Posiciones pares (2, 4, 6)
        evenSum += digit;
      } else {
        // Posiciones impares (1, 3, 5, 7)
        const doubled = digit * 2;
        oddSum += Math.floor(doubled / 10) + (doubled % 10);
      }
    }

    const totalSum = evenSum + oddSum;
    const controlDigit = (10 - (totalSum % 10)) % 10;
    const controlLetter = CIF_CONTROL_LETTERS[controlDigit];

    let isValid = false;
    if ("PQRSWN".includes(firstChar)) {
      // Obligatoriamente letra
      isValid = control === controlLetter;
    } else if ("ABEH".includes(firstChar)) {
      // Obligatoriamente número
      isValid = control === String(controlDigit);
    } else {
      // Acepta tanto número como letra
      isValid = control === String(controlDigit) || control === controlLetter;
    }

    return {
      valid: isValid,
      type: "CIF",
      normalized,
      message: isValid
        ? `CIF ${normalized} válido.`
        : `El CIF ${normalized} NO es válido: el carácter de control o los dígitos no coinciden. Pide al cliente que verifique el CIF.`,
    };
  }

  return {
    valid: false,
    type: null,
    normalized,
    message: `El documento "${normalized}" no tiene un formato válido de DNI, NIE ni CIF español.`,
  };
}

module.exports = {
  name: "validateSpanishId",
  description:
    "Valida si un documento español (DNI, NIF, NIE o CIF de empresa) es matemáticamente válido comprobando su letra o dígito de control oficial.",
  input_schema: {
    type: "object",
    properties: {
      documentId: {
        type: "string",
        description:
          "El número de DNI, NIE o CIF completo (9 caracteres, incluyendo letra inicial si es NIE/CIF y letra o número final).",
      },
    },
    required: ["documentId"],
  },
  handler: async (uuid, { documentId } = {}) => {
    const result = verifySpanishDocument(documentId);
    console.log(`[validateSpanishId] Call=${uuid} Input="${documentId}" ->`, result);
    return result;
  },
};
