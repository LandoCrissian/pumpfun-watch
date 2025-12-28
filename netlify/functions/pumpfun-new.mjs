export default async (req) => {
  try {
    // Pump.fun URLs vary. If this 404s, swap to the correct "new" page you use.
    // Examples people often use: https://pump.fun/ or https://pump.fun/board or similar.
    const PUMP_NEW_URL = "https://pump.fun/";

    const r = await fetch(PUMP_NEW_URL, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (compatible; JackpotWatch/1.0; +https://jackpotcoin.fun)",
        "accept": "text/html,application/xhtml+xml",
      },
    });

    if (!r.ok) {
      return json(502, { error: `Pump fetch failed: ${r.status}` });
    }

    const html = await r.text();

    // --- Extraction helpers ---
    const unique = (arr) => [...new Set(arr)];

    // Base58-ish Solana pubkey regex (32-44 chars)
    // NOTE: This can catch non-mint addresses too, but it's a good fallback.
    const base58Re = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;

    // 1) Try to find JSON-ish embedded data containing "mint" or "token" fields
    // We keep this simple: look for occurrences of `"mint":"<base58>"`
    const mintFieldRe = /"mint"\s*:\s*"([1-9A-HJ-NP-Za-km-z]{32,44})"/g;
    const mintsFromMintField = [];
    for (const m of html.matchAll(mintFieldRe)) mintsFromMintField.push(m[1]);

    // Sometimes "address" is used
    const addrFieldRe = /"address"\s*:\s*"([1-9A-HJ-NP-Za-km-z]{32,44})"/g;
    const mintsFromAddrField = [];
    for (const m of html.matchAll(addrFieldRe)) mintsFromAddrField.push(m[1]);

    // 2) Fallback: any base58-looking keys
    const allKeys = html.match(base58Re) || [];

    // Combine + de-dupe
    const mints = unique([...mintsFromMintField, ...mintsFromAddrField, ...allKeys]).slice(0, 200);

    // Shape into token items (MVP)
    // Later we enrich with pump metadata, socials, etc.
    const items = mints.map((mint) => ({
      mint,
      pumpUrl: `https://pump.fun/${mint}`,
      firstSeenUTC: new Date().toISOString(),
      source: "pumpfun-scrape",
    }));

    return json(200, {
      updatedUTC: new Date().toISOString(),
      count: items.length,
      items,
      note:
        "MVP scrape: results may include non-mint keys until enrichment/scoring is added. Next step is on-chain verify + filter.",
    });
  } catch (e) {
    return json(500, { error: String(e?.message || e) });
  }
};

function json(statusCode, obj) {
  return new Response(JSON.stringify(obj), {
    status: statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    },
  });
}
