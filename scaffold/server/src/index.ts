import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { createServer } from "node:http";
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
  createVerify,
} from "node:crypto";
import { MongoClient } from "mongodb";
import { Redis } from "ioredis";
import { config } from "./config.js";

declare global {
  namespace Express {
    interface Request {
      rawBody?: Buffer;
      user: {
        sub: string;
        name?: string;
        email?: string;
        workspaces: { id: string; role: string }[];
      };
      requestStartedAt?: number;
    }
  }
}

const app = express();
app.disable("x-powered-by");
const httpServer = createServer(app);
const mongo = new MongoClient(config.mongoUrl, { maxPoolSize: 30 });
await mongo.connect();
const db = mongo.db();
const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 2 });
const pub = new Redis(config.redisUrl);
const sub = new Redis(config.redisUrl);
const collections = {
  events: db.collection("events"),
  messages: db.collection("messages"),
  conversations: db.collection("conversations"),
  jobs: db.collection("jobs"),
  sessions: db.collection("sessions"),
  oauth: db.collection("oauth_states"),
  stream: db.collection("stream"),
  counters: db.collection("counters"),
  notes: db.collection("notes"),
};
const workspaces: Record<string, string> = {
  ws_acme: config.pigeon.apiKeys.ws_acme,
  ws_globex: config.pigeon.apiKeys.ws_globex,
};
const now = () => new Date();
const json = express.json({
  limit: "1mb",
  verify: (req, _res, buf) => {
    req.rawBody = Buffer.from(buf);
  },
});
app.use((req, _res, next) => {
  req.requestStartedAt = Date.now();
  next();
});
app.get("/healthz", async (_req, res) => {
  try {
    await db.command({ ping: 1 });
    await redis.ping();
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});

async function ensureIndexes() {
  await Promise.all([
    collections.events.createIndex({ eventId: 1 }, { unique: true }),
    collections.messages.createIndex(
      { workspace: 1, clientRef: 1 },
      {
        unique: true,
        partialFilterExpression: { clientRef: { $exists: true } },
      },
    ),
    collections.messages.createIndex(
      { workspace: 1, messageId: 1 },
      {
        unique: true,
        partialFilterExpression: { messageId: { $exists: true } },
      },
    ),
    collections.messages.createIndex({
      workspace: 1,
      contact: 1,
      createdAt: 1,
    }),
    collections.conversations.createIndex(
      { workspace: 1, contact: 1 },
      { unique: true },
    ),
    collections.jobs.createIndex({ state: 1, nextAt: 1, createdAt: 1 }),
    collections.jobs.createIndex(
      { workspace: 1, clientRef: 1 },
      { unique: true },
    ),
    collections.sessions.createIndex(
      { expiresAt: 1 },
      { expireAfterSeconds: 0 },
    ),
    collections.oauth.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    collections.stream.createIndex({ workspace: 1, seq: 1 }, { unique: true }),
  ]);
}
await ensureIndexes();

function safeEqual(a: string, b: string) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
function validSignature(
  header: string | undefined,
  raw: Buffer | undefined,
  secret: string,
) {
  if (typeof header !== "string" || !raw) return false;
  const m = /^t=(\d+),v1=([a-f0-9]{64})$/i.exec(header);
  if (!m) return false;
  const timestamp = Number(m[1]);
  if (
    !Number.isFinite(timestamp) ||
    Math.abs(Date.now() / 1000 - timestamp) > 300
  )
    return false;
  const expected = createHmac("sha256", secret)
    .update(`${m[1]}.`)
    .update(raw)
    .digest("hex");
  return safeEqual(expected, m[2].toLowerCase());
}
async function publishChange(
  workspace: string,
  type: string,
  fields: Record<string, any>,
) {
  const lockKey = `streamlock:${workspace}`;
  const token = randomBytes(12).toString("hex");
  while (!(await redis.set(lockKey, token, "PX", 15000, "NX"))) await sleep(10);
  try {
    const counter = await collections.counters.findOneAndUpdate(
      { _id: `seq:${workspace}` },
      { $inc: { value: 1 } },
      { upsert: true, returnDocument: "after" },
    );
    const seq = Number(counter?.value ?? 0);
    const event = { workspace, seq, type, ...fields, at: now() };
    await collections.stream.insertOne(event);
    await pub.publish(`switchboard:${workspace}`, JSON.stringify(event));
    return event;
  } finally {
    await redis.eval(
      "if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end",
      1,
      lockKey,
      token,
    );
  }
}
async function ensureConversation(workspace: string, contact: string) {
  await collections.conversations
    .updateOne(
      { workspace, contact },
      {
        $setOnInsert: {
          workspace,
          contact,
          assignee: null,
          closed: false,
          createdAt: now(),
          updatedAt: now(),
        },
      },
      { upsert: true },
    )
    .catch((e) => {
      if (e.code !== 11000) throw e;
    });
}
async function storeInbound(event: any) {
  const { workspace, data } = event;
  if (!workspaces[workspace] || !data?.message_id || !data?.from) return;
  const result = await collections.messages.updateOne(
    { workspace, messageId: data.message_id },
    {
      $setOnInsert: {
        workspace,
        contact: data.from,
        messageId: data.message_id,
        direction: "inbound",
        text: data.text || "",
        occurredAt: new Date(event.occurred_at),
        sortAt: new Date(event.occurred_at),
        createdAt: now(),
        status: "received",
      },
    },
    { upsert: true },
  );
  await ensureConversation(workspace, data.from);
  await collections.conversations.updateOne(
    { workspace, contact: data.from },
    {
      $max: { lastActivityAt: new Date(event.occurred_at) },
      $set: { updatedAt: now() },
    },
  );
  await collections.events
    .insertOne({
      eventId: event.id,
      workspace,
      type: event.type,
      receivedAt: now(),
    })
    .catch((e) => {
      if (e.code !== 11000) throw e;
    });
  if (result.upsertedCount)
    await publishChange(workspace, "message.inbound", {
      contact: data.from,
      message_id: data.message_id,
      text: data.text || "",
    });
}
async function updateStatus(event: any) {
  const { workspace, data } = event;
  if (!workspaces[workspace] || !data?.client_ref) return;
  const msg = await collections.messages.findOne({
    workspace,
    clientRef: data.client_ref,
    direction: "outbound",
  });
  if (!msg) return;
  const rank: Record<string, number> = {
    queued: 0,
    sent: 1,
    delivered: 2,
    failed: 2,
  };
  if ((rank[data.status] ?? 0) <= (rank[msg.status] ?? 0)) return;
  await collections.messages.updateOne(
    { _id: msg._id },
    {
      $set: {
        status: data.status,
        providerMessageId: data.message_id || msg.providerMessageId,
        updatedAt: now(),
      },
    },
  );
  await collections.jobs.updateOne(
    { workspace, clientRef: data.client_ref },
    { $set: { providerStatus: data.status } },
  );
  await publishChange(workspace, "message.status", {
    contact: msg.contact,
    client_ref: data.client_ref,
    status: data.status,
  });
}
app.post(
  "/webhooks/pigeon",
  express.raw({ type: "*/*", limit: "1mb" }),
  async (req, res) => {
    const raw = req.body;
    if (
      !validSignature(
        String(req.headers["x-pigeon-signature"] || ""),
        raw,
        config.pigeon.webhookSecret,
      )
    )
      return res.status(401).end();
    let event;
    try {
      event = JSON.parse(raw.toString("utf8"));
    } catch {
      return res.status(400).end();
    }
    if (
      !event ||
      typeof event.id !== "string" ||
      typeof event.type !== "string"
    )
      return res.status(400).end();
    try {
      if (event.type === "message.inbound" && workspaces[event.workspace])
        await storeInbound(event);
      else if (event.type === "message.status" && workspaces[event.workspace]) {
        await updateStatus(event);
        await collections.events
          .insertOne({
            eventId: event.id,
            workspace: event.workspace,
            type: event.type,
            receivedAt: now(),
          })
          .catch((e) => {
            if (e.code !== 11000) throw e;
          });
      } else {
        await collections.events
          .insertOne({
            eventId: event.id,
            workspace: event.workspace || null,
            type: event.type,
            receivedAt: now(),
          })
          .catch((e) => {
            if (e.code !== 11000) throw e;
          });
      }
      return res.status(200).end();
    } catch (e: any) {
      if (e?.code === 11000) return res.status(200).end();
      console.error("pigeon webhook failed", e);
      return res.status(503).end();
    }
  },
);

// OAuth authorization-code flow with PKCE. The session cookie contains only a random opaque id.
function cookie(req: Request, name: string): string | null {
  const raw = req.headers.cookie || "";
  const prefix = `${name}=`;
  const entry = raw
    .split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith(prefix));
  if (!entry) return null;
  try {
    return decodeURIComponent(entry.slice(prefix.length));
  } catch {
    return null;
  }
}

