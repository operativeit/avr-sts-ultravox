const { searchKnowledge } = require("../configProvider");

module.exports = {
  name: "searchKnowledge",
  description:
    "Searches the knowledge base (RAG) for relevant information, documentation, FAQs, or policies to answer the user's question accurately.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "The search query or question to look up in the vector database.",
      },
      topK: {
        type: "number",
        description:
          "Optional maximum number of relevant chunks to retrieve (default: 3).",
      },
    },
    required: ["query"],
  },
  handler: async (uuid, { query, topK } = {}, meta = {}) => {
    const activeAgentId = meta?.currentAgent || meta?.to;

    console.log(
      `[searchKnowledge] Searching "${query}" for call UUID=${uuid} (agent=${activeAgentId || "unknown"})`
    );

    const context = await searchKnowledge(query, activeAgentId, uuid, {
      ...(topK ? { topK } : {}),
    });

    if (!context) {
      return "No relevant information found in the knowledge base for this query.";
    }

    return context;
  },
};
