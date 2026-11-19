const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const { afterEach, describe, test } = require("node:test");

const handler = require("../api/retrieve-consultation");

const SUPABASE_CA_SHA256 =
  "807025ad50d4ed219d2c9c7d299c004f824eb00cf7f65afef607d07b72e6cafa";

const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const ORIGINAL_CA = process.env.DATABASE_CA_CERT;

function restoreEnv() {
  if (ORIGINAL_DATABASE_URL === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  }

  if (ORIGINAL_CA === undefined) {
    delete process.env.DATABASE_CA_CERT;
  } else {
    process.env.DATABASE_CA_CERT = ORIGINAL_CA;
  }

  handler.useDefaultPoolFactoryForTests();
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

function request(method = "GET") {
  return handler(
    {
      method
    },
    mockRes()
  ).then((res) => res);
}

afterEach(restoreEnv);

describe("consultation retrieve", { concurrency: 1 }, () => {
  test("bundles the Supabase root and keeps it when sslmode would replace ssl", () => {
    delete process.env.DATABASE_CA_CERT;
    process.env.DATABASE_URL =
      "postgresql://postgres.abc:secret@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres?sslmode=require";

    const config = handler.poolConfig();
    const der = Buffer.from(
      config.ssl.ca
        .replace(/-----BEGIN CERTIFICATE-----/, "")
        .replace(/-----END CERTIFICATE-----/, "")
        .replace(/\s/g, ""),
      "base64"
    );

    assert.equal(config.ssl.rejectUnauthorized, true);
    assert.equal(
      crypto.createHash("sha256").update(der).digest("hex"),
      SUPABASE_CA_SHA256
    );
    assert.equal(config.host, "aws-1-ap-southeast-1.pooler.supabase.com");
    assert.equal(config.port, 6543);
    assert.equal(config.user, "postgres.abc");
    assert.equal(config.password, "secret");
    assert.equal(config.database, "postgres");
    assert.equal(config.max, 1);
    assert.equal("connectionString" in config, false);

    const bundled = fs.readFileSync(
      require.resolve("../api/prod-ca-2021.crt"),
      "utf8"
    );
    const bundledDer = Buffer.from(
      bundled
        .replace(/-----BEGIN CERTIFICATE-----/, "")
        .replace(/-----END CERTIFICATE-----/, "")
        .replace(/\s/g, ""),
      "base64"
    );
    assert.equal(
      crypto.createHash("sha256").update(bundledDer).digest("hex"),
      SUPABASE_CA_SHA256
    );
  });

  test("uses DATABASE_CA_CERT when it is a PEM certificate", () => {
    process.env.DATABASE_CA_CERT =
      "-----BEGIN CERTIFICATE-----\\nTUlJ\\n-----END CERTIFICATE-----";
    process.env.DATABASE_URL =
      "postgres://postgres:secret@db.example.supabase.co:5432/postgres";

    const config = handler.poolConfig();

    assert.equal(
      config.ssl.ca,
      "-----BEGIN CERTIFICATE-----\nTUlJ\n-----END CERTIFICATE-----"
    );
    assert.equal(config.ssl.rejectUnauthorized, true);
  });

  test("reads stuff from row 1 and does not write", () => {
    const sql = handler.selectSql();

    assert.match(sql, /select stuff/);
    assert.match(sql, /from public\.consultations/);
    assert.match(sql, /where id = 1/);
    assert.equal(sql.includes("$1"), false);
    assert.equal(/\b(update|insert|delete|set)\b/i.test(sql), false);
  });

  test("rejects anything other than a retrieve", async () => {
    process.env.DATABASE_URL =
      "postgresql://postgres:secret@127.0.0.1:5432/postgres";

    const method = await request("POST");
    assert.equal(method.statusCode, 405);
    assert.equal(method.headers.Allow, "GET");

    delete process.env.DATABASE_URL;
    const missing = await request("GET");
    assert.equal(missing.statusCode, 500);
    assert.match(missing.body.error, /not configured/);
  });

  test("returns the stuff text from row 1 and retries a dropped connection once", async () => {
    process.env.DATABASE_URL =
      "postgresql://postgres:secret@127.0.0.1:5432/postgres";

    const queries = [];
    let connections = 0;

    handler.setPoolFactoryForTests(() => {
      connections += 1;
      let failed = connections === 1;

      return {
        async query(sql) {
          queries.push(sql);

          if (failed) {
            failed = false;
            const error = new Error(
              "Connection terminated unexpectedly"
            );
            error.code = "ECONNRESET";
            throw error;
          }

          return {
            rowCount: 1,
            rows: [{ stuff: "hello 'there'\nnext" }]
          };
        },
        async end() {}
      };
    });

    const loaded = await request("GET");

    assert.equal(loaded.statusCode, 200);
    assert.equal(loaded.body.text, "hello 'there'\nnext");
    assert.equal(connections, 2);
    assert.match(queries[0], /select stuff/);
    assert.match(queries[0], /where id = 1/);
    assert.match(queries[1], /where id = 1/);
    assert.equal(queries[0].includes("$1"), false);
    assert.equal(/\bupdate\b/i.test(queries[0]), false);
  });

  test("returns an empty string when stuff is null", async () => {
    process.env.DATABASE_URL =
      "postgresql://postgres:secret@127.0.0.1:5432/postgres";

    handler.setPoolFactoryForTests(() => ({
      async query() {
        return { rowCount: 1, rows: [{ stuff: null }] };
      },
      async end() {}
    }));

    const loaded = await request("GET");
    assert.equal(loaded.statusCode, 200);
    assert.equal(loaded.body.text, "");
  });

  test("keeps the missing-row response and names database failures", async () => {
    process.env.DATABASE_URL =
      "postgresql://postgres:secret@127.0.0.1:5432/postgres";

    handler.setPoolFactoryForTests(() => ({
      async query() {
        return { rowCount: 0, rows: [] };
      },
      async end() {}
    }));

    const missing = await request("GET");
    assert.equal(missing.statusCode, 404);
    assert.match(missing.body.error, /id = 1/);

    handler.setPoolFactoryForTests(() => ({
      async query() {
        const error = new Error("column does not exist");
        error.code = "42703";
        throw error;
      },
      async end() {}
    }));

    const column = await request("GET");
    assert.equal(column.statusCode, 500);
    assert.match(column.body.error, /missing id or stuff/);

    handler.useDefaultPoolFactoryForTests();
    process.env.DATABASE_URL = "postgresql://not a url";
    const invalid = await request("GET");
    assert.equal(invalid.statusCode, 500);
    assert.match(invalid.body.error, /Percent-encode/);
  });
});
