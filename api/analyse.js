// api/analyse.js
// Box 2. Edit the text between the backticks to set this box's instructions.
// This stays on the server, but do not put secrets in the prompt.

const { handleTextPrompt } = require("../lib/venice");

const MASTER_PROMPT = `
You analyse the consultation in the user message.
Write only the analysis.
Do not repeat the consultation and do not add a preamble.
If you are unsure, say so instead of inventing facts.
`.trim();

module.exports = async function handler(req, res) {
  return handleTextPrompt(req, res, {
    masterPrompt: MASTER_PROMPT,
    emptyError: "Send the text to analyse."
  });
};

module.exports.MASTER_PROMPT = MASTER_PROMPT;