// Give every authorization attempt its own cookie. A single fixed cookie name
// gets overwritten when a user opens two login tabs or starts a second login
// before the first callback returns.
function oauthCookieName(state: string) {
  return `sb_oauth_${state}`;
}

function setCookie(res: Response, name: string, value: string, maxAge: number) {
  const attributes = [
    `${name}=${encodeURIComponent(value)}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${maxAge}`,
  ];
  if (process.env.NODE_ENV === "production") attributes.push("Secure");
  res.append("Set-Cookie", attributes.join("; "));
}
async function discover() {
  const r = await fetch(
    `${config.oidc.issuer}/.well-known/openid-configuration`,
  );
  if (!r.ok) throw new Error("OIDC discovery failed");
  return r.json();
}
app.get("/auth/login", async (_req, res) => {
  try {
    const oidc = await discover();
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const state = randomBytes(24).toString("base64url");
    const nonce = randomBytes(24).toString("base64url");
    await collections.oauth.insertOne({
      _id: state,
      verifier,
      nonce,
      expiresAt: new Date(Date.now() + 5 * 60_000),
    });
    setCookie(res, oauthCookieName(state), state, 300);
    const u = new URL(oidc.authorization_endpoint);
    Object.entries({
      client_id: config.oidc.clientId,
      redirect_uri: config.oidc.redirectUri,
      response_type: "code",
      scope: "openid profile email",
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).forEach(([k, v]) => u.searchParams.set(k, v));
    res.redirect(u.toString());
  } catch (e: any) {
    console.error(e);
    res.status(502).send("Identity provider unavailable");
  }
});
async function verifyIdToken(token: string, nonce: string): Promise<any> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed ID token");
  const header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
  const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString());
  if (
    header.alg !== "RS256" ||
    claims.iss !== config.oidc.issuer ||
    claims.aud !== config.oidc.clientId ||
    claims.exp <= Date.now() / 1000 ||
    claims.nonce !== nonce
  )
    throw new Error("Invalid ID token claims");
  const oidc = await discover();
  const jwks = await (await fetch(oidc.jwks_uri)).json();
  const jwk = jwks.keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("Unknown signing key");
  const { createPublicKey } = await import("node:crypto");
  const key = createPublicKey({
    key: { kty: jwk.kty, n: jwk.n, e: jwk.e },
    format: "jwk",
  });
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${parts[0]}.${parts[1]}`);
  verifier.end();
  if (!verifier.verify(key, Buffer.from(parts[2], "base64url")))
    throw new Error("Invalid ID token signature");
  return claims;
}
app.get("/auth/callback", async (req, res) => {
  try {
    const state = typeof req.query.state === "string" ? req.query.state : "";
    // State is base64url generated by this server. Reject malformed values
    // before using them to construct a cookie name or query MongoDB.
    if (
      !/^[A-Za-z0-9_-]{32}$/.test(state) ||
      typeof req.query.code !== "string" ||
      !req.query.code
    ) {
      console.warn("OIDC callback rejected: missing or malformed state/code");
      return res.status(400).send("Invalid login state");
    }

    const saved = await collections.oauth.findOne({
      _id: state,
      expiresAt: { $gt: now() },
    });
    const stateCookie = cookie(req, oauthCookieName(state));
    // Accept the previous fixed cookie during a short transition, so an
    // authorization flow already in progress is not broken by this update.
    const legacyCookie = cookie(req, "sb_oauth");
    if (!saved || (stateCookie !== state && legacyCookie !== state)) {
      console.warn(
        "OIDC callback rejected: state record or matching browser cookie is missing",
      );
      return res.status(400).send("Invalid login state");
    }

    await collections.oauth.deleteOne({ _id: state });
    setCookie(res, oauthCookieName(state), "", 0);
    if (legacyCookie === state) setCookie(res, "sb_oauth", "", 0);
    const oidc = await discover();
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code: String(req.query.code),
      redirect_uri: config.oidc.redirectUri,
      client_id: config.oidc.clientId,
      client_secret: config.oidc.clientSecret,
      code_verifier: saved.verifier,
    });
    const tokenRes = await fetch(oidc.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form,
    });
    if (!tokenRes.ok) return res.status(401).send("Login failed");
    const tokens = await tokenRes.json();
    const claims = await verifyIdToken(tokens.id_token, saved.nonce);
    const sid = randomBytes(32).toString("base64url");
    await collections.sessions.insertOne({
      _id: sid,
      user: {
        sub: claims.sub,
        name: claims.name,
        email: claims.email,
        workspaces: claims.workspaces || [],
      },
      expiresAt: new Date(Date.now() + 7 * 86400_000),
    });
    setCookie(res, "sb_session", sid, 7 * 86400);
    res.redirect(config.webOrigin);
  } catch (e: any) {
    console.error("oauth callback", e);
    res.status(401).send("Login failed");
  }
});
async function getSession(req: Request): Promise<any> {
  const sid = cookie(req, "sb_session");
  return sid
    ? collections.sessions.findOne({ _id: sid, expiresAt: { $gt: now() } })
    : null;
}
async function requireUser(req: Request, res: Response, next: NextFunction) {
  const session = await getSession(req).catch(() => null);
  if (!session) return res.status(401).json({ error: "unauthorized" });
  req.user = session.user;
  next();
}
app.get("/api/me", requireUser, (req, res) =>
  res.json({ sub: req.user.sub, workspaces: req.user.workspaces }),
);
app.get("/api/conversations", requireUser, async (req, res) => {
  const workspace = String(req.query.workspace || "");
  if (!req.user.workspaces.some((w) => w.id === workspace))
    return res.status(403).json({ error: "forbidden" });
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30));
  const before = req.query.before ? new Date(String(req.query.before)) : null;
  const q = {
    workspace,
    ...(before ? { lastActivityAt: { $lt: before } } : {}),
  };
  const rows = await collections.conversations
    .find(q)
    .sort({ lastActivityAt: -1, createdAt: -1 })
    .limit(limit + 1)
    .toArray();
  const hasMore = rows.length > limit;
  const conversations = rows.slice(0, limit);
  res.json({
    data: conversations,
    next_before: hasMore
      ? conversations[conversations.length - 1]?.lastActivityAt || null
      : null,
  });
});
app.get(
  "/api/conversations/:contact/messages",
  requireUser,
  async (req, res) => {
    const workspace = String(req.query.workspace || "");
    if (!req.user.workspaces.some((w) => w.id === workspace))
      return res.status(403).json({ error: "forbidden" });
    const data = await collections.messages
      .find({ workspace, contact: req.params.contact })
      .sort({ sortAt: 1, createdAt: 1 })
      .toArray();
    res.json({ data });
  },
);
app.post(
  "/api/conversations/:contact/claim",
  json,
  requireUser,
  async (req, res) => {
    const workspace = String(req.body.workspace || "");
    if (!req.user.workspaces.some((w) => w.id === workspace))
      return res.status(403).json({ error: "forbidden" });
    const result = await claim(workspace, req.params.contact, req.user.sub);
    res
      .status(result ? 200 : 409)
      .json({ assignee: result ? req.user.sub : null });
  },
);
app.post(
  "/api/conversations/:contact/close",
  json,
  requireUser,
  async (req, res) => {
    const workspace = String(req.body.workspace || "");
    if (!req.user.workspaces.some((w) => w.id === workspace))
      return res.status(403).json({ error: "forbidden" });
    await ensureConversation(workspace, req.params.contact);
    await collections.conversations.updateOne(
      { workspace, contact: req.params.contact },
      { $set: { closed: true, updatedAt: now() } },
    );
    await publishChange(workspace, "conversation.closed", {
      contact: req.params.contact,
    });
    res.json({ ok: true });
  },
);
app.post(
  "/api/conversations/:contact/reopen",
  json,
  requireUser,
  async (req, res) => {
    const workspace = String(req.body.workspace || "");
    if (!req.user.workspaces.some((w) => w.id === workspace))
      return res.status(403).json({ error: "forbidden" });
    await ensureConversation(workspace, req.params.contact);
    await collections.conversations.updateOne(
      { workspace, contact: req.params.contact },
      { $set: { closed: false, updatedAt: now() } },
    );
    await publishChange(workspace, "conversation.reopened", {
      contact: req.params.contact,
    });
    res.json({ ok: true });
  },
);
async function claim(
  workspace: string,
  contact: string,
  agent: string,
): Promise<boolean> {
  await ensureConversation(workspace, contact);
  const r = await collections.conversations.updateOne(
    { workspace, contact, $or: [{ assignee: null }, { assignee: agent }] },
    { $set: { assignee: agent, updatedAt: now() } },
  );
  if (
    r.modifiedCount ||
    (await collections.conversations.findOne({
      workspace,
      contact,
      assignee: agent,
    }))
  ) {
    await publishChange(workspace, "conversation.assigned", {
      contact,
      assignee: agent,
    });
    return true;
  }
  return false;
}

// Durable outbox. Each worker claims a job with a Redis lease; provider idempotency makes
// retrying after an uncertain timeout safe.
async function enqueueReply({
  workspace,
  contact,
  text,
  client_ref,
}: {
  workspace: string;
  contact: string;
  text: string;
  client_ref: string;
}) {
  if (!workspaces[workspace])
    throw Object.assign(new Error("unknown workspace"), { status: 400 });
  if (!contact || !String(text || "").trim() || !client_ref)
    throw Object.assign(
      new Error("contact, text and client_ref are required"),
      { status: 400 },
    );
  await ensureConversation(workspace, contact);
  const doc = {
    workspace,
    contact,
    text,
    clientRef: client_ref,
    state: "queued",
    attempts: 0,
    nextAt: now(),
    createdAt: now(),
    updatedAt: now(),
  };
  let created = false;
  try {
    await collections.jobs.insertOne(doc);
    created = true;
  } catch (e: any) {
    if (e.code !== 11000) throw e;
  }
  const messageResult = await collections.messages.updateOne(
    { workspace, clientRef: client_ref },
    {
      $setOnInsert: {
        workspace,
        contact,
        clientRef: client_ref,
        direction: "outbound",
        text,
        status: "queued",
        sortAt: now(),
        createdAt: now(),
        updatedAt: now(),
      },
    },
    { upsert: true },
  );
  await collections.conversations.updateOne(
    { workspace, contact },
    { $max: { lastActivityAt: now() }, $set: { updatedAt: now() } },
  );
  if (created || messageResult.upsertedCount)
    await publishChange(workspace, "message.status", {
      contact,
      client_ref,
      status: "queued",
    });
  return doc;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function takeWorkspacePermit(workspace: string) {
  const key = `sendbucket:${workspace}`;
  const script = `
    local t=redis.call('TIME'); local now=tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000)
    local blocked=redis.call('PTTL',KEYS[2]); if blocked>0 then return {0,math.ceil(blocked/1000)} end
    local v=redis.call('HMGET',KEYS[1],'tokens','at')
    local tokens=tonumber(v[1]) or 8; local at=tonumber(v[2]) or now
    tokens=math.min(8,tokens+(now-at)*0.004); at=now
    if tokens<1 then return {0,2} end
    tokens=tokens-1; redis.call('HMSET',KEYS[1],'tokens',tokens,'at',at); redis.call('PEXPIRE',KEYS[1],60000)
    return {1,0}
  `;
  const out = await redis.eval(script, 2, key, `sendcool:${workspace}`);
  return { ok: Number(out[0]) === 1, wait: Number(out[1]) };
}
let workerRunning = true;
async function processJob(job: any): Promise<boolean | void> {
  const lease = `joblock:${job.workspace}:${job.clientRef}`;
  const leaseToken = randomBytes(12).toString("hex");
  const acquired = await redis.set(lease, leaseToken, "PX", 15000, "NX");
  if (!acquired) return false;
  try {
    const current = await collections.jobs.findOne({ _id: job._id });
    if (!current || current.state !== "queued") return;
    const permit = await takeWorkspacePermit(job.workspace);
    if (!permit.ok) {
      await collections.jobs.updateOne(
        { _id: job._id },
        {
          $set: {
            nextAt: new Date(Date.now() + Math.max(500, permit.wait * 1000)),
            updatedAt: now(),
          },
        },
      );
      return;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 9000);
    let response;
    try {
      response = await fetch(`${config.pigeon.url}/v1/messages`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${workspaces[job.workspace]}`,
          "content-type": "application/json",
          "idempotency-key": job.clientRef,
        },
        body: JSON.stringify({
          to: job.contact,
          text: job.text,
          client_ref: job.clientRef,
        }),
      });
    } catch {
      response = null;
    }
    clearTimeout(timeout);
    if (response?.ok) {
      const data = await response.json().catch(() => ({}));
      const changed = await collections.messages.updateOne(
        {
          workspace: job.workspace,
          clientRef: job.clientRef,
          status: "queued",
        },
        {
          $set: {
            status: "sent",
            providerMessageId: data.id || null,
            updatedAt: now(),
          },
        },
      );
      if (changed.modifiedCount)
        await publishChange(job.workspace, "message.status", {
          contact: job.contact,
          client_ref: job.clientRef,
          status: "sent",
        });
      await collections.jobs.updateOne(
        { _id: job._id },
        {
          $set: {
            state: "accepted",
            providerMessageId: data.id || null,
            acceptedAt: now(),
            updatedAt: now(),
          },
        },
      );
    } else {
      const status = response?.status || 503;
      const retryAfter = Number(response?.headers.get("retry-after")) || 0;
      if (status === 429)
        await redis.set(
          `sendcool:${job.workspace}`,
          "1",
          "PX",
          Math.max(2000, retryAfter * 1000),
        );
      const attempts = (job.attempts || 0) + 1;
      const delay =
        status === 429
          ? Math.max(2000, retryAfter * 1000)
          : Math.min(15000, 500 * 2 ** Math.min(attempts, 5));
      await collections.jobs.updateOne(
        { _id: job._id },
        {
          $set: {
            state: "queued",
            attempts,
            nextAt: new Date(Date.now() + delay),
            updatedAt: now(),
            lastError: `provider_${status}`,
          },
        },
      );
    }
  } finally {
    await redis.eval(
      "if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end",
      1,
      lease,
      leaseToken,
    );
  }
  return true;
}
async function workerLoop() {
  while (workerRunning) {
    try {
      const jobs = await collections.jobs
        .find({ state: "queued", nextAt: { $lte: now() } })
        .sort({ createdAt: 1 })
        .limit(10)
        .toArray();
      let worked = false;
      for (const job of jobs)
        if (await processJob(job)) {
          worked = true;
          break;
        }
      if (!worked) await sleep(100);
    } catch (e: any) {
      console.error("outbox worker", e);
      await sleep(250);
    }
  }
}
workerLoop();

