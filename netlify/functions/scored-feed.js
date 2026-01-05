import type { Handler, HandlerEvent } from "@netlify/functions";

// ============================================================================
// SCORED-FEED.TS — Pump.fun Watch Risk Scoring Engine v1 (Off-Chain Only)
// By Aegis / Jackpot
// ============================================================================

// --- Types ---
interface RawLaunchItem {
  kind?: string;
  mint?: string | null;
  name?: string;
  symbol?: string;
  uri?: string;
  creatorHex?: string;
  isMayhem?: boolean;
  signature?: string | null;
  slot?: number | null;
  timestamp?: number;
}

interface ScoredToken {
  mint: string | null;
  firstSeenUTC: string;
  source: string;
  pumpUrl: string | null;
  name: string;
  symbol: string;
  uri: string;
  creatorHex: string;
  signature: string | null;
  isMayhem: boolean;
  score: number;
  verdict: "clean-ish" | "caution" | "high-risk" | "unknown";
  reasons: string[];
  signals: Record<string, unknown>;
}

interface ScoredFeedResponse {
  ok: boolean;
  version: string;
  updatedUTC: string;
  sourceInfo: {
    provider: string;
    cacheHit: boolean;
    cacheTTL: number;
    itemsFromUpstash: number;
  };
  count: number;
  items: ScoredToken[];
  error?: string;
}

// --- Constants ---
const VERSION = "1.0.0";
const CACHE_TTL_MS = 60_000; // 60 seconds
const RATE_LIMIT_WINDOW_MS = 10_000;
const RATE_LIMIT_MAX = 25;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MIN_LIMIT = 1;

// Base58 alphabet for validation
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

// Suspicious URI patterns
const SUSPICIOUS_URI_PATTERNS = [
  /^data:/i,
  /^javascript:/i,
  /[?&].{500,}/,  // Very long query strings
];

// Scammy symbol patterns
const SCAMMY_SYMBOL_PATTERNS = [
  /(.)\1{4,}/,  // Repeated chars 5+
  /[\u{1F300}-\u{1F9FF}]{3,}/u,  // 3+ emojis in a row
  /[\u0400-\u04FF]/,  // Cyrillic (confusables)
  /[\u0370-\u03FF]/,  // Greek (confusables) 
];

// --- In-Memory Cache ---
interface CacheEntry {
  data: ScoredFeedResponse;
  expiresAt: number;
}

let feedCache: CacheEntry | null = null;

// --- Rate Limiting (Soft, In-Memory) ---
const rateLimitMap = new Map<string, { count: number; windowStart: number }>();

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(ip, { count: 1, windowStart: now });
    return true;
  }
  
  if (entry.count >= RATE_LIMIT_MAX) {
    return false;
  }
  
  entry.count++;
  return true;
}

// Cleanup old rate limit entries periodically
function cleanupRateLimits() {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap.entries()) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS * 2) {
      rateLimitMap.delete(ip);
    }
  }
}

// --- Upstash Fetch ---
async function fetchFromUpstash(limit: number): Promise<RawLaunchItem[]> {
  const upstashUrl = process.env.UPSTASH_REDIS_REST_URL;
  const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!upstashUrl || !upstashToken) {
    throw new Error("Upstash credentials not configured");
  }

  // Fetch more than requested to build creator frequency map
  const fetchCount = Math.min(limit * 4, 200);
  
  const response = await fetch(`${upstashUrl}/lrange/pumpwatch:launches/0/${fetchCount - 1}`, {
    headers: {
      Authorization: `Bearer ${upstashToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Upstash returned ${response.status}`);
  }

  const data = await response.json();
  
  if (!data.result || !Array.isArray(data.result)) {
    return [];
  }

  // Parse each item defensively
  return data.result.map((item: string | unknown) => {
    try {
      if (typeof item === "string") {
        return JSON.parse(item) as RawLaunchItem;
      }
      return item as RawLaunchItem;
    } catch {
      return {} as RawLaunchItem;
    }
  });
}

// --- Validation Helpers ---
function isValidBase58(str: string): boolean {
  if (str.length < 32 || str.length > 44) return false;
  for (const char of str) {
    if (!BASE58_ALPHABET.includes(char)) return false;
  }
  return true;
}

function isValidHttpsUrl(uri: string): { valid: boolean; isHttps: boolean; host: string } {
  try {
    const url = new URL(uri);
    return {
      valid: true,
      isHttps: url.protocol === "https:",
      host: url.host,
    };
  } catch {
    return { valid: false, isHttps: false, host: "" };
  }
}

function hasSuspiciousUriPattern(uri: string): boolean {
  return SUSPICIOUS_URI_PATTERNS.some((pattern) => pattern.test(uri));
}

function hasScammySymbol(symbol: string): boolean {
  return SCAMMY_SYMBOL_PATTERNS.some((pattern) => pattern.test(symbol));
}

function hasNonPrintableChars(str: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(str);
}

