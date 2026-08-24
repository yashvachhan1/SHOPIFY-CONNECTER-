const { processChat } = require('../services/llmService');
const { sendResponse } = require('../utils/response');

const handleChat = async (req, res, next) => {
  try {
    const { messages } = req.body;
    
    if (!messages || !Array.isArray(messages)) {
      return sendResponse(res, 400, 'Messages array is required');
    }

    // Set headers for Server-Sent Events (SSE)
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Call processChat which will now stream chunks to res
    await processChat(messages, res);
    
    // Ensure response ends properly after streaming
    if (!res.writableEnded) res.end();
  } catch (error) {
    if (!res.headersSent) {
      next(error);
    } else {
      res.end(`\ndata: ${JSON.stringify({ error: "Internal Server Error" })}\n\n`);
    }
  }
};

module.exports = { handleChat };
