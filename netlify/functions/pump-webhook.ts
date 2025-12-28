// netlify/functions/pump-webhook.ts
// Helius -> Netlify webhook receiver
// - verifies shared secret
// - parses Pump.fun create_v2 instructions
// - stores normalized launches into Upstash Redis
//
// Requires env:
// UPSTASH_REDIS_REST_URL
// UPSTASH_REDIS_REST_TOKEN
// PUMP_WEBHOOK_SECRET

type HeliusWebhookTx = any;

const PUMP_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

// create_v2 discriminator: d6904cec5f8b31b4  (8 bytes)
const CREATE_V2_DISCRIMINATOR = Uint8Array.from([214, 144, 76, 236, 95, 139, 49, 180]);

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL!;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN!;
const SECRET = process.env.PUMP_WEBHOOK_SECRET!;

// Redis keys
const KEY_LAUNCHES = "pumpwatch:launches";        // list of JSON strings
const KEY_MINT_SEEN = "pumpwatch:mint_seen";      // set of mints we've already stored

function json(statusCode: number, body: any) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify(body),
  };
}

// Minimal base58 decode (no deps). Works for Solana instruction data.
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE_MAP = new Map<string, number>([...ALPHABET].map((c, i) => [c, i]));

function base58Decode(str: string): Uint8Array {
  if (!str) return new Uint8Array();
  const bytes: number[] = [0];
  for (const ch of str) {
    const val = BASE_MAP.get(ch);
    if (val === undefined) throw new Error("Invalid base58");
    let carry = val;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  // deal with leading zeros
  for (let k = 0; k < str.length && str[k] === "1"; k++) {
    bytes.push(0);
  }
  return new Uint8Array(bytes.reverse());
}

function startsWith(a: Uint8Array, prefix: Uint8Array) {
  if (a.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (a[i] !== prefix[i]) return false;
  return true;
}

// Borsh-ish parsing for: name(string), symbol(string), uri(string), creator(pubkey32), is_mayhem(bool)
// after first 8 bytes discriminator.
function readU32LE(buf: Uint8Array, off: number) {
  return (
    buf[off] |
    (buf[off + 1] << 8) |
    (buf[off + 2] << 16) |
    (buf[off + 3] << 24)
  ) >>> 0;
}

function readString(buf: Uint8Array, off: number): { value: string; next: number } {
  const len = readU32LE(buf, off);
  const start = off + 4;
  const end = start + len;
  const value = new TextDecoder().decode(buf.slice(start, end));
  return { value, next: end };
}

// creator pubkey is 32 bytes (raw). We don’t re-encode to base58 here to avoid deps.
// BUT: Helius enhanced tx usually also gives accounts, and mint is in tokenTransfers or account list.
// We'll store creator as hex fallback; you can improve later.
function readBytes(buf: Uint8Array, off: number, len: number) {
  return { value: buf.slice(off, off + len), next: off + len };
}

function toHex(u8: Uint8Array) {
  return [...u8].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function redis(cmd: string[], body?: any) {
  const res = await fetch(`${REDIS_URL}/${cmd.join("/")}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Upstash ${res.status}: ${JSON.stringify(j)}`);
  return j;
}

function extractCreateV2FromInstructions(tx: any) {
  // Helius enhanced transaction commonly contains:
  // tx.transaction.message.instructions (compiled) OR tx.instructions (decoded)
  // We handle both shapes defensively.

  const candidates: any[] = [];

  if (Array.isArray(tx?.instructions)) candidates.push(...tx.instructions);
  if (Array.isArray(tx?.transaction?.message?.instructions)) candidates.push(...tx.transaction.message.instructions);

  for (const ix of candidates) {
    const programId =
      ix?.programId ||
      ix?.programIdIndex?.programId ||
      ix?.program ||
      ix?.programId?.toString?.();

    // Some Helius shapes: ix.programId = "..."
    if (typeof programId === "string" && programId !== PUMP_PROGRAM_ID) continue;

    // Data may be base58 in ix.data (compiled) or ix.instruction?.data (decoded)
    const dataB58 =
      typeof ix?.data === "string" ? ix.data :
      typeof ix?.instruction?.data === "string" ? ix.instruction.data :
      typeof ix?.data?.data === "string" ? ix.data.data :
      null;

    if (!dataB58) continue;

    let raw: Uint8Array;
    try {
      raw = base58Decode(dataB58);
    } catch {
      continue;
    }

    if (!startsWith(raw, CREATE_V2_DISCRIMINATOR)) continue;

    // Parse args
    let off = 8;
    const name = readString(raw, off); off = name.next;
    const symbol = readString(raw, off); off = symbol.next;
    const uri = readString(raw, off); off = uri.next;

    const creatorBytes = readBytes(raw, off, 32); off = creatorBytes.next;
    const isMayhem = raw[off] === 1;

    return {
      name: name.value,
      symbol: symbol.value,
      uri: uri.value,
      creatorHex: toHex(creatorBytes.value),
      isMayhem,
    };
  }

  return null;
}

function pickMint(tx: any): string | null {
  // Best effort. Enhanced tx often provides tokenTransfers with mint.
  const tt = Array.isArray(tx?.tokenTransfers) ? tx.tokenTransfers : [];
  for (const t of tt) {
    if (typeof t?.mint === "string" && t.mint.length > 20) return t.mint;
  }

  // Some shapes include "accountData" changes; fallback:
  const post = Array.isArray(tx?.meta?.postTokenBalances) ? tx.meta.postTokenBalances : [];
  for (const b of post) {
    if (typeof b?.mint === "string" && b.mint.length > 20) return b.mint;
  }

  // If we can’t confidently find it, return null (we’ll still store the event without mint).
  return null;
}

export async function handler(event: any) {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
      },
      body: "",
    };
  }

  try {
    if (!SECRET) return json(500, { ok: false, error: "missing_secret_env" });

    // Shared-secret verification (simple + reliable)
    const qs = event.queryStringParameters || {};
    if (qs.secret !== SECRET) return json(401, { ok: false, error: "unauthorized" });

    const body = event.body ? JSON.parse(event.body) : null;
    if (!body) return json(400, { ok: false, error: "missing_body" });

    const txs: HeliusWebhookTx[] = Array.isArray(body) ? body : (Array.isArray(body?.transactions) ? body.transactions : [body]);

    const launches: any[] = [];

    for (const tx of txs) {
      // Only successful tx
      if (tx?.transactionError) continue;
      if (tx?.status && tx.status !== "SUCCESS") continue;

      const parsed = extractCreateV2FromInstructions(tx);
      if (!parsed) continue;

      const mint = pickMint(tx);
      const sig = tx?.signature || tx?.transactionSignature || tx?.txSignature || null;

      launches.push({
        kind: "pump_create_v2",
        mint,
        name: parsed.name,
        symbol: parsed.symbol,
        uri: parsed.uri,
        creatorHex: parsed.creatorHex,
        isMayhem: parsed.isMayhem,
        signature: sig,
        slot: tx?.slot ?? null,
        timestamp: tx?.timestamp ?? tx?.blockTime ?? Date.now() / 1000,
      });
    }

    // Store to Upstash (dedupe by mint when available; otherwise by signature)
    let stored = 0;

    for (const l of launches) {
      const dedupeKey = l.mint ? `mint:${l.mint}` : (l.signature ? `sig:${l.signature}` : null);
      if (!dedupeKey) continue;

      const seen = await redis(["sismember", KEY_MINT_SEEN, encodeURIComponent(dedupeKey)]);
      const isSeen = !!seen?.result;

      if (isSeen) continue;

      // mark seen + push to list (most recent first)
      await redis(["sadd", KEY_MINT_SEEN], [dedupeKey]);
      await redis(["lpush", KEY_LAUNCHES], [JSON.stringify(l)]);
      stored++;

      // keep list bounded (latest 500)
      await redis(["ltrim", KEY_LAUNCHES, "0", "499"]);
    }

    return json(200, { ok: true, received: txs.length, launches: launches.length, stored });
  } catch (e: any) {
    return json(500, { ok: false, error: "server_error", message: String(e?.message || e) });
  }
}
