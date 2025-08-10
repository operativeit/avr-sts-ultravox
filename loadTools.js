const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');

const ULTRAVOX_API_BASE_URL = `https://api.ultravox.ai/api`;


const loadTools = async (dirPath = path.join(__dirname, 'tools')) => {
  try {
    await fs.access(dirPath);
    const files = await fs.readdir(dirPath);
    return files.map(file => {
      const tool = require(path.join(dirPath, file));
      return {
        temporaryTool: {
          modelToolName: tool.name,
          description: tool.description,
          dynamicParameters: tool.parameters,
          client: {}
        }
      };
    });
  } catch (error) {
    return [];
  }
}

const loadDurableTools = async (dirPath = path.join(__dirname, 'avr_tools')) => {
  let response, tools, files, url, method;

  try {
    await fs.access(dirPath);

    response = await axios.get(
      `${ULTRAVOX_API_BASE_URL}/tools`,
      {
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": process.env.ULTRAVOX_API_KEY,
        },
      }
    );

    const existingTools = Object.fromEntries(
      response.data.results.map(tool => [tool.name, tool.toolId])
    );

    const files = await fs.readdir(dirPath);
    const durableTools = [];

    for (const file of files) {
      const tool = require(path.join(dirPath, file));
      const toolId = existingTools[tool.name];

      if (toolId) {
        method = 'put';
        url = `${ULTRAVOX_API_BASE_URL}/tools/${toolId}`;
      } else {
        method = 'post';
        url = `${ULTRAVOX_API_BASE_URL}/tools`;
      }

      response = await axios({
        method,
        url,
        data: {
          name: tool.name,
          definition: {
            modelToolName: tool.name,
            description: tool.description,
            dynamicParameters: tool.parameters,
            client: {},
          },
        },
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": process.env.ULTRAVOX_API_KEY,
        },
      });

      durableTools.push({ toolId }); 
    }

    console.log('durable tools loaded');
    return durableTools;

  } catch (error) {
    console.error(error);
  }
};

/**
 * Gets the handler for a specific tool
 * @param {string} name - Name of the tool
 * @returns {Function} Tool handler
 * @throws {Error} If the tool is not found
 */
const getToolHandler = async (name) => {
  // Possible paths for the tool file
  const possiblePaths = [
    path.join(__dirname, 'avr_tools', `${name}.js`),  // First check in avr_tools
    path.join(__dirname, 'tools', `${name}.js`)       // Then check in tools
  ];

  let toolPath;
  for (const filePath of possiblePaths) {
    try {
      await fs.access(filePath);
      toolPath = filePath;
      break;
    } catch (error) {
    }
  }

  if (!toolPath) {
    throw new Error(`Tool "${name}" not found in any available directory`);
  }

  const tool = require(toolPath);
  return tool.handler;
}

module.exports = { loadDurableTools, loadTools, getToolHandler };
