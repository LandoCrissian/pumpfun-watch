// netlify/functions/scored-feed.ts
// Builds a scored, explainable feed from Upstash-stored Pump webhook launches.
// Adds: TTL cache, soft per-IP rate limit, and basic on-chain mint validation + authority checks.

type AnyObj = Record<string, any>;

const VERSION = "scored-feed@v1.1.0";

// Upstash (same as your get-pump-feed.ts)
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL!;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN!;
const KEY_LAUNCHES = "pumpwatch:launches";

// RPC (free fallback). Optional: set SOLANA_RPC_URL to a paid/fast endpoint (Helius, Triton, etc.)
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";

// per warm instance cache
const CACHE_TTL_MS = 60_000;
let CACHE: { at: number; payload: any | null } = { at: 0, payload: null };

// per warm instance rate limit (soft)
const RL_WINDOW_MS = 10_000;
const RL_MAX = 25;
const RL = new Map<string, { n: number; resetAt: number }>();

// per mint on-chain cache (avoid hammering RPC)
const ONCHAIN_TTL_MS = 5 * 60_000;
const ONCHAIN = new Map<string, { at: number; data: OnchainMintInfo | null }>();

/* ---------------- response helpers ---------------- */

function j(statusCode: number, body: any, headers: Record<string, string> = {}) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
      ...headers,
    },
    body: JSON.stringify(body),
  };
}

function getClientIp(event: any) {
  const h = event.headers || {};
  return (
    h["x-nf-client-connection-ip"] ||
    (h["x-forwarded-for"] ? String(h["x-forwarded-for"]).split(",")[0].trim() : "") ||
    "unknown"
  );
}

function rateLimitOk(ip: string) {
  const now = Date.now();
  const row = RL.get(ip);
  if (!row || now > row.resetAt) {
    RL.set(ip, { n: 1, resetAt: now + RL_WINDOW_MS });
    return true;
  }
  row.n += 1;
  RL.set(ip, row);
  return row.n <= RL_MAX;
}

/* ---------------- shared validation ---------------- */

// Solana base58 pubkey validation
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;
function isValidPubkey(s: any) {
  if (typeof s !== "string") return false;
  const v = s.trim();
  if (v.length < 32 || v.length > 44) return false;
  return BASE58_RE.test(v);
}

