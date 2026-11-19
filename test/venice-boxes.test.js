const assert = require("node:assert/strict");
const fs = require("fs");
const { afterEach, describe, test } = require("node:test");

const { MODEL } = require("../lib/venice");
const chat = require("../api/chat");
const analyse = require("../api/analyse");
const prescription = require("../api/prescription");

const ORIGINAL_KEY = process.env.VENICE_API_KEY;
const ORIGINAL_FETCH = global.fetch;

function restoreEnv() {
  if (ORIGINAL_KEY === undefined) {
    delete process.env.VENICE_API_KEY;
  } else {
    process.env.VENICE_API_KEY = ORIGINAL_KEY;
  }

  global.fetch = ORIGINAL_FETCH;
}

function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    }
  };
}

function request(handler, body, method = "POST") {
  return handler(
    {
      method,
      body
    },
    mockRes()
  ).then((res) => res);
}

function mockVenice(reply, status = 200) {
  const calls = [];

  global.fetch = async (url, options) => {
    calls.push({
      url,
      options,
      body: JSON.parse(options.body)
    });

    return {
      ok: status >= 200 && status < 300,
      status,
      async json() {
        return {
          choices: [{ message: { content: reply } }]
        };
      }
    };
  };

  return calls;
}

afterEach(restoreEnv);

describe("venice box prompts", () => {
  test("the page loads row 1 and replaces each box with only its answer", () => {
    const html = fs.readFileSync(
      require.resolve("../index.html"),
      "utf8"
    );

    assert.equal(html.includes("save-consultation"), false);
    assert.match(html, /fetch\('\/api\/retrieve-consultation'/);
    assert.match(html, /'\/api\/analyse'/);
    assert.match(html, /'\/api\/prescription'/);
    assert.match(html, /const text = box1\.textContent;/);
    assert.match(html, /const text = box2\.textContent;/);
    assert.match(html, /box\.textContent = data\.reply;/);
    assert.match(html, /retrieveConsultation\(\);/);
    assert.equal(/<button[^>]*\sdisabled\b/.test(html), false);
  });

  test("box 2 and box 3 keep different master prompts", () => {
    assert.notEqual(analyse.MASTER_PROMPT, prescription.MASTER_PROMPT);
    assert.notEqual(analyse.MASTER_PROMPT, chat.MASTER_PROMPT);
    assert.match(analyse.MASTER_PROMPT, /analysis/i);
    assert.match(prescription.MASTER_PROMPT, /prescription/i);
  });

  test("analysis sends box text with its own prompt and returns only the reply", async () => {
    process.env.VENICE_API_KEY = "test-key";
    const calls = mockVenice("only the analysis");

    const result = await request(analyse, {
      text: "consultation notes"
    });

    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.body, { reply: "only the analysis" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.venice.ai/api/v1/chat/completions");
    assert.equal(calls[0].options.headers.Authorization, "Bearer test-key");
    assert.equal(calls[0].body.model, MODEL);
    assert.equal(calls[0].body.stream, false);
    assert.deepEqual(calls[0].body.messages, [
      { role: "system", content: analyse.MASTER_PROMPT },
      { role: "user", content: "consultation notes" }
    ]);
  });

  test("prescription sends box text with its own prompt", async () => {
    process.env.VENICE_API_KEY = "test-key";
    const calls = mockVenice("only the prescription");

    const result = await request(prescription, {
      text: "the analysis"
    });

    assert.equal(result.statusCode, 200);
    assert.equal(result.body.reply, "only the prescription");
    assert.deepEqual(calls[0].body.messages, [
      { role: "system", content: prescription.MASTER_PROMPT },
      { role: "user", content: "the analysis" }
    ]);
  });

  test("chat still adds its own master prompt", async () => {
    process.env.VENICE_API_KEY = "test-key";
    const calls = mockVenice("hello back");

    const result = await request(chat, {
      messages: [{ role: "user", content: "hello" }]
    });

    assert.equal(result.statusCode, 200);
    assert.equal(result.body.reply, "hello back");
    assert.equal(calls[0].body.messages[0].content, chat.MASTER_PROMPT);
    assert.deepEqual(calls[0].body.messages[1], {
      role: "user",
      content: "hello"
    });
  });

  test("rejects a missing key, a bad method, and empty text", async () => {
    delete process.env.VENICE_API_KEY;
    const missingKey = await request(analyse, { text: "notes" });
    assert.equal(missingKey.statusCode, 500);
    assert.match(missingKey.body.error, /VENICE_API_KEY/);

    process.env.VENICE_API_KEY = "test-key";
    const method = await request(prescription, { text: "notes" }, "GET");
    assert.equal(method.statusCode, 405);

    const empty = await request(analyse, { text: "   " });
    assert.equal(empty.statusCode, 400);
    assert.match(empty.body.error, /analyse/);

    const invalid = await request(prescription, "{");
    assert.equal(invalid.statusCode, 400);
    assert.match(invalid.body.error, /Invalid JSON/);
  });

  test("maps a rejected Venice key and a timeout", async () => {
    process.env.VENICE_API_KEY = "test-key";
    mockVenice("", 401);

    const rejected = await request(analyse, { text: "notes" });
    assert.equal(rejected.statusCode, 502);
    assert.match(rejected.body.error, /VENICE_API_KEY/);

    global.fetch = async () => {
      const error = new Error("timed out");
      error.name = "TimeoutError";
      throw error;
    };

    const timedOut = await request(prescription, { text: "notes" });
    assert.equal(timedOut.statusCode, 504);
    assert.match(timedOut.body.error, /too long/);
  });
});
