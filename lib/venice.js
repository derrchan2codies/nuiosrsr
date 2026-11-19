"use strict";

const MODEL = "deepseek-v4-1-flash-1017-uncensored";
const VENICE_URL = "https://api.venice.ai/api/v1/chat/completions";

// Shared Venice call used by the chat, analysis, and prescription routes.
// Each route supplies its own system prompt.
async function completeChat({ systemPrompt, messages }) {
  const apiKey = process.env.VENICE_API_KEY;

  if (!apiKey) {
    return {
      status: 500,
      body: {
        error: "VENICE_API_KEY is not configured in Vercel."
      }
    };
  }

  try {
    const response = await fetch(VENICE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          {
            role: "system",
            content: systemPrompt
          },
          ...messages.map(({ role, content }) => ({
            role,
            content
          }))
        ],
        stream: false
      }),
      signal: AbortSignal.timeout(25000)
    });

    if (!response.ok) {
      const errorMessages = {
        400: "Venice rejected the request. Check the model ID and request settings.",
        401: "Venice rejected the API key. Check VENICE_API_KEY.",
        402: "Check your Venice account balance or billing.",
        403: "Your Venice account or API key cannot access this request.",
        404: "Venice could not find the requested model or endpoint.",
        429: "Venice is rate-limiting requests. Please try again shortly."
      };

      return {
        status: 502,
        body: {
          error:
            errorMessages[response.status] ||
            `Venice request failed (${response.status}).`
        }
      };
    }

    const data = await response.json();
    const reply = data?.choices?.[0]?.message?.content;

    if (typeof reply !== "string" || !reply.trim()) {
      return {
        status: 502,
        body: {
          error: "Venice returned an empty or invalid reply."
        }
      };
    }

    return {
      status: 200,
      body: { reply }
    };
  } catch (error) {
    const timedOut =
      error.name === "TimeoutError" ||
      error.name === "AbortError";

    return {
      status: timedOut ? 504 : 502,
      body: {
        error: timedOut
          ? "Venice took too long to respond. Please try again."
          : "Unable to connect to Venice. Please try again."
      }
    };
  }
}

// POST { text } → Venice, using the master prompt that belongs to this route.
async function handleTextPrompt(req, res, { masterPrompt, emptyError }) {
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

  const text = body?.text;

  if (typeof text !== "string" || !text.trim()) {
    return res.status(400).json({
      error: emptyError
    });
  }

  if (text.length > 100000) {
    return res.status(413).json({
      error: "The text is too long."
    });
  }

  const result = await completeChat({
    systemPrompt: masterPrompt,
    messages: [
      {
        role: "user",
        content: text
      }
    ]
  });

  return res.status(result.status).json(result.body);
}

module.exports = {
  MODEL,
  completeChat,
  handleTextPrompt
};