function safeHttpUrl(u: any) {
  try {
    const url = new URL(String(u));
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function toISO(v: any) {
  try {
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString();
  } catch {
    return null;
  }
}

/* ---------------- upstash redis ---------------- */

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

async function loadLaunches(limit: number) {
  const r = await redis(["lrange", KEY_LAUNCHES, "0", String(limit - 1)]);
  const rows: string[] = Array.isArray(r?.result) ? r.result : [];
  const items = rows
    .map((s) => {
      try {
        return JSON.parse(s);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return items as AnyObj[];
}

/* ---------------- on-chain RPC ---------------- */

type OnchainMintInfo = {
  exists: boolean;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  decimals: number | null;
  isInitialized: boolean | null;
};

async function rpc(method: string, params: any[]) {
  const res = await fetch(SOLANA_RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`RPC ${res.status}`);
  if (data?.error) throw new Error(`RPC error: ${JSON.stringify(data.error)}`);
  return data?.result;
}

// SPL Token mint account layout (legacy token program) decoding.
// We only need mintAuthOption/mintAuth and freezeAuthOption/freezeAuth, decimals, isInitialized.
function readU32LE(buf: Uint8Array, off: number) {
  return (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0;
}
function readU64LE(buf: Uint8Array, off: number) {
  // supply not needed, but we advance cursor; kept for correctness
  let lo = 0, hi = 0;
  for (let i = 0; i < 4; i++) lo |= buf[off + i] << (8 * i);
  for (let i = 0; i < 4; i++) hi |= buf[off + 4 + i] << (8 * i);
  return { lo: lo >>> 0, hi: hi >>> 0 };
}
function base64ToU8(b64: string) {
  const bin = Buffer.from(b64, "base64");
  return new Uint8Array(bin.buffer, bin.byteOffset, bin.byteLength);
}

// NOTE: We can't base58-encode pubkeys without deps; but RPC can provide parsed data if we ask.
// So we prefer getAccountInfo with "jsonParsed" first. If not parsed, we decode raw bytes but can’t render authority pubkeys.
// Therefore: use jsonParsed when available; raw fallback sets authorities = "unknown".
async function fetchMintOnchain(mint: string): Promise<OnchainMintInfo> {
  // cache
  const now = Date.now();
  const cached = ONCHAIN.get(mint);
  if (cached && now - cached.at < ONCHAIN_TTL_MS) return cached.data || { exists: false, mintAuthority: null, freezeAuthority: null, decimals: null, isInitialized: null };

  let out: OnchainMintInfo = {
    exists: false,
    mintAuthority: null,
    freezeAuthority: null,
    decimals: null,
    isInitialized: null,
  };

  try {
    // Prefer jsonParsed (best UX for authorities)
    const r1 = await rpc("getAccountInfo", [mint, { encoding: "jsonParsed", commitment: "confirmed" }]);
    const v = r1?.value;
    if (!v) {
      out.exists = false;
    } else {
      out.exists = true;

      const parsed = v?.data?.parsed;
      if (parsed?.type === "mint" && parsed?.info) {
        // token-2022 mints might differ; still often parseable.
        out.decimals = typeof parsed.info.decimals === "number" ? parsed.info.decimals : null;
        out.isInitialized = typeof parsed.info.isInitialized === "boolean" ? parsed.info.isInitialized : null;

        // In jsonParsed, mintAuthority/freezeAuthority can be string or null
        out.mintAuthority = typeof parsed.info.mintAuthority === "string" ? parsed.info.mintAuthority : null;
        out.freezeAuthority = typeof parsed.info.freezeAuthority === "string" ? parsed.info.freezeAuthority : null;
      } else if (Array.isArray(v?.data) && typeof v.data[0] === "string") {
        // raw base64 fallback
        const b64 = v.data[0];
        const buf = base64ToU8(b64);
        if (buf.length >= 82) {
          const mintAuthOption = readU32LE(buf, 0);
          // 32 bytes mintAuth after option
          const decimals = buf[44 + 8]; // option(4)+auth(32)+supply(8)=44, decimals at 44
          const isInit = buf[45] === 1;
          const freezeAuthOption = readU32LE(buf, 46);
          out.decimals = typeof decimals === "number" ? decimals : null;
          out.isInitialized = isInit;

          // Authorities unknown without base58 encoding; we can at least report presence/absence
          out.mintAuthority = mintAuthOption === 0 ? null : "present";
          out.freezeAuthority = freezeAuthOption === 0 ? null : "present";
        }
      }
    }
  } catch {
    // treat as unknown; don't fail the whole feed
  }

  ONCHAIN.set(mint, { at: now, data: out });
  return out;
}

/* ---------------- scoring ---------------- */

type TokenScored = {
  mint: string | null;
  firstSeenUTC: string | null;
  source: string;
  pumpUrl: string | null;

  // extra metadata (from webhook)
  name?: string | null;
  symbol?: string | null;
  uri?: string | null;
  creatorHex?: string | null;
  signature?: string | null;
  isMayhem?: boolean | null;

  score: number;
  verdict: "clean-ish" | "caution" | "high-risk" | "unknown";
  reasons: string[];
  signals: AnyObj;
};

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

function scoreTokenV1(item: AnyObj, onchain: OnchainMintInfo | null): TokenScored {
  const reasons: string[] = [];
  const signals: AnyObj = {};

  const mint = typeof item?.mint === "string" ? item.mint.trim() : "";
  const name = typeof item?.name === "string" ? item.name.trim() : null;
  const symbol = typeof item?.symbol === "string" ? item.symbol.trim() : null;
  const uri = safeHttpUrl(item?.uri) || null;
  const creatorHex = typeof item?.creatorHex === "string" ? item.creatorHex.trim() : null;
  const isMayhem = typeof item?.isMayhem === "boolean" ? item.isMayhem : null;
  const signature = typeof item?.signature === "string" ? item.signature : null;

  // Pump URL: stable/derived
  const pumpUrl = mint ? `https://pump.fun/${mint}` : null;

  // firstSeen derived from timestamp (webhook gives seconds)
  const tsSec = typeof item?.timestamp === "number" ? item.timestamp : null;
  const firstSeenUTC = tsSec ? toISO(tsSec * 1000) : null;

  const source = "webhook:create_v2";

  signals.mint = mint || null;
  signals.name = name;
  signals.symbol = symbol;
  signals.uri = uri;
  signals.creatorHex = creatorHex;
  signals.isMayhem = isMayhem;
  signals.signature = signature;
  signals.timestamp = tsSec;

  let score = 20; // start fairly low; add risk points

  // integrity
  if (!mint) {
    return {
      mint: null,
      firstSeenUTC,
      source,
      pumpUrl: null,
      name,
      symbol,
      uri,
      creatorHex,
      signature,
      isMayhem,
      score: 100,
      verdict: "unknown",
      reasons: ["Missing mint"],
      signals,
    };
  }

  if (!isValidPubkey(mint)) {
    score += 55;
    reasons.push("Mint format looks invalid (base58/length check failed)");
  }

  if (!name) {
    score += 10;
    reasons.push("Missing token name in create_v2 payload");
  }

  if (!symbol) {
    score += 8;
    reasons.push("Missing token symbol in create_v2 payload");
  }

  if (!uri) {
    score += 12;
    reasons.push("Missing/invalid metadata URI");
  }

  // creatorHex is your parsed 32 bytes hex (should be 64 chars)
  if (!creatorHex || !/^[0-9a-fA-F]{64}$/.test(creatorHex)) {
    score += 12;
    reasons.push("Creator bytes missing/invalid (hex length check failed)");
  }

  if (!signature) {
    score += 6;
    reasons.push("Missing transaction signature");
  }

  if (isMayhem === true) {
    score += 10;
    reasons.push("Flag: create_v2 indicates mayhem mode (treat as higher risk)");
  }

  // timestamp sanity
  if (!firstSeenUTC) {
    score += 8;
    reasons.push("Missing/invalid timestamp");
  } else {
    const now = Date.now();
    const seen = new Date(firstSeenUTC).getTime();
    if (seen > now + 60_000) {
      score += 6;
      reasons.push("Timestamp is in the future (clock skew or malformed event)");
    }
  }

  // On-chain checks (basic, proof-first)
  if (!onchain) {
    reasons.push("On-chain mint checks unavailable (RPC error/limit) — treat as unknown");
    score += 8;
  } else {
    signals.onchain = onchain;

    if (!onchain.exists) {
      score += 45;
      reasons.push("On-chain: mint account not found (could be malformed or not finalized)");
    } else {
      // Mint authority present = can mint more supply (many rugs keep this).
      if (onchain.mintAuthority) {
        score += 12;
        reasons.push("On-chain: mint authority is present (supply can potentially be increased)");
      } else {
        reasons.push("On-chain: mint authority appears unset (cannot mint more via authority)");
      }

      // Freeze authority present = can freeze accounts (often disliked by buyers).
      if (onchain.freezeAuthority) {
        score += 10;
        reasons.push("On-chain: freeze authority is present (accounts can be frozen)");
      } else {
        reasons.push("On-chain: freeze authority appears unset (cannot freeze via authority)");
      }

      if (typeof onchain.decimals === "number") {
        // not a rug signal; just transparency
        reasons.push(`On-chain: decimals = ${onchain.decimals}`);
      }
    }
  }

  score = clamp(score, 0, 100);

  let verdict: TokenScored["verdict"] = "caution";
  if (score <= 25) verdict = "clean-ish";
  else if (score <= 60) verdict = "caution";
  else verdict = "high-risk";

  // If mint invalid + on-chain not found => unknown
  if (!isValidPubkey(mint) && (!onchain || !onchain.exists)) verdict = "unknown";

  // If we somehow generated no reasons, be honest
  if (reasons.length === 0) reasons.push("Only basic checks applied (no additional signals available)");

  return {
    mint,
    firstSeenUTC,
    source,
    pumpUrl,
    name,
    symbol,
    uri,
    creatorHex,
    signature,
    isMayhem,
    score,
    verdict,
    reasons,
    signals,
  };
}

/* ---------------- handler ---------------- */

export async function handler(event: any) {
  const ip = getClientIp(event);
  if (!rateLimitOk(ip)) {
    return j(
      429,
      { ok: false, error: "rate_limited", message: "Too many requests. Try again in a few seconds." },
      { "retry-after": "5" }
    );
  }

  const now = Date.now();
  if (CACHE.payload && now - CACHE.at < CACHE_TTL_MS) {
    return j(200, CACHE.payload, { "x-cache": "HIT" });
  }

  try {
    const q = event.queryStringParameters || {};
    const limit = Math.max(1, Math.min(200, parseInt(q.limit || "50", 10) || 50));

    const launches = await loadLaunches(limit);

    // On-chain checks: to avoid RPC hammering, only check first N newest mints per request.
    // You can tune this; start small to stay reliable on public RPC.
    const ONCHAIN_CHECK_N = Math.min(30, launches.length);

    const onchainByMint = new Map<string, OnchainMintInfo | null>();
    for (let i = 0; i < ONCHAIN_CHECK_N; i++) {
      const mint = typeof launches[i]?.mint === "string" ? launches[i].mint.trim() : "";
      if (!mint || !isValidPubkey(mint)) continue;
      if (onchainByMint.has(mint)) continue;
      const info = await fetchMintOnchain(mint);
      onchainByMint.set(mint, info);
    }

    const items: TokenScored[] = launches.map((it) => {
      const mint = typeof it?.mint === "string" ? it.mint.trim() : "";
      const onchain = mint && onchainByMint.has(mint) ? onchainByMint.get(mint)! : null;
      return scoreTokenV1(it, onchain);
    });

    const payload = {
      ok: true,
      version: VERSION,
      updatedUTC: new Date().toISOString(),
      sourceInfo: {
        upstream: "upstash:pumpwatch:launches",
        cacheTTLms: CACHE_TTL_MS,
        rateLimit: { windowMs: RL_WINDOW_MS, max: RL_MAX },
        rpc: SOLANA_RPC_URL.includes("api.mainnet-beta.solana.com") ? "public-default" : "custom",
        onchainChecked: Math.min(30, launches.length),
      },
      count: items.length,
      items,
    };

    CACHE = { at: now, payload };
    return j(200, payload, { "x-cache": "MISS" });
  } catch (e: any) {
    return j(500, { ok: false, error: "server_error", message: String(e?.message || e), version: VERSION });
  }
}
