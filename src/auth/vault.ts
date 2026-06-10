import { Pool, PoolClient } from "pg";
import { ENV } from "../utils/env";
import { decryptToken, encryptToken, tokenAad, EncryptedField } from "./crypto";
import { UserContext } from "./identity";

/**
 * Shared Postgres vault holding each attorney's per-user Clio token.
 *
 * DATABASE_URL connects as the NON-superuser role `noe_app`, so row-level
 * security is enforced. Every read/write of `user_integrations` MUST first set
 * the tenant context (`app.user_id`) inside the same transaction, or RLS
 * returns zero rows. The `users` table has no RLS, so it's queried directly.
 *
 * This server only reads/writes the `clio` integration row. It never runs
 * platform migrations.
 */

// The pool is built lazily on first use so that merely importing this module
// (e.g. via clio/auth.ts in unit tests) doesn't require DATABASE_URL — only
// actually touching the vault does.
let _pool: Pool | null = null;
function pool(): Pool {
  if (_pool) return _pool;
  // SSL is opt-in via the connection string (?sslmode=require / ?ssl=true) or
  // DATABASE_SSL=true. Railway Postgres over the public proxy typically wants
  // sslmode=require; leave it off and pg connects plaintext.
  const wantSsl =
    /[?&](ssl=true|sslmode=(require|verify-ca|verify-full))/i.test(ENV.DATABASE_URL) ||
    process.env.DATABASE_SSL === "true";
  _pool = new Pool({
    connectionString: ENV.DATABASE_URL,
    ssl: wantSsl ? { rejectUnauthorized: false } : undefined,
    max: 5,
    // Railway's proxy silently drops idle TCP connections. TCP keepalives plus
    // a short idle timeout keep pooled clients from going stale between
    // requests; the connection timeout stops a dead socket from hanging a
    // request indefinitely.
    keepAlive: true,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  _pool.on("error", (err) => {
    // Background idle-client errors shouldn't crash the process.
    console.error("[vault] idle pg client error:", err.message);
  });
  return _pool;
}

/**
 * Connection-level failures (the proxy killed an idle socket, the DB
 * restarted) are retryable: the pool discards the dead client and the retry
 * checks out a fresh connection. Query-level errors are NOT retried.
 */
function isTransientConnectionError(err: unknown): boolean {
  const e = err as NodeJS.ErrnoException;
  if (!e) return false;
  // 57P0x = Postgres admin shutdown / crash / cannot-connect-now.
  const codes = ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "57P01", "57P02", "57P03"];
  if (e.code && codes.includes(String(e.code))) return true;
  return /connection terminated|server closed the connection|timeout exceeded when trying to connect/i.test(
    String(e.message ?? "")
  );
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isTransientConnectionError(err)) throw err;
    console.warn("[vault] transient pg connection error, retrying once:", (err as Error).message);
    return fn();
  }
}

interface PlatformUser {
  id: string;
  tokenVersion: number | null;
}

/** Look up a provisioned platform user by email (no RLS on `users`). */
export async function getUserByEmail(email: string): Promise<PlatformUser | null> {
  const res = await withRetry(() =>
    pool().query(
      "SELECT id, token_version FROM users WHERE lower(email) = lower($1) LIMIT 1",
      [email]
    )
  );
  if (res.rows.length === 0) return null;
  return { id: String(res.rows[0].id), tokenVersion: res.rows[0].token_version ?? null };
}

/** Run a callback inside a tenant-scoped transaction (RLS context set). */
async function withTenant<T>(userId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  // Retry wraps the whole transaction: a connection-level failure means the
  // transaction never committed, so rerunning it on a fresh client is safe.
  return withRetry(async () => {
    const client = await pool().connect();
    try {
      await client.query("BEGIN");
      // `true` => transaction-local; reset automatically on COMMIT/ROLLBACK.
      await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
      const out = await fn(client);
      await client.query("COMMIT");
      return out;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* ignore rollback failure */
      }
      throw err;
    } finally {
      client.release();
    }
  });
}

