/** * index.js
 * Entry point for the Ultravox Speech-to-Speech streaming application.
 * This server handles real-time audio streaming between clients and Ultravox's API,
 * performing necessary audio format conversions and WebSocket communication.
 *
 * @author Agent Voice Response <info@agentvoiceresponse.com>
 * @see https://www.agentvoiceresponse.com
 */

const express = require('express');
const axios = require('axios');
const WebSocket = require('ws');
const config = require('./config');

const { loadTools, loadDurableTools, getToolHandler } = require('./loadTools');
const { beforeCall } = require('./callbacks');

require('dotenv').config();

// Initialize Express application
const app = express();

if (!process.env.ULTRAVOX_AGENT_ID) {
  throw new Error('ULTRAVOX_AGENT_ID is not set');
}

// Get the configurable Ultravox sample rate
const ULTRAVOX_SAMPLE_RATE = 8000;
const ULTRAVOX_API_BASE_URL = `https://api.ultravox.ai/api`;
const ULTRAVOX_CLIENT_BUFFER_SIZE_MS =
  process.env.ULTRAVOX_CLIENT_BUFFER_SIZE_MS || 60;

/**
 * Connects to Ultravox API and returns an open WebSocket connection
 * @returns {Promise<WebSocket>} The WebSocket connection to Ultravox
 */
async function setupUltravox() {
  try {
    const selectedTools = [
      ...(await loadTools()),
      ...(await loadDurableTools()),
    ];

    const context = JSON.parse(process.env.ULTRAVOX_TEMPLATE_CONTEXT || {});

    const wrappedContext =
      '\n\n# VARIABLES\n\n' +
      Object.entries(context)
        .map(
          ([key, properties]) => `- **{{${key}}}** ${properties.description}`,
        )
        .join('\n');

    const response = await axios.get(
      `${ULTRAVOX_API_BASE_URL}/agents/${process.env.ULTRAVOX_AGENT_ID}`,
      {
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': process.env.ULTRAVOX_API_KEY,
        },
      },
    );
    const callTemplate = response.data.callTemplate;
    callTemplate.selectedTools = selectedTools;
    callTemplate.systemPrompt =
      process.env.ULTRAVOX_AGENT_PROMPT + wrappedContext;

    callTemplate.languageHint = 'es-ES';

    const responsePatch = await axios.patch(
      `${ULTRAVOX_API_BASE_URL}/agents/${process.env.ULTRAVOX_AGENT_ID}`,
      {
        callTemplate,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': process.env.ULTRAVOX_API_KEY,
        },
      },
    );

    if (config.debug) {
      console.log(responsePatch.data);
      console.log('templateContext:', wrappedContext);
    }
  } catch (error) {
    if (error.response) {
      console.log(error.response.data);
    } else {
      console.log(error);
    }
  }
}

/**
 * Connects to Ultravox API and returns an open WebSocket connection
 * @returns {Promise<WebSocket>} The WebSocket connection to Ultravox
 */
async function connectToUltravox(uuid) {
  try {
    const templateContext = Object.fromEntries(
      Object.entries(
        JSON.parse(process.env.ULTRAVOX_TEMPLATE_CONTEXT || {}),
      ).map(([key, properties]) => [key, properties.value]),
    );

    if (templateContext.hasOwnProperty('current_datetime')) {
      const currentDate = new Date().toLocaleDateString(
        config.dateTime.locale,
        {
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric',
        },
      );

      const currentTime = new Date()
        .toLocaleTimeString(config.dateTime.locale, {
          hour: '2-digit',
          minute: '2-digit',
        })
        .replace(':', 'h');

      const currentDateTime = currentDate + ' ' + currentTime;
      templateContext.current_datetime = currentDateTime;
    }

    await beforeCall(uuid, templateContext);

    const response = await axios.post(
      `${ULTRAVOX_API_BASE_URL}/agents/${process.env.ULTRAVOX_AGENT_ID}/calls`,
      {
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
        templateContext,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': process.env.ULTRAVOX_API_KEY,
        },
      },
    );

    console.log(response.status, response.data.joinUrl);

    const joinUrl = response.data.joinUrl;
    if (!joinUrl) {
      throw new Error('Missing Ultravox joinUrl');
    }

    return new WebSocket(joinUrl);
  } catch (error) {
    if (error.response) {
      throw new Error(error.response.data);
    } else {
      throw new Error(error);
    }
  }
}

/**
 * Handles incoming client audio stream and manages communication with Ultravox's API.
 * Implements buffering for audio chunks received before WebSocket connection is established.
 *
 * @param {Request} req - Express request object
 * @param {Response} res - Express response object
 */
