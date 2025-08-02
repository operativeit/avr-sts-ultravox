const express = require("express");
const axios = require("axios");
const WebSocket = require("ws");
const { AudioResampler } = require("avr-resampler");
require("dotenv").config();

// Initialize Express application
const app = express();

if (!process.env.ULTRAVOX_AGENT_ID) {
  throw new Error("ULTRAVOX_AGENT_ID is not set");
}

// Get the configurable Ultravox sample rate
const ULTRAVOX_SAMPLE_RATE = parseInt(process.env.ULTRAVOX_SAMPLE_RATE) || 48000;
const ULTRAVOX_API_URL = `https://api.ultravox.ai/api/agents/${process.env.ULTRAVOX_AGENT_ID}/calls`;
const ULTRAVOX_CLIENT_BUFFER_SIZE_MS = process.env.ULTRAVOX_CLIENT_BUFFER_SIZE_MS || 60;

const resampler = new AudioResampler(ULTRAVOX_SAMPLE_RATE);

/**
 * Connects to Ultravox API and returns an open WebSocket connection
 * @returns {Promise<WebSocket>} The WebSocket connection to Ultravox
 */
async function connectToUltravox() {
  console.log("Connecting to Ultravox API", ULTRAVOX_API_URL);
  const response = await axios.post(
    ULTRAVOX_API_URL,
    {
      medium: {
        serverWebSocket: {
          inputSampleRate: ULTRAVOX_SAMPLE_RATE,
          outputSampleRate: ULTRAVOX_SAMPLE_RATE,
          clientBufferSizeMs: ULTRAVOX_CLIENT_BUFFER_SIZE_MS,
        },
      },
    },
    {
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": process.env.ULTRAVOX_API_KEY,
      },
    }
  );

  const joinUrl = response.data.joinUrl;
  if (!joinUrl) {
    throw new Error("Missing Ultravox joinUrl");
  }

  return new WebSocket(joinUrl);
}

/**
 * Handles incoming client audio stream and manages communication with Ultravox's API.
 * Implements buffering for audio chunks received before WebSocket connection is established.
 *
 * @param {Request} req - Express request object
 * @param {Response} res - Express response object
 */
const handleAudioStream = async (req, res) => {
  res.setHeader("Content-Type", "application/octet-stream");

  const ultravoxWebSocket = await connectToUltravox();

  ultravoxWebSocket.on("open", () => {
    console.log("WebSocket connected to Ultravox");
  });

  ultravoxWebSocket.on("message", async (data, isBinary) => {
    if (isBinary) {
      // Handle binary audio data from Ultravox
      const convertedAudio = await resampler.handleDownsampleChunk(data);
      for (const chunk of convertedAudio) {
        res.write(chunk);
      }
    } else {
      // Handle JSON control messages from Ultravox
      const message = JSON.parse(data.toString());
      
      switch (message.type) {
        case "call_started":
          console.log("Call started", message.callId);
          break;
          
        case "state":
          console.log("State", message.state);
          break;
          
        case "transcript":
          if (message.final) {
            console.log(`${message.role.toUpperCase()} (${message.medium}): ${message.text}`);
          }
          break;
          
        case "playback_clear_buffer":
          console.log("Playback clear buffer");
          const convertedAudio = await resampler.flushDownsampleRemainder();
          for (const chunk of convertedAudio) {
            res.write(chunk);
          }
          break;
          
        case "error":
          console.error("Error", message);
          break;
          
        default:
          console.log("Received message type:", message.type);
          break;
      }
    }
  });

  ultravoxWebSocket.on("close", () => {
    console.log("WebSocket connection closed");
    res.end();
  });

  ultravoxWebSocket.on("error", (err) => {
    console.error("WebSocket error:", err);
    res.end();
  });

  // Handle incoming audio data from client
  req.on("data", async (audioChunk) => {
    if (ultravoxWebSocket.readyState === ultravoxWebSocket.OPEN) {
      const convertedAudio = await resampler.handleUpsampleChunk(audioChunk);
      if (convertedAudio) {
        ultravoxWebSocket.send(convertedAudio);
      }
    }
  });

  req.on("end", () => {
    console.log("Request stream ended");
    ultravoxWebSocket.close();
  });

  req.on("error", (err) => {
    console.error("Request error:", err);
    ultravoxWebSocket.close();
  });
};

// Route for speech-to-speech streaming
app.post("/speech-to-speech-stream", handleAudioStream);

const PORT = process.env.PORT || 6031;
app.listen(PORT, async () => {
  console.log(`Ultravox Speech-to-Speech server running on port ${PORT}`);
  await resampler.initialize();
});
