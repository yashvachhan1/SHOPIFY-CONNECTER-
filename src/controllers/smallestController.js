const { handleAction } = require('./agentController');
const { smallestApiKey } = require('../config/env');

const streamTTS = async (req, res, next) => {
  try {
    const { text, lang } = req.query;
    const voiceId = lang === 'en' ? 'kaitlyn' : 'meher';
    
    const fetchRes = await fetch('https://api.smallest.ai/waves/v1/tts', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${smallestApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        text,
        voice_id: voiceId,
        model: "lightning_v3.1_pro",
        sample_rate: 24000,
        output_format: "mp3"
      })
    });
    
    if (!fetchRes.ok) throw new Error("TTS Failed");
    
    res.setHeader('Content-Type', 'audio/mpeg');
    
    // Instead of streaming the response (which can hang the browser fetch loop),
    // we buffer it into memory and send it in one go. Sentence chunks are very small.
    const arrayBuffer = await fetchRes.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    res.send(buffer);
  } catch (error) {
    next(error);
  }
};

const handleSmallestWebhook = async (req, res, next) => {
  try {
    let { tool, args, action } = req.body;
    
    if (tool && !action) {
      action = tool;
    }
    
    if (args && typeof args === 'object') {
      req.body = { ...req.body, ...args, action };
    } else {
      req.body.action = action;
    }

    return await handleAction(req, res, next);
  } catch (error) {
    next(error);
  }
};

module.exports = { handleSmallestWebhook, streamTTS };
