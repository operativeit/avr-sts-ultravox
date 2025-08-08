const axios = require("axios");
module.exports = {
  name: "avrTransfer",
  description: "Transfers a call to a specific extension.",
  parameters: [
    {
      name : "transfer_extension",
      location:  "PARAMETER_LOCATION_BODY",
      schema: {
        type: "integer",
        description: "The transfer extension to transfer the call to.",
      },
      required: true
    },
    {
      name: "transfer_context",
      location:  "PARAMETER_LOCATION_BODY",
      schema: {
        type: "string",
        description: "The context to transfer the call to.",
      }
    },
    {
      name: "transfer_priority",
      location:  "PARAMETER_LOCATION_BODY",
      schema: {
        type: "integer",
        description: "The priority of the transfer.",
      }
    }
  ],
  handler: async (
    uuid,
    { transfer_extension, transfer_context, transfer_priority }
  ) => {
    console.log("Transfering call to:", transfer_extension, transfer_context, transfer_priority);
    console.log("UUID:", uuid);

    try {
      const url = process.env.AMI_URL || "http://127.0.0.1:6006";
      const res = await axios.post(`${url}/transfer`, {
        uuid,
        exten: transfer_extension,
        context: transfer_context || "demo",
        priority: transfer_priority || 1,
      });
      console.log("Transfer response:", res.data);
      return res.data.message;
    } catch (error) {
      console.error("Error during transfer:", error.message);
      return `Error during transfer: ${error.message}`;
    }
  },
};