function isReasonableTimestamp(ts: number): boolean {
  // Should be after 2024-01-01 and before now + 1 day
  const min = 1704067200; // 2024-01-01
  const max = Math.floor(Date.now() / 1000) + 86400;
  return ts >= min && ts <= max;
}

// --- Scoring Engine ---
function scoreToken(
  item: RawLaunchItem,
  creatorFrequencyMap: Map<string, number>,
  recentCreators: Set<string>
): ScoredToken {
  let score = 0;
  const reasons: string[] = [];
  const signals: Record<string, unknown> = {};
  let forceUnknown = false;

  // Extract fields with defaults
  const mint = item.mint ?? null;
  const name = typeof item.name === "string" ? item.name.slice(0, 100) : "";
  const symbol = typeof item.symbol === "string" ? item.symbol.slice(0, 20) : "";
  const uri = typeof item.uri === "string" ? item.uri.slice(0, 500) : "";
  const creatorHex = typeof item.creatorHex === "string" ? item.creatorHex : "";
  const signature = item.signature ?? null;
  const isMayhem = Boolean(item.isMayhem);
  const timestamp = typeof item.timestamp === "number" ? item.timestamp : 0;

  signals.rawMint = mint;
  signals.rawTimestamp = timestamp;
  signals.isMayhem = isMayhem;

  // === A) Integrity / Completeness ===
  
  // A1: Missing mint => unknown
  if (!mint) {
    score = 100;
    reasons.push("Missing mint address");
    forceUnknown = true;
    signals.missingMint = true;
  } else {
    // A2: Invalid base58 mint
    if (!isValidBase58(mint)) {
      score += 55;
      reasons.push("Invalid mint format (not valid base58)");
      signals.invalidMintFormat = true;
    }
  }

  // A3: Missing signature
  if (!signature) {
    score += 10;
    reasons.push("Missing transaction signature");
    signals.missingSignature = true;
  } else {
    signals.signatureTruncated = signature.slice(0, 8) + "..." + signature.slice(-4);
  }

  // A4: Missing name
  if (!name) {
    score += 10;
    reasons.push("Missing token name");
    signals.missingName = true;
  }

  // A5: Missing symbol
  if (!symbol) {
    score += 10;
    reasons.push("Missing token symbol");
    signals.missingSymbol = true;
  }

  // A6: URI validation
  if (!uri) {
    score += 15;
    reasons.push("Missing metadata URI");
    signals.missingUri = true;
  } else {
    const uriCheck = isValidHttpsUrl(uri);
    signals.uriHost = uriCheck.host || "(invalid)";
    
    if (!uriCheck.valid) {
      score += 15;
      reasons.push("Invalid metadata URI format");
      signals.invalidUri = true;
    } else if (!uriCheck.isHttps) {
      score += 10;
      reasons.push("Metadata URI uses insecure HTTP");
      signals.insecureUri = true;
    }

    // Check suspicious patterns
    if (hasSuspiciousUriPattern(uri)) {
      score = 100;
      reasons.push("Suspicious URI pattern detected (data:/javascript:/excessive params)");
      forceUnknown = true;
      signals.suspiciousUriPattern = true;
    }
  }

  // A7: Timestamp validation
  if (!timestamp || !isReasonableTimestamp(timestamp)) {
    score += 10;
    reasons.push("Missing or unreasonable timestamp");
    signals.badTimestamp = true;
  }

  // === B) Name/Symbol Content Risk ===
  
  // B1: Too long name (>50 chars is suspicious)
  if (name.length > 50) {
    score += 10;
    reasons.push("Unusually long token name");
    signals.longName = name.length;
  }

  // B2: Too long symbol (>10 chars is unusual)
  if (symbol.length > 10) {
    score += 10;
    reasons.push("Unusually long symbol");
    signals.longSymbol = symbol.length;
  }

  // B3: Non-printable characters
  if (hasNonPrintableChars(name) || hasNonPrintableChars(symbol)) {
    score += 25;
    reasons.push("Contains non-printable/control characters");
    signals.nonPrintableChars = true;
  }

  // B4: Scammy symbol patterns
  if (symbol && hasScammySymbol(symbol)) {
    score += 10;
    reasons.push("Symbol contains suspicious patterns (repeated chars/emojis/confusables)");
    signals.scammySymbol = true;
  }

  // === C) Creator Reuse / Spam Detection ===
  if (creatorHex) {
    const frequency = creatorFrequencyMap.get(creatorHex) || 0;
    signals.creatorHexTruncated = creatorHex.slice(0, 8) + "..." + creatorHex.slice(-4);
    signals.creatorFrequency = frequency;
    signals.creatorInRecent10 = recentCreators.has(creatorHex);

    // Progressive risk based on frequency
    if (frequency > 10) {
      score += 30;
      reasons.push(`Creator launched ${frequency} tokens recently (high spam)`);
    } else if (frequency > 5) {
      score += 20;
      reasons.push(`Creator launched ${frequency} tokens recently (moderate spam)`);
    } else if (frequency > 2) {
      score += 10;
      reasons.push(`Creator launched ${frequency} tokens recently`);
    }

    // Extra penalty if in recent 10
    if (recentCreators.has(creatorHex) && frequency > 1) {
      score += 5;
      reasons.push("Creator very active in last 10 launches");
    }
  } else {
    signals.missingCreator = true;
    score += 15;
    reasons.push("Missing creator identifier");
  }

  // === D) Mayhem Mode ===
  if (isMayhem) {
    score += 10;
    reasons.push("Created in Mayhem mode (relaxed validation)");
  }

  // === Clamp and Verdict ===
  score = Math.max(0, Math.min(100, score));

  let verdict: ScoredToken["verdict"];
  if (forceUnknown) {
    verdict = "unknown";
  } else if (score <= 25) {
    verdict = "clean-ish";
  } else if (score <= 60) {
    verdict = "caution";
  } else {
    verdict = "high-risk";
  }

  // Build output
  const firstSeenUTC = timestamp
    ? new Date(timestamp * 1000).toISOString()
    : new Date().toISOString();

  const pumpUrl = mint ? `https://pump.fun/${mint}` : null;

  return {
    mint,
    firstSeenUTC,
    source: "webhook:pump_create_v2",
    pumpUrl,
    name,
    symbol,
    uri,
    creatorHex,
    signature,
    isMayhem,
    score,
    verdict,
    reasons: reasons.length > 0 ? reasons : ["No risk signals detected"],
    signals,
  };
}

