// api/chat.js

const { completeChat } = require("../lib/venice");

// Edit the text between the backticks to set the chatbot's instructions.
// This stays on the server, but do not put secrets in the prompt.
const MASTER_PROMPT = `
You are a helpful conversational assistant.
Answer clearly, accurately, and directly.
If you are unsure, say so instead of making up information.
`.trim();

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({
      error: "Only POST requests are allowed."
    });
  }

  if (!process.env.VENICE_API_KEY) {
    return res.status(500).json({
      error: "VENICE_API_KEY is not configured in Vercel."
    });
  }

  let body;

  try {
    body =
      typeof req.body === "string"
        ? JSON.parse(req.body)
        : req.body;
  } catch {
    return res.status(400).json({
      error: "Invalid JSON request."
    });
  }

  const messages = body?.messages;

  // Only accept user and assistant messages from the browser.
  // The master prompt is added separately on the server.
  if (
    !Array.isArray(messages) ||
    messages.length === 0 ||
    messages.length > 100 ||
    !messages.every(
      (message) =>
        message &&
        ["user", "assistant"].includes(message.role) &&
        typeof message.content === "string" &&
        message.content.trim().length > 0
    )
  ) {
    return res.status(400).json({
      error: "Send between 1 and 100 valid chat messages."
    });
  }

  if (JSON.stringify(messages).length > 100000) {
    return res.status(413).json({
      error: "Conversation is too long. Refresh to start a new chat."
    });
  }

  const result = await completeChat({
    systemPrompt: MASTER_PROMPT,
    messages
  });

  return res.status(result.status).json(result.body);
};

module.exports.MASTER_PROMPT = MASTER_PROMPT;
