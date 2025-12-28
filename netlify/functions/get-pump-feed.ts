// netlify/functions/get-pump-feed.ts
// UI reads latest stored Pump launches from Upstash

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL!;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN!;

const KEY_LAUNCHES = "pumpwatch:launches";

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

function json(statusCode: number, body: any) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify(body),
  };
}

export async function handler(event: any) {
  try {
    const q = event.queryStringParameters || {};
    const limit = Math.max(1, Math.min(200, parseInt(q.limit || "50", 10) || 50));

    const r = await redis(["lrange", KEY_LAUNCHES, "0", String(limit - 1)]);
    const items = Array.isArray(r?.result) ? r.result : [];

    const launches = items
      .map((s: string) => { try { return JSON.parse(s); } catch { return null; } })
      .filter(Boolean);

    return json(200, { ok: true, updatedUTC: new Date().toISOString(), launches });
  } catch (e: any) {
    return json(500, { ok: false, error: "feed_error", message: String(e?.message || e) });
  }
}
