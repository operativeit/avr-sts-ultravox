const axios = require('axios');

module.exports = {
  name: 'avrHangup',
  description: 'Ends the conversation',
  parameters: [
  ],
  handler: async (uuid) => {
    console.log("Hangup call");
    const url = process.env.AMI_URL || 'http://127.0.0.1:6006';

    console.log(url, uuid)
    try {
      const res = await axios.post(`${url}/hangup`, { uuid });
      console.log("Hangup response:", res.data);
      return {
        responseText: res.data.message,
        responseType: "tool-response"
      };

    } catch (error) {
      console.error("Error during hangup:", error.message);
      return `Error during hangup: ${error.message}`;
    }
  },
};
