// api/retrieve-consultation.js
// Always reads public.consultations.stuff for the row whose id is 1.
// This route does not insert or update anything.

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const { parse } = require("pg-connection-string");

let pool;
let poolFactory = defaultPoolFactory;

// Supabase signs database certificates with its own root, which Node does
// not ship. Verifying without this CA aborts the handshake.
// Fingerprint (SHA-256):
// 80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA
function certificateAuthority() {
  const configured = process.env.DATABASE_CA_CERT;

  if (
    typeof configured === "string" &&
    configured.includes("BEGIN CERTIFICATE")
  ) {
    return configured.replace(/\\n/g, "\n");
  }

  return fs.readFileSync(
    path.join(__dirname, "prod-ca-2021.crt"),
    "utf8"
  );
}

// Drop SSL query parameters before parsing. pg-connection-string treats
// sslmode=require as verify-full and would warn even though this pool
// does not use the parsed ssl object.
function withoutSslParams(connectionString) {
  const queryIndex = connectionString.indexOf("?");

  if (queryIndex === -1) {
    return connectionString;
  }

  const params = new URLSearchParams(
    connectionString.slice(queryIndex + 1)
  );

  for (const name of [
    "sslmode",
    "sslcert",
    "sslkey",
    "sslrootcert",
    "ssl"
  ]) {
    params.delete(name);
  }

  const rest = params.toString();

  return rest
    ? `${connectionString.slice(0, queryIndex)}?${rest}`
    : connectionString.slice(0, queryIndex);
}

function poolConfig() {
  let parsed;

  try {
    parsed = parse(withoutSslParams(process.env.DATABASE_URL));
  } catch (error) {
    const invalid = new Error("Invalid database URL");
    invalid.code = "INVALID_DATABASE_URL";
    throw invalid;
  }

  if (!parsed.host || !parsed.user || !parsed.database) {
    const invalid = new Error("Invalid database URL");
    invalid.code = "INVALID_DATABASE_URL";
    throw invalid;
  }

  // Pass fields separately. pg replaces an ssl object when the connection
  // string contains sslmode, and it treats sslmode=require as verify-full.
  const config = {
    user: parsed.user,
    password: parsed.password,
    host: parsed.host,
    database: parsed.database,
    ssl: {
      rejectUnauthorized: true,
      ca: certificateAuthority()
    },
    max: 1,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 10000,
    allowExitOnIdle: true
  };

  if (parsed.port) {
    config.port = Number(parsed.port);
  }

  return config;
}

function defaultPoolFactory() {
  const next = new Pool(poolConfig());

  // A dropped idle connection emits 'error'. Without a listener, Node
  // crashes the function instead of returning the retrieve error.
  next.on("error", (error) => {
    console.error(
      "Consultation database pool error:",
      error.code || "UNKNOWN"
    );
  });

  return next;
}

function getPool() {
  if (!pool) {
    pool = poolFactory();
  }

  return pool;
}

async function resetPool() {
  const current = pool;
  pool = null;

  if (current && typeof current.end === "function") {
    await current.end().catch(() => {});
  }
}

function isStaleConnection(error) {
  const code = error && error.code;

  if (
    code === "ECONNRESET" ||
    code === "EPIPE" ||
    code === "57P01" ||
    code === "57P02" ||
    code === "57P03" ||
    code === "08003" ||
    code === "08006"
  ) {
    return true;
  }

  const message =
    typeof error?.message === "string" ? error.message : "";

  return /Connection terminated|server closed the connection unexpectedly|Client has encountered a connection error/i.test(
    message
  );
}

// A simple query, not a prepared statement. The Supabase transaction
// pooler (port 6543), which Vercel needs, does not support prepared
// statements. The id is fixed, so nothing from the request is interpolated.
function selectSql() {
  return (
    "select stuff\n" +
    "from public.consultations\n" +
    "where id = 1"
  );
}

function retrieveErrorMessage(error) {
  const code = error?.code || error?.cause?.code || "";
  const message =
    typeof error?.message === "string" ? error.message : "";

  if (code === "INVALID_DATABASE_URL" || code === "ERR_INVALID_URL") {
    return "The database connection string is invalid. Percent-encode reserved characters in the password.";
  }

  if (
    code === "SELF_SIGNED_CERT_IN_CHAIN" ||
    code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
    code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
    code === "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" ||
    code === "CERT_HAS_EXPIRED" ||
    code === "ERR_TLS_CERT_ALTNAME_INVALID"
  ) {
    return "The database certificate could not be verified.";
  }

  if (
    code === "ENOTFOUND" ||
    code === "ENETUNREACH" ||
    code === "EHOSTUNREACH" ||
    code === "ECONNREFUSED" ||
    code === "EAI_AGAIN" ||
    code === "ETIMEDOUT" ||
    code === "CONNECT_TIMEOUT"
  ) {
    return "The database host could not be reached. On Vercel, set DATABASE_URL to the Supabase transaction pooler string (port 6543). The direct host is IPv6-only.";
  }

  if (
    code === "28P01" ||
    code === "28000" ||
    /password authentication failed/i.test(message)
  ) {
    return "The database rejected the login. Check the password in DATABASE_URL.";
  }

  if (/Tenant or user not found/i.test(message)) {
    return "The database pooler could not match this connection string to a project. Use the transaction pooler URI from the Supabase Connect dialog.";
  }

  if (code === "42P01") {
    return "The consultations table does not exist.";
  }

  if (code === "42703") {
    return "The consultations table is missing id or stuff.";
  }

  if (code === "22P02" || code === "42804") {
    return "The consultation could not be read. id must be a number and stuff must be text.";
  }

  if (code === "42501") {
    return "The database user is not allowed to read consultations.";
  }

  if (code === "26000" || code === "42P05") {
    return "The database pooler rejected the query.";
  }

  return "Could not retrieve the consultation. Please try again.";
}

async function readConsultation() {
  const sql = selectSql();

  try {
    return await getPool().query(sql);
  } catch (error) {
    if (!isStaleConnection(error)) {
      throw error;
    }

    console.error(
      "Consultation database connection dropped:",
      error.code || "UNKNOWN"
    );

    await resetPool();
    return getPool().query(sql);
  }
}

async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");

    return res.status(405).json({
      error: "Only GET requests are allowed."
    });
  }

  if (!process.env.DATABASE_URL) {
    return res.status(500).json({
      error: "The database connection is not configured."
    });
  }

  try {
    const result = await readConsultation();
    const row = result.rows && result.rows[0];

    if (!row) {
      return res.status(404).json({
        error:
          "The consultation row with id = 1 does not exist. Create that row in Supabase first."
      });
    }

    return res.status(200).json({
      text: row.stuff == null ? "" : String(row.stuff)
    });
  } catch (error) {
    // Do not log credentials or consultation content.
    console.error(
      "Consultation retrieve failed:",
      error.code || "UNKNOWN"
    );

    return res.status(500).json({
      error: retrieveErrorMessage(error)
    });
  }
}

function setPoolFactoryForTests(factory) {
  pool = null;
  poolFactory = factory;
}

function useDefaultPoolFactoryForTests() {
  pool = null;
  poolFactory = defaultPoolFactory;
}

module.exports = handler;
module.exports.poolConfig = poolConfig;
module.exports.selectSql = selectSql;
module.exports.retrieveErrorMessage = retrieveErrorMessage;
module.exports.setPoolFactoryForTests = setPoolFactoryForTests;
module.exports.useDefaultPoolFactoryForTests =
  useDefaultPoolFactoryForTests;
