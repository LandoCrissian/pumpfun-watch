const listEl = document.getElementById("list");
const statusLine = document.getElementById("statusLine");
const searchEl = document.getElementById("search");
const sortEl = document.getElementById("sort");
const limitEl = document.getElementById("limit");
const refreshBtn = document.getElementById("refreshBtn");

let RAW = [];

function short(a){
  if(!a) return "—";
  return a.length > 12 ? `${a.slice(0,6)}…${a.slice(-4)}` : a;
}

function tokenCard(t){
  const mint = t.mint;
  const pump = t.pumpUrl;
  const solscan = `https://solscan.io/account/${mint}`;

  const div = document.createElement("div");
  div.className = "token";
  div.innerHTML = `
    <div class="tokenLeft">
      <div class="mint" title="${mint}">${mint}</div>
      <div class="meta">
        <span class="tag">seen: ${new Date(t.firstSeenUTC).toUTCString()}</span>
        <span class="tag">source: ${t.source}</span>
      </div>
    </div>
    <div class="links">
      <a href="${pump}" target="_blank" rel="noopener">Pump ↗</a>
      <a href="${solscan}" target="_blank" rel="noopener">Solscan ↗</a>
      <a href="#" data-copy="${mint}" class="copyLink">Copy</a>
    </div>
  `;
  return div;
}

function render(){
  const q = (searchEl.value || "").trim().toLowerCase();
  let items = RAW.slice();

  if (q) items = items.filter(x => (x.mint || "").toLowerCase().includes(q));

  if (sortEl.value === "alpha") items.sort((a,b) => (a.mint||"").localeCompare(b.mint||""));
  else items.sort((a,b) => new Date(b.firstSeenUTC) - new Date(a.firstSeenUTC));

  const lim = parseInt(limitEl.value, 10) || 50;
  items = items.slice(0, lim);

  listEl.innerHTML = "";
  items.forEach(t => listEl.appendChild(tokenCard(t)));

  statusLine.textContent = `Showing ${items.length} / ${RAW.length} items. (MVP raw feed — scoring/filtering next.)`;
}

async function load(){
  statusLine.textContent = "Fetching from Pump.fun…";
  listEl.innerHTML = "";

  const res = await fetch("/.netlify/functions/pumpfun-new", { cache: "no-store" });
  const data = await res.json();

  if (!res.ok) {
    statusLine.textContent = `Error: ${data?.error || "failed"}`;
    return;
  }

  RAW = Array.isArray(data.items) ? data.items : [];
  render();
}

document.addEventListener("click", async (e) => {
  const a = e.target.closest(".copyLink");
  if (!a) return;
  e.preventDefault();
  const mint = a.getAttribute("data-copy");
  try{
    await navigator.clipboard.writeText(mint);
    a.textContent = "Copied";
    setTimeout(() => a.textContent = "Copy", 900);
  }catch{
    alert("Copy failed — copy manually:\n" + mint);
  }
});

[searchEl, sortEl, limitEl].forEach(el => el.addEventListener("input", render));
refreshBtn.addEventListener("click", load);

load();