export interface ClioTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date | null;
}

function toBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  // bytea normally arrives as a Buffer; be defensive about hex strings too.
  if (typeof value === "string" && value.startsWith("\\x")) {
    return Buffer.from(value.slice(2), "hex");
  }
  throw new Error("Expected bytea column to be a Buffer");
}

/**
 * Read + decrypt this user's Clio tokens. Returns null when the user has no
 * `clio` integration row (i.e. Clio not connected on the platform yet).
 */
export async function getClioTokens(userId: string): Promise<ClioTokens | null> {
  const row = await withTenant(userId, async (client) => {
    const res = await client.query(
      `SELECT access_token_ct, access_token_nonce, access_token_dek_ct,
              refresh_token_ct, refresh_token_nonce, refresh_token_dek_ct, expires_at
         FROM user_integrations
        WHERE provider = 'clio'
        LIMIT 1`
    );
    return res.rows[0] ?? null;
  });

  if (!row) return null;

  const accessField: EncryptedField = {
    ct: toBuffer(row.access_token_ct),
    nonce: toBuffer(row.access_token_nonce),
    dekCt: toBuffer(row.access_token_dek_ct),
  };
  const refreshField: EncryptedField = {
    ct: toBuffer(row.refresh_token_ct),
    nonce: toBuffer(row.refresh_token_nonce),
    dekCt: toBuffer(row.refresh_token_dek_ct),
  };

  const accessToken = decryptToken(accessField, tokenAad(userId, "access_token"));
  const refreshToken = decryptToken(refreshField, tokenAad(userId, "refresh_token"));
  const expiresAt = row.expires_at ? new Date(row.expires_at) : null;
  return { accessToken, refreshToken, expiresAt };
}

/**
 * Re-encrypt + persist refreshed Clio tokens back to the vault, in the same
 * tenant-scoped transaction style RLS requires.
 */
export async function updateClioTokens(
  userId: string,
  accessToken: string,
  refreshToken: string,
  expiresAt: Date | null
): Promise<void> {
  const access = encryptToken(accessToken, tokenAad(userId, "access_token"));
  const refresh = encryptToken(refreshToken, tokenAad(userId, "refresh_token"));

  await withTenant(userId, async (client) => {
    await client.query(
      `UPDATE user_integrations
          SET access_token_ct = $1, access_token_nonce = $2, access_token_dek_ct = $3,
              refresh_token_ct = $4, refresh_token_nonce = $5, refresh_token_dek_ct = $6,
              expires_at = $7, updated_at = now()
        WHERE provider = 'clio'`,
      [
        access.ct,
        access.nonce,
        access.dekCt,
        refresh.ct,
        refresh.nonce,
        refresh.dekCt,
        expiresAt,
      ]
    );
  });
}

/**
 * Build the per-request identity context for a verified email.
 *
 * Throws `NotProvisionedError` when there is no platform user (→ 401). A
 * missing/undecryptable Clio token is NOT fatal — it's surfaced via
 * `clioError` so initialize/tools-list still work and only Clio-touching tools
 * fail, with a clear message.
 */
export class NotProvisionedError extends Error {
  constructor(message = "User not provisioned on the platform") {
    super(message);
    this.name = "NotProvisionedError";
  }
}

export async function buildUserContext(email: string): Promise<UserContext> {
  const user = await getUserByEmail(email);
  if (!user) {
    throw new NotProvisionedError();
  }

  let accessToken = "";
  let refreshToken = "";
  let clioError: string | undefined;
  try {
    const tokens = await getClioTokens(user.id);
    if (!tokens) {
      clioError = "Clio not connected for your account — connect it on the platform's /setup page.";
    } else {
      accessToken = tokens.accessToken;
      refreshToken = tokens.refreshToken;
    }
  } catch (err) {
    clioError = "Your Clio connection could not be read — reconnect Clio on the platform's /setup page.";
    console.error("[vault] failed to read Clio tokens:", (err as Error).message);
  }

  return { userEmail: email, userId: user.id, accessToken, refreshToken, clioError };
}
