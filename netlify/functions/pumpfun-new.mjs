export default async () => {
  try {
    const PUMP_NEW_URL = "https://pump.fun/";

    const r = await fetch(PUMP_NEW_URL, {
      headers: {
        // Keep it very “browser-like”
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
        "accept":
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
        "cache-control": "no-cache",
        "pragma": "no-cache",
      },
    });

    if (!r.ok) return json(502, { error: `Pump fetch failed: ${r.status}` });

    const html = await r.text();

    // If pump serves a “shell” with basically no content, we’ll detect it
    const looksEmptyShell =
      html.length < 5000 || (!html.includes("pump") && !html.includes("__NEXT") && !html.includes("react"));

    // Base58-ish Solana pubkey regex (32-44 chars)
    const base58Re = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;

    // Common embedded fields that sometimes contain mints
    const mintFieldRe = /"mint"\s*:\s*"([1-9A-HJ-NP-Za-km-z]{32,44})"/g;
    const addressFieldRe = /"address"\s*:\s*"([1-9A-HJ-NP-Za-km-z]{32,44})"/g;

    const mintsFromFields = [];
    for (const m of html.matchAll(mintFieldRe)) mintsFromFields.push(m[1]);
    for (const m of html.matchAll(addressFieldRe)) mintsFromFields.push(m[1]);

    const allKeys = html.match(base58Re) || [];

    const unique = (arr) => [...new Set(arr)];
    const mints = unique([...mintsFromFields, ...allKeys]).slice(0, 200);

    // If we got basically nothing, return a helpful note (don’t break UI)
    if (mints.length < 5) {
      return json(200, {
        updatedUTC: new Date().toISOString(),
        count: 0,
        items: [],
        note: looksEmptyShell
          ? "Pump.fun returned a client-side shell (no mints in HTML). Next step: switch to their underlying JSON/api endpoint if available."
          : "Pump.fun HTML fetched, but we couldn’t extract enough mints. Markup likely changed.",
        debug: {
          htmlBytes: html.length,
          extractedMints: mints.length,
        },
      });
    }

    const items = mints.map((mint) => ({
      mint,
      pumpUrl: `https://pump.fun/${mint}`,
      firstSeenUTC: new Date().toISOString(),
      source: mintsFromFields.includes(mint) ? "embedded-json" : "html-fallback",
    }));

    return json(200, {
      updatedUTC: new Date().toISOString(),
      count: items.length,
      items,
      note:
        "MVP feed. Next we enrich each mint on-chain + apply scam filters (bundles/snipers/concentration).",
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