const handleAudioStream = async (req, res) => {
  const uuid = req.headers['x-uuid'];
  console.log('Received UUID:', uuid);

  const ultravoxWebSocket = await connectToUltravox(uuid);

  ultravoxWebSocket.on('open', () => {
    console.log('WebSocket connected to Ultravox');
  });

  let ultravoxChunksQueue = Buffer.alloc(0);
  let isFirstUltravoxChunk = true;
  let ultravoxStartTime = null;

  let callId = null;

  ultravoxWebSocket.on('message', async (data, isBinary) => {
    if (isBinary) {
      // Handle binary audio data from Ultravox
      if (isFirstUltravoxChunk) {
        ultravoxStartTime = Date.now();
        isFirstUltravoxChunk = false;
        console.log('First Ultravox audio chunk received, starting delay...');
      }

      // Add Ultravox chunk to buffer
      ultravoxChunksQueue = Buffer.concat([ultravoxChunksQueue, data]);

      // If we have accumulated enough time, write the buffer
      if (ultravoxStartTime && Date.now() - ultravoxStartTime >= 100) {
        // Create a copy of the current buffer and reset the original
        const bufferToWrite = ultravoxChunksQueue;
        ultravoxChunksQueue = Buffer.alloc(0);

        // Write the buffer to the response
        res.write(bufferToWrite);
      }
    } else {
      // Handle JSON control messages from Ultravox
      const message = JSON.parse(data.toString());

      switch (message.type) {
        case 'call_started':
          console.log('Call started', message.callId);
          callId = message.callId;
          break;

        case 'state':
          console.log('State', message.state, callId);
          break;

        case 'client_tool_invocation':
          const invocationId = message.invocationId;
          const toolName = message.toolName;

          try {
            const handler = await getToolHandler(toolName);
            if (!handler) {
              console.error(`No handler found for tool: ${toolName}`);

              ultravoxWebSocket.send(
                JSON.stringify({
                  type: 'client_tool_result',
                  invocationId,
                  errorType: 'undefined',
                  errorMessage: `Client tool ${toolName} is not registered`,
                }),
              );
            } else {
              console.log(
                `>> Tool call: ${toolName}`,
                uuid,
                message.parameters,
              );

              const result = await handler(uuid, message.parameters);

              if (typeof result === 'string') {
                console.log(`>> Tool response: ${toolName} ->`, result);
                ultravoxWebSocket.send(
                  JSON.stringify({
                    type: 'client_tool_result',
                    result,
                    responseType: 'tool-response',
                    invocationId,
                  }),
                );
              } else if (
                typeof result.result !== 'string' ||
                typeof result.responseType !== 'string'
              ) {
                ultravoxWebSocket.send(
                  JSON.stringify({
                    type: 'client_tool_result',
                    errorType: 'implementation-error',
                    errorMessage:
                      'Client tool result must be a string or an object with string "result" and "responseType" properties.',
                    responseType: 'tool-response',
                    invocationId,
                  }),
                );
              } else {
                console.log(
                  `>> Tool response: ${toolName} ->`,
                  JSON.stringify(result),
                );
                ultravoxWebSocket.send(
                  JSON.stringify({
                    type: 'client_tool_result',
                    ...result,
                    invocationId,
                  }),
                );
              }
            }
          } catch (toolError) {
            const errorMessage = toolError.response
              ? toolError.response.data
              : toolError;

            console.error(
              `[Error executing tool ${message.toolName}:`,
              errorMessage,
            );

            ultravoxWebSocket.send(
              JSON.stringify({
                type: 'client_tool_result',
                responseType: 'tool-response',
                errorType: 'implementation-error',
                errorMessage,
                invocationId,
              }),
            );
          }

          break;

        case 'transcript':
          if (message.final) {
            console.log(
              `${message.role.toUpperCase()} (${message.medium}): ${
                message.text
              }`,
            );
          }
          break;

        case 'playback_clear_buffer':
          console.log('Playback clear buffer');
          break;

        case 'error':
          console.error('Error', message);
          break;

        default:
          console.log('Received message type:', message.type);
          break;
      }
    }
  });

  ultravoxWebSocket.on('close', () => {
    console.log('WebSocket connection closed');
    res.end();
  });

  ultravoxWebSocket.on('error', (err) => {
    console.error('WebSocket error:', err);
    res.end();
  });

  // Handle incoming audio data from client
  req.on('data', async (audioChunk) => {
    if (ultravoxWebSocket.readyState === ultravoxWebSocket.OPEN) {
      ultravoxWebSocket.send(audioChunk);
    }
  });

  req.on('end', () => {
    console.log('Request stream ended');
    ultravoxWebSocket.close();
  });

  req.on('error', (err) => {
    console.error('Request error:', err);
    clearInterval(interval);
    ultravoxWebSocket.close();
  });
};

setupUltravox();

// Route for speech-to-speech streaming
app.post('/speech-to-speech-stream', handleAudioStream);

const PORT = process.env.PORT || 6031;
app.listen(PORT, async () => {
  console.log(`Ultravox Speech-to-Speech server running on port ${PORT}`);
});
