const listEl = document.getElementById("list");
const statusLine = document.getElementById("statusLine");
const searchEl = document.getElementById("search");
const filterEl = document.getElementById("filter");
const sortEl = document.getElementById("sort");
const limitEl = document.getElementById("limit");
const refreshBtn = document.getElementById("refreshBtn");

let RAW = [];

function escapeHtml(s){
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function verdictLabel(v){
  if (v === "clean-ish") return "clean-ish";
  if (v === "caution") return "caution";
  if (v === "high-risk") return "high-risk";
  return "unknown";
}

function passFilter(item){
  const mode = (filterEl?.value || "clean-caution");
  const v = verdictLabel(item.verdict);

  if (mode === "all") return true;
  if (mode === "clean") return v === "clean-ish";
  return v === "clean-ish" || v === "caution";
}

function tokenCard(t, idx){
  const mint = t.mint;
  const pump = t.pumpUrl || (mint ? `https://pump.fun/${mint}` : "#");
  const solscan = mint ? `https://solscan.io/account/${mint}` : "#";

  const score = typeof t.score === "number" ? t.score : 100;
  const verdict = verdictLabel(t.verdict);
  const reasons = Array.isArray(t.reasons) ? t.reasons : [];

  const name = t.name ? String(t.name) : "";
  const symbol = t.symbol ? String(t.symbol) : "";
  const titleLine = name || symbol ? `${name}${symbol ? ` (${symbol})` : ""}` : "—";

  const div = document.createElement("div");
  div.className = "token";
  div.innerHTML = `
    <div class="tokenLeft">
      <div class="rowTop">
        <div class="titleBlock">
          <div class="tokenTitle">${escapeHtml(titleLine)}</div>
          <div class="mint" title="${escapeHtml(mint||"")}">${escapeHtml(mint||"—")}</div>
        </div>
        <div class="badges">
          <span class="scoreBadge" title="Risk score (0 best → 100 worst)">${score}</span>
          <span class="verdictPill v-${escapeHtml(verdict)}">${escapeHtml(verdict)}</span>
        </div>
      </div>

      <div class="meta">
        <span class="tag">seen: ${t.firstSeenUTC ? new Date(t.firstSeenUTC).toUTCString() : "—"}</span>
        <span class="tag">source: ${escapeHtml(t.source || "unknown")}</span>
        ${t.isMayhem === true ? `<span class="tag">mayhem</span>` : ``}
      </div>

      <button class="whyBtn" type="button" data-toggle="${idx}">Why? (signals)</button>
      <div class="whyPanel" id="why-${idx}" hidden>
        <div class="whyTitle">Reasons</div>
        <ul class="whyList">
          ${reasons.map(r => `<li>${escapeHtml(r)}</li>`).join("") || "<li>—</li>"}
        </ul>
      </div>
    </div>

    <div class="links">
      <a href="${escapeHtml(pump)}" target="_blank" rel="noopener">Pump ↗</a>
      <a href="${escapeHtml(solscan)}" target="_blank" rel="noopener">Solscan ↗</a>
      ${mint ? `<a href="#" data-copy="${escapeHtml(mint)}" class="copyLink">Copy</a>` : ``}
    </div>
  `;
  return div;
}

function render(){
  const q = (searchEl.value || "").trim().toLowerCase();
  let items = RAW.slice();

  if (q) {
    items = items.filter(x => {
      const m = (x.mint || "").toLowerCase();
      const n = (x.name || "").toLowerCase();
      const s = (x.symbol || "").toLowerCase();
      return m.includes(q) || n.includes(q) || s.includes(q);
    });
  }

  // Sort
  if (sortEl.value === "alpha") {
    items.sort((a,b) => ((a.symbol||a.name||a.mint||"")+"").localeCompare((b.symbol||b.name||b.mint||"")+""));
  } else {
    items.sort((a,b) => new Date(b.firstSeenUTC || 0) - new Date(a.firstSeenUTC || 0));
  }

  const beforeFilter = items.length;
  const filtered = items.filter(passFilter);
  const hidden = beforeFilter - filtered.length;

  const lim = parseInt(limitEl.value, 10) || 50;
  const shown = filtered.slice(0, lim);

  listEl.innerHTML = "";
  shown.forEach((t, i) => listEl.appendChild(tokenCard(t, i)));

  statusLine.textContent =
    `Showing ${shown.length} / ${beforeFilter} items` +
    (hidden > 0 ? ` (hidden by filter: ${hidden})` : ``) +
    `. Proof-first scoring (v1): payload integrity + on-chain mint authority/freeze checks.`;
}

async function load(){
  statusLine.textContent = "Fetching scored feed…";
  listEl.innerHTML = "";

  const lim = parseInt(limitEl.value, 10) || 50;
  const res = await fetch(`/.netlify/functions/scored-feed?limit=${encodeURIComponent(String(lim))}`, { cache: "no-store" });
  const data = await res.json().catch(() => ({}));

  if (!res.ok || data?.ok === false) {
    statusLine.textContent = `Error: ${data?.error || "failed"}${data?.message ? ` — ${data.message}` : ""}`;
    return;
  }

  RAW = Array.isArray(data.items) ? data.items : [];
  render();
}

document.addEventListener("click", async (e) => {
  const a = e.target.closest(".copyLink");
  if (a) {
    e.preventDefault();
    const mint = a.getAttribute("data-copy");
    try{
      await navigator.clipboard.writeText(mint);
      a.textContent = "Copied";
      setTimeout(() => a.textContent = "Copy", 900);
    }catch{
      alert("Copy failed — copy manually:\n" + mint);
    }
    return;
  }

  const btn = e.target.closest(".whyBtn");
  if (btn) {
    const idx = btn.getAttribute("data-toggle");
    const panel = document.getElementById(`why-${idx}`);
    if (panel) {
      if (panel.hasAttribute("hidden")) panel.removeAttribute("hidden");
      else panel.setAttribute("hidden", "");
    }
  }
});

[searchEl, filterEl, sortEl, limitEl].forEach(el => el && el.addEventListener("input", render));
refreshBtn.addEventListener("click", load);

load();
