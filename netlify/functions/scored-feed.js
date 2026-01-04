// netlify/functions/scored-feed.js
// Wraps pumpfun-new feed with a deterministic, explainable risk scoring v1.
// Adds in-memory TTL cache + soft IP rate limiting (per function instance).

const VERSION = "scored-feed@v1.0.0";

// TTL cache (per warm lambda instance)
const CACHE_TTL_MS = 60_000;
let CACHE = { at: 0, payload: null };

// Soft rate limit (per warm lambda instance)
const RL_WINDOW_MS = 10_000; // 10s window
const RL_MAX = 25; // 25 requests per IP per window
const RL = new Map(); // ip -> { n, resetAt }

function json(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}

function getClientIp(event) {
  // Netlify commonly sets x-nf-client-connection-ip
  const h = event.headers || {};
  return (
    h["x-nf-client-connection-ip"] ||
    (h["x-forwarded-for"] ? String(h["x-forwarded-for"]).split(",")[0].trim() : "") ||
    "unknown"
  );
}

function rateLimitOk(ip) {
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

function isValidBase58Mint(s) {
  // Solana pubkey base58 is typically 32 bytes -> 43/44 chars. Some mints may be 32..44 range.
  // We validate characters and length conservatively.
  if (typeof s !== "string") return false;
  const mint = s.trim();
  if (mint.length < 32 || mint.length > 44) return false;
  // Base58 alphabet without 0 O I l
  return /^[1-9A-HJ-NP-Za-km-z]+$/.test(mint);
}

function safeHttpUrl(u) {
  try {
    const url = new URL(String(u));
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function toISODateLike(v) {
  // Accepts ISO, ms, or Date-ish. Returns ISO string or null.
  try {
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString();
  } catch {
    return null;
  }
}

function scoreTokenV1(raw) {
  // Deterministic, explainable score: 0(best) -> 100(worst)
  // This v1 is mostly integrity + metadata heuristics (since on-chain signals are not yet wired).
  // Designed to extend later with on-chain probes.

  const signals = {};
  const reasons = [];

  const mint = typeof raw?.mint === "string" ? raw.mint.trim() : "";
  const pumpUrl = safeHttpUrl(raw?.pumpUrl);
  const firstSeenUTC = toISODateLike(raw?.firstSeenUTC);
  const source = typeof raw?.source === "string" ? raw.source.trim() : "";

  signals.mint = mint || null;
  signals.pumpUrl = pumpUrl || null;
  signals.firstSeenUTC = firstSeenUTC || null;
  signals.source = source || null;

  // Start neutral-ish risk; we *add* risk points for red flags.
  let score = 35;

  // Critical integrity checks
  if (!mint) {
    score = 100;
    reasons.push("Missing mint");
    return {
      mint: mint || null,
      pumpUrl: pumpUrl || null,
      firstSeenUTC: firstSeenUTC || null,
      source: source || "unknown",
      score: 100,
      verdict: "unknown",
      reasons,
      signals,
    };
  }

  if (!isValidBase58Mint(mint)) {
    score += 45;
    reasons.push("Mint format looks invalid (base58/length check failed)");
  }

  if (!pumpUrl) {
    score += 20;
    reasons.push("Missing or invalid Pump URL");
  } else {
    // Very light allowlist check for expected domain patterns (does NOT imply safety).
    const u = new URL(pumpUrl);
    const host = u.hostname.toLowerCase();
    if (!host.includes("pump.fun")) {
      score += 10;
      reasons.push("Pump URL domain is unusual (not pump.fun)");
    }
  }

  if (!firstSeenUTC) {
    score += 10;
    reasons.push("Missing/invalid firstSeen timestamp");
  }

  if (!source) {
    score += 5;
    reasons.push("Missing source label");
  }

  // V1: “Unknown on-chain signals” gets an explicit reason (transparency)
  reasons.push("On-chain checks not yet wired (authority/holders/LP signals = unknown)");
  signals.onchain = {
    mintAuthority: null,
    freezeAuthority: null,
    holders: null,
    topHolderPct: null,
    lpLock: null,
  };

  // Clamp
  if (score < 0) score = 0;
  if (score > 100) score = 100;

  // Verdict mapping (tunable)
  let verdict = "caution";
  if (score <= 25) verdict = "clean-ish";
  else if (score <= 60) verdict = "caution";
  else verdict = "high-risk";

  // If critical fields are badly broken, show unknown
  if (!isValidBase58Mint(mint) && !pumpUrl) verdict = "unknown";

  // Ensure at least one meaningful reason besides "unknown on-chain"
  if (reasons.length === 1 && reasons[0].startsWith("On-chain checks")) {
    reasons.unshift("Only basic integrity checks available in v1");
    score = Math.max(score, 40);
    verdict = "caution";
  }

  return {
    mint,
    pumpUrl,
    firstSeenUTC: firstSeenUTC || null,
    source: source || "unknown",
    score,
    verdict,
    reasons,
    signals,
  };
}

function getBaseUrl(event) {
  // Best-effort base URL for internal function-to-function call.
  // Netlify often provides URL/DEPLOY_PRIME_URL. If absent, derive from host headers.
  const envBase =
    process.env.URL ||
    process.env.DEPLOY_PRIME_URL ||
    process.env.DEPLOY_URL ||
    process.env.NETLIFY_SITE_URL;

  if (envBase) return String(envBase).replace(/\/$/, "");

  const h = event.headers || {};
  const proto = (h["x-forwarded-proto"] || "https").split(",")[0].trim();
  const host = h["host"] || h["x-forwarded-host"];
  if (host) return `${proto}://${host}`.replace(/\/$/, "");

  return null;
}

async function fetchRawFeed(event) {
  const base = getBaseUrl(event);
  // Fallback: relative fetch usually works in Netlify runtime, but not always.
  const url = base
    ? `${base}/.netlify/functions/pumpfun-new`
    : `/.netlify/functions/pumpfun-new`;

  const res = await fetch(url, {
    headers: {
      "accept": "application/json",
    },
  });

  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    // keep as null
  }

  if (!res.ok) {
    const msg = data?.error || `pumpfun-new failed (${res.status})`;
    throw new Error(msg);
  }
  return data;
}

exports.handler = async (event) => {
  const ip = getClientIp(event);
  if (!rateLimitOk(ip)) {
    return json(
      429,
      { error: "Rate limit exceeded. Try again in a few seconds." },
      { "retry-after": "5" }
    );
  }

  // TTL cache
  const now = Date.now();
  if (CACHE.payload && now - CACHE.at < CACHE_TTL_MS) {
    return json(200, CACHE.payload, { "x-cache": "HIT" });
  }

  try {
    const raw = await fetchRawFeed(event);
    const itemsRaw = Array.isArray(raw?.items) ? raw.items : [];

    const items = [];
    for (const r of itemsRaw) {
      try {
        items.push(scoreTokenV1(r));
      } catch (e) {
        items.push({
          mint: (typeof r?.mint === "string" ? r.mint : null),
          pumpUrl: safeHttpUrl(r?.pumpUrl),
          firstSeenUTC: toISODateLike(r?.firstSeenUTC),
          source: (typeof r?.source === "string" ? r.source : "unknown"),
          score: 100,
          verdict: "unknown",
          reasons: ["Scoring failed (internal error). Treat as unknown."],
          signals: { error: String(e?.message || e) },
        });
      }
    }

    const payload = {
      version: VERSION,
      updatedUTC: new Date().toISOString(),
      sourceInfo: {
        upstream: "pumpfun-new",
        cacheTTLms: CACHE_TTL_MS,
        rateLimit: { windowMs: RL_WINDOW_MS, max: RL_MAX },
      },
      items,
    };

    CACHE = { at: now, payload };
    return json(200, payload, { "x-cache": "MISS" });
  } catch (e) {
    return json(502, {
      error: "Failed to build scored feed",
      detail: String(e?.message || e),
      version: VERSION,
    });
  }
};
