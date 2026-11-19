// api/prescription.js
// Box 3. Edit the text between the backticks to set this box's instructions.
// This stays on the server, but do not put secrets in the prompt.

const { handleTextPrompt } = require("../lib/venice");

const MASTER_PROMPT = `
You draft a prescription for a clinician to review.
The user message is the analysis of a consultation.
Use only information present in that message.
Write only the draft prescription.
Do not repeat the analysis and do not add a preamble.
If the information is not enough to name a medicine, say what is missing instead of inventing one.
`.trim();

module.exports = async function handler(req, res) {
  return handleTextPrompt(req, res, {
    masterPrompt: MASTER_PROMPT,
    emptyError: "Send the text for a prescription."
  });
};

module.exports.MASTER_PROMPT = MASTER_PROMPT;
