// netlify/functions/pump-webhook.ts
// Helius -> Netlify webhook receiver
// - verifies shared secret (?secret=...)
// - parses Pump.fun create_v2 instructions
// - stores normalized launches into Upstash Redis (REST)
//
// ENV required:
// UPSTASH_REDIS_REST_URL
// UPSTASH_REDIS_REST_TOKEN
// PUMP_WEBHOOK_SECRET

type HeliusWebhookTx = any;

const PUMP_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const CREATE_V2_DISCRIMINATOR = Uint8Array.from([214, 144, 76, 236, 95, 139, 49, 180]);

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL!;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN!;
const SECRET = process.env.PUMP_WEBHOOK_SECRET!;

const KEY_LAUNCHES = "pumpwatch:launches";   // list of JSON
const KEY_SEEN = "pumpwatch:seen";           // set for dedupe

function j(statusCode: number, body: any) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    },
    body: JSON.stringify(body),
  };
}

/* ---- base58 decode (no deps) ---- */
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
  for (let k = 0; k < str.length && str[k] === "1"; k++) bytes.push(0);
  return new Uint8Array(bytes.reverse());
}

function startsWith(a: Uint8Array, prefix: Uint8Array) {
  if (a.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (a[i] !== prefix[i]) return false;
  return true;
}

/* ---- simple borsh-ish parse ---- */
function readU32LE(buf: Uint8Array, off: number) {
  return (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0;
}
function readString(buf: Uint8Array, off: number): { value: string; next: number } {
  const len = readU32LE(buf, off);
  const start = off + 4;
  const end = start + len;
  const value = new TextDecoder().decode(buf.slice(start, end));
  return { value, next: end };
}
function readBytes(buf: Uint8Array, off: number, len: number) {
  return { value: buf.slice(off, off + len), next: off + len };
}
function toHex(u8: Uint8Array) {
  return [...u8].map(b => b.toString(16).padStart(2, "0")).join("");
}

/* ---- Upstash REST helper ---- */
async function redis(path: string[], body?: any) {
  const res = await fetch(`${REDIS_URL}/${path.map(encodeURIComponent).join("/")}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Upstash ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

function extractCreateV2(tx: any) {
  const candidates: any[] = [];
  if (Array.isArray(tx?.instructions)) candidates.push(...tx.instructions);
  if (Array.isArray(tx?.transaction?.message?.instructions)) candidates.push(...tx.transaction.message.instructions);

  for (const ix of candidates) {
    const programId =
      (typeof ix?.programId === "string" && ix.programId) ||
      (typeof ix?.programId?.toString === "function" ? ix.programId.toString() : null) ||
      (typeof ix?.program === "string" ? ix.program : null);

    if (programId && programId !== PUMP_PROGRAM_ID) continue;

    const dataB58 =
      typeof ix?.data === "string" ? ix.data :
      typeof ix?.instruction?.data === "string" ? ix.instruction.data :
      typeof ix?.data?.data === "string" ? ix.data.data :
      null;

    if (!dataB58) continue;

    let raw: Uint8Array;
    try { raw = base58Decode(dataB58); } catch { continue; }
    if (!startsWith(raw, CREATE_V2_DISCRIMINATOR)) continue;

    let off = 8;
    const name = readString(raw, off); off = name.next;
    const symbol = readString(raw, off); off = symbol.next;
    const uri = readString(raw, off); off = uri.next;
    const creatorBytes = readBytes(raw, off, 32); off = creatorBytes.next;
    const isMayhem = raw[off] === 1;

    return { name: name.value, symbol: symbol.value, uri: uri.value, creatorHex: toHex(creatorBytes.value), isMayhem };
  }
  return null;
}

function pickMint(tx: any): string | null {
  const tt = Array.isArray(tx?.tokenTransfers) ? tx.tokenTransfers : [];
  for (const t of tt) if (typeof t?.mint === "string" && t.mint.length > 20) return t.mint;

  const post = Array.isArray(tx?.meta?.postTokenBalances) ? tx.meta.postTokenBalances : [];
  for (const b of post) if (typeof b?.mint === "string" && b.mint.length > 20) return b.mint;

  return null;
}

export async function handler(event: any) {
  if (event.httpMethod === "OPTIONS") return j(200, { ok: true });

  try {
    if (!SECRET) return j(500, { ok: false, error: "missing_PUMP_WEBHOOK_SECRET" });

    const qs = event.queryStringParameters || {};
    if (qs.secret !== SECRET) return j(401, { ok: false, error: "unauthorized" });

    const body = event.body ? JSON.parse(event.body) : null;
    if (!body) return j(400, { ok: false, error: "missing_body" });

    const txs: HeliusWebhookTx[] =
      Array.isArray(body) ? body :
      Array.isArray(body?.transactions) ? body.transactions :
      [body];

    let received = txs.length;
    let launches = 0;
    let stored = 0;

    for (const tx of txs) {
      if (tx?.transactionError) continue;
      if (tx?.status && tx.status !== "SUCCESS") continue;

      const parsed = extractCreateV2(tx);
      if (!parsed) continue;

      const mint = pickMint(tx);
      const sig = tx?.signature || tx?.transactionSignature || tx?.txSignature || null;

      const item = {
        kind: "pump_create_v2",
        mint,
        name: parsed.name,
        symbol: parsed.symbol,
        uri: parsed.uri,
        creatorHex: parsed.creatorHex,
        isMayhem: parsed.isMayhem,
        signature: sig,
        slot: tx?.slot ?? null,
        timestamp: tx?.timestamp ?? tx?.blockTime ?? Math.floor(Date.now() / 1000),
      };

      launches++;

      const dedupeKey = mint ? `mint:${mint}` : (sig ? `sig:${sig}` : null);
      if (!dedupeKey) continue;

      const seen = await redis(["sismember", KEY_SEEN, dedupeKey]);
      if (seen?.result) continue;

      await redis(["sadd", KEY_SEEN], [dedupeKey]);
      await redis(["lpush", KEY_LAUNCHES], [JSON.stringify(item)]);
      await redis(["ltrim", KEY_LAUNCHES, "0", "499"]);
      stored++;
    }

    return j(200, { ok: true, received, launches, stored });
  } catch (e: any) {
    return j(500, { ok: false, error: "server_error", message: String(e?.message || e) });
  }
}