// --- Main Scoring Pipeline ---
function scoreFeed(rawItems: RawLaunchItem[], limit: number): ScoredToken[] {
  // Build creator frequency map from all items
  const creatorFrequencyMap = new Map<string, number>();
  for (const item of rawItems) {
    if (item.creatorHex) {
      creatorFrequencyMap.set(
        item.creatorHex,
        (creatorFrequencyMap.get(item.creatorHex) || 0) + 1
      );
    }
  }

  // Track creators in first 10 items (most recent)
  const recentCreators = new Set<string>();
  for (let i = 0; i < Math.min(10, rawItems.length); i++) {
    if (rawItems[i].creatorHex) {
      recentCreators.add(rawItems[i].creatorHex!);
    }
  }

  // Score each token (only return requested limit)
  const itemsToScore = rawItems.slice(0, limit);
  return itemsToScore.map((item) => scoreToken(item, creatorFrequencyMap, recentCreators));
}

// --- Handler ---
export const handler: Handler = async (event: HandlerEvent) => {
  // CORS headers
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "public, max-age=30",
  };

  // Handle preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  // Only allow GET
  if (event.httpMethod !== "GET") {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ ok: false, error: "Method not allowed" }),
    };
  }

  // Rate limiting
  const clientIp = event.headers["x-forwarded-for"]?.split(",")[0]?.trim() || "unknown";
  cleanupRateLimits();
  
  if (!checkRateLimit(clientIp)) {
    return {
      statusCode: 429,
      headers,
      body: JSON.stringify({ ok: false, error: "Rate limit exceeded. Try again shortly." }),
    };
  }

  // Parse and validate limit
  let limit = DEFAULT_LIMIT;
  const limitParam = event.queryStringParameters?.limit;
  if (limitParam) {
    const parsed = parseInt(limitParam, 10);
    if (!isNaN(parsed) && parsed >= MIN_LIMIT && parsed <= MAX_LIMIT) {
      limit = parsed;
    }
  }

  try {
    const now = Date.now();

    // Check cache
    if (feedCache && feedCache.expiresAt > now) {
      // Return cached data but adjust items to requested limit
      const cachedResponse = { ...feedCache.data };
      cachedResponse.items = cachedResponse.items.slice(0, limit);
      cachedResponse.count = cachedResponse.items.length;
      cachedResponse.sourceInfo.cacheHit = true;
      
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify(cachedResponse),
      };
    }

    // Fetch from Upstash
    const rawItems = await fetchFromUpstash(limit);

    // Score all items
    const scoredItems = scoreFeed(rawItems, limit);

    // Build response
    const response: ScoredFeedResponse = {
      ok: true,
      version: VERSION,
      updatedUTC: new Date().toISOString(),
      sourceInfo: {
        provider: "upstash:pumpwatch:launches",
        cacheHit: false,
        cacheTTL: CACHE_TTL_MS,
        itemsFromUpstash: rawItems.length,
      },
      count: scoredItems.length,
      items: scoredItems,
    };

    // Update cache with full dataset
    const fullScoredItems = scoreFeed(rawItems, MAX_LIMIT);
    feedCache = {
      data: {
        ...response,
        items: fullScoredItems,
        count: fullScoredItems.length,
      },
      expiresAt: now + CACHE_TTL_MS,
    };

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(response),
    };
  } catch (error) {
    console.error("scored-feed error:", error);
    
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        ok: false,
        version: VERSION,
        error: `Failed to fetch feed: ${errorMessage}`,
        items: [],
        count: 0,
      }),
    };
  }
};