// Workspace-private notes: readable only by authenticated workspace members.
app.get("/api/conversations/:contact/notes", requireUser, async (req, res) => {
  const workspace = String(req.query.workspace || "");
  if (!req.user.workspaces.some((w) => w.id === workspace))
    return res.status(403).json({ error: "forbidden" });
  const data = await collections.notes
    .find({ workspace, contact: req.params.contact })
    .sort({ createdAt: 1 })
    .toArray();
  res.json({ data });
});
app.post(
  "/api/conversations/:contact/notes",
  json,
  requireUser,
  async (req, res) => {
    const workspace = String(req.body.workspace || "");
    if (!req.user.workspaces.some((w) => w.id === workspace))
      return res.status(403).json({ error: "forbidden" });
    const text = String(req.body.text || "").trim();
    if (!text) return res.status(400).json({ error: "note text required" });
    const note = {
      workspace,
      contact: req.params.contact,
      author: req.user.sub,
      text,
      createdAt: now(),
    };
    await collections.notes.insertOne(note);
    await publishChange(workspace, "note.created", {
      contact: req.params.contact,
      author: req.user.sub,
    });
    res.status(201).json(note);
  },
);

// Grader endpoints use the same durable queue and claim logic as the UI.
function grader(req: Request, res: Response, next: NextFunction) {
  if (
    !safeEqual(String(req.headers["x-grader-token"] || ""), config.graderToken)
  )
    return res.status(401).json({ error: "unauthorized" });
  next();
}
app.post("/__grader/reset", json, grader, async (_req, res) => {
  await Promise.all(Object.values(collections).map((c) => c.deleteMany({})));
  for (const pattern of [
    "sendbucket:*",
    "sendcool:*",
    "streamlock:*",
    "joblock:*",
  ]) {
    const keys = await redis.keys(pattern);
    if (keys.length) await redis.del(...keys);
  }
  res.json({ ok: true });
});
app.get("/__grader/snapshot", grader, async (_req, res) => {
  const out: any = { workspaces: {} };
  for (const ws of Object.keys(workspaces)) {
    const contacts: Record<string, any> = {};
    const convs = await collections.conversations
      .find({ workspace: ws })
      .toArray();
    for (const c of convs) {
      const msgs = await collections.messages
        .find({ workspace: ws, contact: c.contact, direction: "inbound" })
        .sort({ occurredAt: 1, messageId: 1 })
        .toArray();
      contacts[c.contact] = {
        inbound: msgs.map((m) => m.messageId),
        assignee: c.assignee ?? null,
      };
    }
    const outbound: Record<string, string> = {};
    const messages = await collections.messages
      .find({ workspace: ws, direction: "outbound" })
      .toArray();
    for (const m of messages) outbound[m.clientRef] = m.status;
    out.workspaces[ws] = { contacts, outbound };
  }
  res.json(out);
});
app.post("/__grader/reply", json, grader, async (req, res) => {
  try {
    const b = req.body || {};
    await enqueueReply({
      workspace: b.workspace,
      contact: b.contact,
      text: b.text,
      client_ref: b.client_ref,
    });
    res.status(202).json({ accepted: true });
  } catch (e: any) {
    res.status(e.status || 500).json({ error: e.message });
  }
});
app.post("/__grader/claim", json, grader, async (req, res) => {
  const b = req.body || {};
  if (!workspaces[b.workspace])
    return res.status(400).json({ error: "unknown workspace" });
  const ok = await claim(b.workspace, b.contact, b.agent);
  res.status(ok ? 200 : 409).json({ assignee: ok ? b.agent : null });
});

