const axios = require('axios');

module.exports = {
  name: 'n8nWebhook',
  description: 'Trigger an N8N webhook',
  parameters: [
  ],
  handler: async (uuid) => {
    console.log("Trigger N8N webhook");
  },
};
