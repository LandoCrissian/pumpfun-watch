// netlify/functions/get-pump-feed.ts
// Returns latest Pump launches stored in Upstash

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL!;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN!;
const KEY_LAUNCHES = "pumpwatch:launches";

function j(statusCode: number, body: any) {
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

export async function handler(event: any) {
  try {
    const q = event.queryStringParameters || {};
    const limit = Math.max(1, Math.min(200, parseInt(q.limit || "50", 10) || 50));

    const r = await redis(["lrange", KEY_LAUNCHES, "0", String(limit - 1)]);
    const rows: string[] = Array.isArray(r?.result) ? r.result : [];
    const items = rows.map(s => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);

    return j(200, { ok: true, updatedUTC: new Date().toISOString(), count: items.length, items });
  } catch (e: any) {
    return j(500, { ok: false, error: String(e?.message || e) });
  }
}