// Basic browser API reply.
app.post("/api/reply", json, requireUser, async (req, res) => {
  const { workspace, contact, text, client_ref } = req.body || {};
  if (!req.user.workspaces.some((w) => w.id === workspace))
    return res.status(403).json({ error: "forbidden" });
  try {
    await enqueueReply({
      workspace,
      contact,
      text,
      client_ref: client_ref || randomBytes(12).toString("hex"),
    });
    res.status(202).json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// WebSocket auth and durable replay. Redis pub/sub fans events across all copies.
function websocketFrame(text: string): Buffer {
  const payload = Buffer.from(text);
  let header;
  if (payload.length < 126) header = Buffer.from([0x81, payload.length]);
  else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, payload]);
}
const sockets = new Map<string, Set<any>>();
sub.psubscribe("switchboard:*");
sub.on("pmessage", (_pattern, channel, raw) => {
  const workspace = channel.slice("switchboard:".length);
  const set = sockets.get(workspace);
  if (!set) return;
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return;
  }
  for (const socket of set) {
    if (socket.destroyed) continue;
    if (socket.replaying) socket.pendingEvents.push(event);
    else if (event.seq > socket.lastSeq) {
      socket.write(websocketFrame(JSON.stringify(event)));
      socket.lastSeq = event.seq;
    }
  }
});
httpServer.on("upgrade", async (req, socket) => {
  try {
    const u = new URL(req.url || "/ws", `http://${req.headers.host}`);
    if (u.pathname !== "/ws") return socket.destroy();
    const sid = cookie(req, "sb_session");
    const session =
      sid &&
      (await collections.sessions.findOne({
        _id: sid,
        expiresAt: { $gt: now() },
      }));
    const workspace = u.searchParams.get("workspace");
    if (
      !workspace ||
      !session ||
      !session.user.workspaces.some((w) => w.id === workspace)
    ) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return socket.destroy();
    }
    const key = req.headers["sec-websocket-key"];
    if (!key) return socket.destroy();
    const accept = createHash("sha1")
      .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " +
        accept +
        "\r\n\r\n",
    );
    const client: any = socket;
    client.lastSeq = Math.max(0, Number(u.searchParams.get("after")) || 0);
    client.replaying = true;
    client.pendingEvents = [];
    if (!sockets.has(workspace)) sockets.set(workspace, new Set<any>());
    const workspaceSockets = sockets.get(workspace)!;
    workspaceSockets.add(client);
    const removeSocket = () => {
      sockets.get(workspace)?.delete(client);
      if (!sockets.get(workspace)?.size) sockets.delete(workspace);
    };
    client.on("close", removeSocket);
    client.on("end", removeSocket);
    client.on("data", (data: Buffer) => {
      // Handle masked browser close and ping control frames.
      if (data.length >= 2) {
        const opcode = data[0] & 0x0f;
        if (opcode === 0x8) {
          client.write(Buffer.from([0x88, 0x00]));
          client.end();
        } else if (opcode === 0x9) client.write(Buffer.from([0x8a, 0x00]));
      }
    });
    const missed = await collections.stream
      .find({ workspace, seq: { $gt: client.lastSeq } })
      .sort({ seq: 1 })
      .toArray();
    for (const event of missed)
      if (!client.destroyed && event.seq > client.lastSeq) {
        client.write(websocketFrame(JSON.stringify(event)));
        client.lastSeq = event.seq;
      }
    client.replaying = false;
    client.pendingEvents.sort((a: any, b: any) => a.seq - b.seq);
    for (const event of client.pendingEvents)
      if (!client.destroyed && event.seq > client.lastSeq) {
        client.write(websocketFrame(JSON.stringify(event)));
        client.lastSeq = event.seq;
      }
    client.pendingEvents = [];
  } catch {
    socket.destroy();
  }
});

const port = Number(process.env.PORT || config.port);
httpServer.listen(port, () =>
  console.log(`Switchboard server listening on ${port}`),
);
