// VERDICT - Main Application
// Solana + pump.fun focused token analysis

import { fetchHeliusData } from './adapters/helius.js';
import { fetchDexScreenerData } from './adapters/dexscreener.js';
import { fetchOpportunityPool, getPoolCacheAge } from './adapters/pumpfun.js';
import { analyzeToken } from './analysis/analyze.js';

// ============================================================================
// STATE
// ============================================================================

const state = {
  view: 'home', // 'home' | 'loading' | 'result'
  tokenAddress: '',
  result: null,
  error: null,
  recentAnalyses: [],
  opportunityPool: [],
  poolLoading: false,
  poolLastRefresh: null,
  currentAnalysisController: null
};

// ============================================================================
// CONSTANTS
// ============================================================================

const RECENT_STORAGE_KEY = 'verdict_recent';
const MAX_RECENT = 5;
const POOL_REFRESH_INTERVAL = 10 * 60 * 1000; // 10 minutes

// ============================================================================
// UTILITIES
// ============================================================================

function isValidSolanaMint(address) {
  // Solana addresses are base58 encoded, 32-44 chars
  if (!address || typeof address !== 'string') return false;
  const trimmed = address.trim();
  if (trimmed.length < 32 || trimmed.length > 44) return false;
  // Base58 character set (no 0, O, I, l)
  const base58Regex = /^[1-9A-HJ-NP-Za-km-z]+$/;
  return base58Regex.test(trimmed);
}

function truncateAddress(address, chars = 4) {
  if (!address || address.length < chars * 2 + 3) return address;
  return `${address.slice(0, chars)}...${address.slice(-chars)}`;
}

function formatTimeAgo(timestamp) {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function getPhaseLabel(phase) {
  const labels = {
    'early-accumulation': 'Early Accumulation',
    'clean-momentum': 'Clean Momentum',
    'dormant-revival': 'Dormant Revival',
    'fresh-buyers': 'Fresh Buyers'
  };
  return labels[phase] || phase;
}

function getFlagMeaning(key) {
  const meanings = {
    'lp_unlocked': 'Liquidity pool tokens are not locked, meaning the deployer could remove liquidity at any time.',
    'lp_unverified': 'We could not verify whether the LP is locked. This doesn\'t mean it\'s unlocked — just unconfirmed.',
    'lp_mixed': 'This token has multiple liquidity pools with different lock statuses.',
    'lp_stale': 'LP lock data is outdated and may have changed since last check.',
    'lp_unknown': 'Could not retrieve any LP lock information from available sources.',
    'whale_dominated': 'A small number of wallets control most of the supply, increasing dump risk.',
    'high_concentration': 'Top holders own a significant portion of supply.',
    'circular_trading': 'Detected patterns suggesting tokens are being traded between related wallets.',
    'wash_trading': 'Trading volume appears artificially inflated through coordinated activity.',
    'bot_pattern': 'Transaction patterns suggest automated bot activity rather than organic trading.',
    'wallet_recycling': 'Same wallets appear multiple times, suggesting coordinated or fake activity.',
    'shallow_liquidity': 'Limited liquidity depth means larger trades will have significant price impact.',
    'rug_risk_liquidity': 'Extremely low liquidity makes it nearly impossible to exit positions.',
    'post_pump': 'Token has already experienced a significant price increase.',
    'distribution_starting': 'Selling activity increasing — early holders may be exiting.',
    'dev_dumping': 'Developer or team wallets appear to be selling.',
    'selling_pressure': 'More unique sellers than buyers in recent activity.',
    'flipper_heavy': 'High turnover suggests traders are flipping quickly rather than holding.',
    'low_volume': 'Very low trading volume may indicate lack of interest or liquidity.',
    'low_holders': 'Few unique holders increases concentration risk.',
    'identical_amounts': 'Many transactions of identical size suggest bot or coordinated activity.',
    'uniform_tx_sizes': 'Lack of transaction size variance suggests inorganic trading.',
    'phase_transition': 'Token is transitioning between phases (e.g., bonding curve to DEX).',
    'possibly_dead': 'Very low activity and liquidity suggest the token may be abandoned.',
    'stale_activity': 'No recent on-chain activity detected.',
    'dormant': 'Token has been inactive for an extended period.'
  };
  return meanings[key] || 'This flag indicates a potential risk factor.';
}

function getFlagCheckSource(key) {
  const sources = {
    'lp_unlocked': 'Verify on DexScreener → Token page → Info section, or check the locker contract directly on Solscan.',
    'lp_unverified': 'Check DexScreener or look for locker contract interactions on Solscan.',
    'lp_mixed': 'Check each pool individually on DexScreener to understand the full picture.',
    'lp_stale': 'Refresh DexScreener data or check locker contract on Solscan for current status.',
    'lp_unknown': 'Search for the token on DexScreener or check Solscan for locker transactions.',
    'whale_dominated': 'View holder distribution on Solscan → Holders tab.',
    'high_concentration': 'Check holder list on Solscan or Birdeye.',
    'circular_trading': 'Analyze recent transactions on Solscan for wallet relationships.',
    'wash_trading': 'Compare unique wallets vs transaction count on Solscan.',
    'bot_pattern': 'Look for identical timing/amounts in recent transactions.',
    'wallet_recycling': 'Check if buyer addresses have previous sells of same token.',
    'shallow_liquidity': 'Check pool depth on Raydium, Orca, or DexScreener.',
    'rug_risk_liquidity': 'Verify total liquidity across all pools on DexScreener.',
    'post_pump': 'Check price chart history on DexScreener or Birdeye.',
    'distribution_starting': 'Compare buyer vs seller counts in recent transactions.',
    'dev_dumping': 'Track deployer wallet on Solscan for recent sells.',
    'selling_pressure': 'View recent transactions categorized by buy/sell.',
    'flipper_heavy': 'Check average hold time if available on analytics platforms.',
    'low_volume': 'Verify 24h volume on DexScreener or Birdeye.',
    'low_holders': 'Check holder count on Solscan → Holders tab.',
    'identical_amounts': 'Review transaction amounts in recent history.',
    'uniform_tx_sizes': 'Analyze transaction size distribution in explorer.',
    'phase_transition': 'Check if token recently migrated from pump.fun to Raydium.',
    'possibly_dead': 'Look for any recent activity on Solscan.',
    'stale_activity': 'Check last transaction timestamp on Solscan.',
    'dormant': 'Review transaction history timeline.'
  };
  return sources[key] || 'Check DexScreener, Birdeye, or Solscan for more details.';
}

// ============================================================================
// LOCAL STORAGE
// ============================================================================

function loadRecentAnalyses() {
  try {
    const stored = localStorage.getItem(RECENT_STORAGE_KEY);
    if (stored) {
      state.recentAnalyses = JSON.parse(stored);
    }
  } catch (e) {
    console.warn('Failed to load recent analyses:', e);
    state.recentAnalyses = [];
  }
}

function saveRecentAnalysis(result) {
  const entry = {
    address: result.input.address,
    symbol: result.tokenInfo?.symbol || truncateAddress(result.input.address),
    verdict: result.verdict,
    confidence: result.confidence,
    timestamp: Date.now()
  };
  
  // Remove duplicate if exists
  state.recentAnalyses = state.recentAnalyses.filter(
    r => r.address !== entry.address
  );
  
  // Add to front
  state.recentAnalyses.unshift(entry);
  
  // Limit size
  state.recentAnalyses = state.recentAnalyses.slice(0, MAX_RECENT);
  
  // Persist
  try {
    localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(state.recentAnalyses));
  } catch (e) {
    console.warn('Failed to save recent analyses:', e);
  }
}

// ============================================================================
// BOTTOM SHEET
// ============================================================================

function openBottomSheet(content) {
  const overlay = document.getElementById('bottom-sheet-overlay');
  const sheet = document.getElementById('bottom-sheet');
  const contentEl = document.getElementById('bottom-sheet-content');
  
  contentEl.innerHTML = content;
  overlay.classList.remove('hidden');
  
  requestAnimationFrame(() => {
    overlay.classList.add('open');
    sheet.classList.add('open');
  });
  
  // Close handlers
  overlay.onclick = closeBottomSheet;
  
  // Swipe to close
  let startY = 0;
  sheet.ontouchstart = (e) => {
    startY = e.touches[0].clientY;
  };
  sheet.ontouchmove = (e) => {
    const deltaY = e.touches[0].clientY - startY;
    if (deltaY > 50) {
      closeBottomSheet();
    }
  };
}

function closeBottomSheet() {
  const overlay = document.getElementById('bottom-sheet-overlay');
  const sheet = document.getElementById('bottom-sheet');
  
  overlay.classList.remove('open');
  sheet.classList.remove('open');
  
  setTimeout(() => {
    overlay.classList.add('hidden');
  }, 300);
}

function showRiskFlagDetails(flag) {
  const statusColors = {
    verified: 'status-verified',
    unverified: 'status-unverified',
    stale: 'status-stale',
    ambiguous: 'status-ambiguous'
  };
  
  const statusLabels = {
    verified: 'Verified',
    unverified: 'Unverified',
    stale: 'Stale Data',
    ambiguous: 'Ambiguous'
  };
  
  const content = `
    <div class="space-y-4">
      <div class="flex items-center gap-3">
        <div class="w-10 h-10 rounded-full flex items-center justify-center ${
          flag.severity === 'critical' ? 'bg-red-500/20' : 'bg-amber-500/20'
        }">
          <svg class="w-5 h-5 ${flag.severity === 'critical' ? 'text-red-400' : 'text-amber-400'}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
          </svg>
        </div>
        <div>
          <h3 class="font-semibold text-lg">${flag.label || flag.key.replace(/_/g, ' ')}</h3>
          <div class="flex items-center gap-2 mt-1">
            <span class="text-xs px-2 py-0.5 rounded-full ${flag.severity === 'critical' ? 'severity-critical' : 'severity-warning'}">
              ${flag.severity.toUpperCase()}
            </span>
            <span class="text-xs px-2 py-0.5 rounded-full bg-neutral-800 ${statusColors[flag.status] || 'text-neutral-400'}">
              ${statusLabels[flag.status] || flag.status}
            </span>
            ${flag.confidence ? `
              <span class="text-xs text-neutral-500">
                ${Math.round(flag.confidence * 100)}% confidence
              </span>
            ` : ''}
          </div>
        </div>
      </div>
      
      <div class="space-y-3 text-sm">
        <div>
          <div class="text-neutral-500 text-xs uppercase tracking-wide mb-1">What this means</div>
          <p class="text-neutral-300">${getFlagMeaning(flag.key)}</p>
        </div>
        
        ${flag.evidence ? `
          <div>
            <div class="text-neutral-500 text-xs uppercase tracking-wide mb-1">Evidence</div>
            <p class="text-neutral-300">${flag.evidence}</p>
          </div>
        ` : ''}
        
        <div>
          <div class="text-neutral-500 text-xs uppercase tracking-wide mb-1">How to verify</div>
          <p class="text-neutral-400">${flag.checkSource || getFlagCheckSource(flag.key)}</p>
        </div>
      </div>
      
      <button onclick="closeBottomSheet()" class="w-full py-3 bg-neutral-800 rounded-xl font-medium tap-feedback mt-2">
        Got it
      </button>
    </div>
  `;
  
  openBottomSheet(content);
}

// Make closeBottomSheet available globally for onclick
window.closeBottomSheet = closeBottomSheet;

// ============================================================================
// TOAST
// ============================================================================

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  
  const bgColor = type === 'error' ? 'bg-red-900/90' : 
                  type === 'success' ? 'bg-green-900/90' : 'bg-neutral-800/90';
  
  toast.className = `toast px-4 py-3 rounded-xl ${bgColor} backdrop-blur text-sm font-medium shadow-lg`;
  toast.textContent = message;
  
  container.appendChild(toast);
  
  setTimeout(() => {
    toast.remove();
  }, 2500);
}

// ============================================================================
// OPPORTUNITY POOL
// ============================================================================

async function loadOpportunityPool(forceRefresh = false) {
  if (state.poolLoading) return;
  
  state.poolLoading = true;
  render();
  
  try {
    const pool = await fetchOpportunityPool(forceRefresh);
    state.opportunityPool = pool;
    state.poolLastRefresh = Date.now();
  } catch (e) {
    console.error('Failed to load opportunity pool:', e);
  } finally {
    state.poolLoading = false;
    render();
  }
}

function startPoolRefreshTimer() {
  setInterval(() => {
    if (state.view === 'home' && !state.poolLoading) {
      loadOpportunityPool(true);
    }
  }, POOL_REFRESH_INTERVAL);
}

// ============================================================================
// ANALYSIS
// ============================================================================

async function runAnalysis(address) {
  // Cancel any pending analysis
  if (state.currentAnalysisController) {
    state.currentAnalysisController.abort();
  }
  
  state.currentAnalysisController = new AbortController();
  
  // Validate
  const trimmed = address.trim();
  if (!isValidSolanaMint(trimmed)) {
    state.error = 'Please enter a valid Solana token address';
    state.view = 'home';
    render();
    showToast('Invalid Solana address', 'error');
    return;
  }
  
  state.tokenAddress = trimmed;
  state.view = 'loading';
  state.error = null;
  state.result = null;
  render();
  
  try {
    // Fetch signals in parallel
    const [heliusData, dexscreenerData] = await Promise.all([
      fetchHeliusData(trimmed),
      fetchDexScreenerData(trimmed)
    ]);
    
    // Check if aborted
    if (state.currentAnalysisController.signal.aborted) return;
    
    // Run analysis
    const signals = {
      helius: heliusData,
      dexscreener: dexscreenerData
    };
    
    const result = await analyzeToken(trimmed, signals);
    
    // Check if aborted
    if (state.currentAnalysisController.signal.aborted) return;
    
    state.result = result;
    state.view = 'result';
    
    // Save to recent
    saveRecentAnalysis(result);
    
  } catch (e) {
    if (e.name === 'AbortError') return;
    console.error('Analysis failed:', e);
    state.error = 'Analysis failed. Please try again.';
    state.view = 'home';
    showToast('Analysis failed', 'error');
  }
  
  render();
}

// ============================================================================
// ACTIONS
// ============================================================================

function copyToClipboard(text) {
  navigator.clipboard.writeText(text).then(() => {
    showToast('Copied to clipboard', 'success');
  }).catch(() => {
    showToast('Failed to copy', 'error');
  });
}

function shareResult() {
  if (!state.result) return;
  
  const r = state.result;
  const text = `VERDICT: ${r.verdict} (${r.confidence} confidence)

${r.tokenInfo?.symbol || truncateAddress(r.input.address)}

Why:
${r.reasons.map(reason => `• ${reason}`).join('\n')}

${r.riskFlags.length > 0 ? `Risks: ${r.riskFlags.map(f => f.label || f.key).join(', ')}` : ''}

Analyzed with VERDICT`;
  
  if (navigator.share) {
    navigator.share({
      title: `VERDICT: ${r.verdict}`,
      text: text
    }).catch(() => {});
  } else {
    copyToClipboard(text);
  }
}

function copySummary() {
  if (!state.result) return;
  
  const r = state.result;
  const text = `${r.verdict} (${r.confidence}) - ${r.tokenInfo?.symbol || truncateAddress(r.input.address)}
${r.reasons.slice(0, 3).join(' | ')}`;
  
  copyToClipboard(text);
}

function newAnalysis() {
  state.view = 'home';
  state.result = null;
  state.error = null;
  state.tokenAddress = '';
  render();
}

function analyzeOpportunity(mint) {
  const input = document.getElementById('token-input');
  if (input) {
    input.value = mint;
  }
  state.tokenAddress = mint;
  runAnalysis(mint);
}

// Make functions globally available
window.analyzeOpportunity = analyzeOpportunity;
window.showRiskFlagDetails = showRiskFlagDetails;

// ============================================================================
// RENDER FUNCTIONS
// ============================================================================

function renderHome() {
  const poolAgeMinutes = state.poolLastRefresh 
    ? Math.floor((Date.now() - state.poolLastRefresh) / 60000) 
    : null;
  
  return `
    <div class="min-h-screen flex flex-col safe-bottom">
      <!-- Header -->
      <header class="pt-12 pb-6 px-5">
        <h1 class="text-3xl font-bold tracking-tight">VERDICT</h1>
        <p class="text-neutral-500 text-sm mt-1">Solana • pump.fun trenches</p>
      </header>
      
      <!-- Input Section -->
      <div class="px-5 mb-6">
        <div class="bg-neutral-900 rounded-2xl p-4">
          <input
            type="text"
            id="token-input"
            placeholder="Paste Solana token address..."
            value="${state.tokenAddress}"
            class="w-full bg-transparent text-lg font-medium placeholder:text-neutral-600 outline-none mono"
            autocomplete="off"
            autocorrect="off"
            autocapitalize="off"
            spellcheck="false"
          />
        </div>
        
        <button
          id="analyze-btn"
          class="w-full mt-3 py-4 bg-white text-black font-semibold rounded-2xl tap-feedback text-lg disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Analyze
        </button>
        
        ${state.error ? `
          <p class="text-red-400 text-sm mt-2 text-center">${state.error}</p>
        ` : ''}
      </div>
      
      <!-- Recent Analyses -->
      ${state.recentAnalyses.length > 0 ? `
        <div class="px-5 mb-6">
          <h2 class="text-sm font-medium text-neutral-500 mb-3">Recent</h2>
          <div class="flex gap-2 overflow-x-auto scrollbar-hide pb-2">
            ${state.recentAnalyses.map(r => `
              <button
                onclick="analyzeOpportunity('${r.address}')"
                class="flex-shrink-0 bg-neutral-900 rounded-xl px-4 py-3 tap-feedback"
              >
                <div class="flex items-center gap-2">
                  <span class="font-medium mono text-sm">${r.symbol}</span>
                  <span class="text-xs px-2 py-0.5 rounded-full verdict-${r.verdict.toLowerCase()}">${r.verdict}</span>
                </div>
                <div class="text-xs text-neutral-500 mt-1">${formatTimeAgo(r.timestamp)}</div>
              </button>
            `).join('')}
          </div>
        </div>
      ` : ''}
      
      <!-- Opportunity Pool -->
      <div class="flex-1 px-5 pb-6">
        <div class="flex items-center justify-between mb-3">
          <div>
            <h2 class="text-sm font-medium text-neutral-500">Opportunities</h2>
            <p class="text-xs text-neutral-600">Worth analyzing — not recommendations</p>
          </div>
          <button
            id="refresh-pool-btn"
            class="p-2 rounded-lg bg-neutral-900 tap-feedback ${state.poolLoading ? 'opacity-50' : ''}"
            ${state.poolLoading ? 'disabled' : ''}
          >
            <svg class="w-4 h-4 text-neutral-400 ${state.poolLoading ? 'refresh-spin' : ''}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
            </svg>
          </button>
        </div>
        
        ${state.poolLoading && state.opportunityPool.length === 0 ? `
          <div class="space-y-2">
            ${[1,2,3,4].map(() => `
              <div class="bg-neutral-900 rounded-xl p-4 skeleton h-20"></div>
            `).join('')}
          </div>
        ` : state.opportunityPool.length > 0 ? `
          <div class="space-y-2">
            ${state.opportunityPool.slice(0, 8).map(token => `
              <div class="opportunity-card bg-neutral-900 rounded-xl p-4">
                <div class="flex items-center justify-between">
                  <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2 mb-2">
                      <span class="font-semibold mono">${token.symbol}</span>
                      <span class="text-xs text-neutral-500">${truncateAddress(token.mint, 3)}</span>
                    </div>
                    <div class="flex flex-wrap gap-1.5">
                      <span class="text-xs px-2 py-0.5 rounded-full phase-${token.phase}">
                        ${getPhaseLabel(token.phase)}
                      </span>
                      <span class="text-xs px-2 py-0.5 rounded-full attention-${token.attention}">
                        ${token.attention === 'low' ? '👀 Low' : '⚡ Med'} attention
                      </span>
                      <span class="text-xs px-2 py-0.5 rounded-full risk-${token.risk}">
                        ${token.risk === 'low' ? '🟢' : token.risk === 'medium' ? '🟡' : '🔴'} Risk
                      </span>
                    </div>
                  </div>
                  <button
                    onclick="analyzeOpportunity('${token.mint}')"
                    class="ml-3 px-4 py-2 bg-neutral-800 rounded-lg font-medium text-sm tap-feedback"
                  >
                    Analyze
                  </button>
                </div>
              </div>
            `).join('')}
          </div>
          ${poolAgeMinutes !== null ? `
            <p class="text-xs text-neutral-600 text-center mt-3">
              Updated ${poolAgeMinutes === 0 ? 'just now' : `${poolAgeMinutes}m ago`}
            </p>
          ` : ''}
        ` : `
          <div class="bg-neutral-900 rounded-xl p-8 text-center">
            <p class="text-neutral-500">No opportunities found</p>
            <button
              onclick="loadOpportunityPool(true)"
              class="mt-3 px-4 py-2 bg-neutral-800 rounded-lg text-sm tap-feedback"
            >
              Refresh
            </button>
          </div>
        `}
      </div>
    </div>
  `;
}

function renderLoading() {
  return `
    <div class="min-h-screen flex flex-col items-center justify-center px-5">
      <div class="w-16 h-16 rounded-2xl bg-neutral-800 flex items-center justify-center mb-6 pulse-ring">
        <svg class="w-8 h-8 text-neutral-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
        </svg>
      </div>
      <p class="text-neutral-400 font-medium">Analyzing token...</p>
      <p class="text-neutral-600 text-sm mt-2 mono">${truncateAddress(state.tokenAddress, 6)}</p>
      
      <div class="mt-8 w-full max-w-xs space-y-3">
        <div class="skeleton h-4 rounded-full w-3/4 mx-auto"></div>
        <div class="skeleton h-4 rounded-full w-1/2 mx-auto"></div>
        <div class="skeleton h-4 rounded-full w-2/3 mx-auto"></div>
      </div>
      
      <button
        onclick="newAnalysis()"
        class="mt-8 px-6 py-3 bg-neutral-800 rounded-xl text-sm font-medium tap-feedback"
      >
        Cancel
      </button>
    </div>
  `;
}

window.newAnalysis = newAnalysis;
window.loadOpportunityPool = loadOpportunityPool;

function renderResult() {
  const r = state.result;
  if (!r) return renderHome();
  
  const verdictClass = `verdict-${r.verdict.toLowerCase()}`;
  const verdictTextClass = `verdict-text-${r.verdict.toLowerCase()}`;
  
  return `
    <div class="min-h-screen flex flex-col safe-bottom slide-up">
      <!-- Header -->
      <header class="pt-8 pb-4 px-5 flex items-center justify-between">
        <button onclick="newAnalysis()" class="p-2 -ml-2 tap-feedback">
          <svg class="w-6 h-6 text-neutral-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/>
          </svg>
        </button>
        <div class="text-center">
          <p class="text-sm text-neutral-500">${r.tokenInfo?.symbol || 'Token'}</p>
          <p class="text-xs text-neutral-600 mono">${truncateAddress(r.input.address, 6)}</p>
        </div>
        <div class="w-10"></div>
      </header>
      
      <!-- Main Verdict -->
      <div class="px-5 py-6">
        <div class="text-center">
          <div class="inline-flex px-8 py-4 rounded-2xl ${verdictClass} mb-4">
            <span class="text-3xl font-bold text-white tracking-wide">${r.verdict}</span>
          </div>
          
          <div class="flex items-center justify-center gap-3 mb-2">
            <span class="px-3 py-1 rounded-full bg-neutral-800 text-sm font-medium">
              ${r.confidence} confidence
            </span>
            <span class="px-3 py-1 rounded-full bg-neutral-800 text-sm text-neutral-400">
              ${r.dataQuality === 'full' ? '✓ Full data' : '⚠ Partial data'}
            </span>
          </div>
        </div>
      </div>
      
      <!-- Why Section -->
      <div class="px-5 mb-6">
        <h3 class="text-sm font-medium text-neutral-500 mb-3">Why</h3>
        <div class="space-y-2">
          ${r.reasons.map(reason => `
            <div class="flex gap-3 items-start">
              <div class="w-1.5 h-1.5 rounded-full ${verdictTextClass} mt-2 flex-shrink-0"></div>
              <p class="text-neutral-200">${reason}</p>
            </div>
          `).join('')}
        </div>
      </div>
      
      <!-- Risk Flags -->
      ${r.riskFlags.length > 0 ? `
        <div class="px-5 mb-6">
          <h3 class="text-sm font-medium text-neutral-500 mb-3">Risk Flags</h3>
          <div class="flex flex-wrap gap-2">
            ${r.riskFlags.map((flag, i) => `
              <button
                onclick="showRiskFlagDetails(${JSON.stringify(flag).replace(/"/g, '&quot;')})"
                class="risk-flag-chip px-3 py-1.5 rounded-full text-sm font-medium flex items-center gap-1.5 ${
                  flag.severity === 'critical' ? 'severity-critical' : 'severity-warning'
                }"
              >
                ${flag.status === 'verified' ? 
                  '<svg class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/></svg>' : 
                  flag.status === 'unverified' ? 
                  '<svg class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clip-rule="evenodd"/></svg>' :
                  '<svg class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clip-rule="evenodd"/></svg>'
                }
                ${flag.label || flag.key.replace(/_/g, ' ')}
              </button>
            `).join('')}
          </div>
        </div>
      ` : ''}
      
      <!-- Timing Note -->
      ${r.timingNote ? `
        <div class="px-5 mb-6">
          <div class="bg-neutral-900 rounded-xl p-4">
            <div class="flex items-start gap-3">
              <svg class="w-5 h-5 text-amber-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/>
              </svg>
              <p class="text-neutral-300 text-sm">${r.timingNote}</p>
            </div>
          </div>
        </div>
      ` : ''}
      
      <!-- Module Scores Toggle -->
      <div class="px-5 mb-6">
        <details class="bg-neutral-900 rounded-xl overflow-hidden">
          <summary class="px-4 py-3 cursor-pointer text-neutral-400 text-sm font-medium flex items-center justify-between">
            <span>Module Scores</span>
            <svg class="w-4 h-4 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/>
            </svg>
          </summary>
          <div class="px-4 pb-4 pt-2 space-y-3">
            ${Object.entries(r.moduleScores).map(([name, data]) => `
              <div>
                <div class="flex justify-between text-sm mb-1">
                  <span class="text-neutral-400">${name.replace(/([A-Z])/g, ' $1').trim()}</span>
                  <span class="font-medium mono">${data.score}/100</span>
                </div>
                <div class="h-1.5 bg-neutral-800 rounded-full overflow-hidden">
                  <div 
                    class="h-full rounded-full ${data.score >= 60 ? 'bg-green-500' : data.score >= 40 ? 'bg-amber-500' : 'bg-red-500'}"
                    style="width: ${data.score}%"
                  ></div>
                </div>
              </div>
            `).join('')}
          </div>
        </details>
      </div>
      
      <!-- Spacer -->
      <div class="flex-1"></div>
      
      <!-- Actions -->
      <div class="px-5 pb-6">
        <div class="grid grid-cols-3 gap-3">
          <button
            onclick="shareResult()"
            class="py-3 bg-neutral-900 rounded-xl font-medium tap-feedback flex flex-col items-center gap-1"
          >
            <svg class="w-5 h-5 text-neutral-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z"/>
            </svg>
            <span class="text-xs text-neutral-400">Share</span>
          </button>
          
          <button
            onclick="copySummary()"
            class="py-3 bg-neutral-900 rounded-xl font-medium tap-feedback flex flex-col items-center gap-1"
          >
            <svg class="w-5 h-5 text-neutral-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/>
            </svg>
            <span class="text-xs text-neutral-400">Copy</span>
          </button>
          
          <button
            onclick="newAnalysis()"
            class="py-3 bg-white text-black rounded-xl font-medium tap-feedback flex flex-col items-center gap-1"
          >
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/>
            </svg>
            <span class="text-xs">New</span>
          </button>
        </div>
      </div>
    </div>
  `;
}

window.shareResult = shareResult;
window.copySummary = copySummary;

// ============================================================================
// MAIN RENDER
// ============================================================================

function render() {
  const app = document.getElementById('app');
  
  switch (state.view) {
    case 'loading':
      app.innerHTML = renderLoading();
      break;
    case 'result':
      app.innerHTML = renderResult();
      break;
    default:
      app.innerHTML = renderHome();
      setupHomeListeners();
  }
}

function setupHomeListeners() {
  const input = document.getElementById('token-input');
  const analyzeBtn = document.getElementById('analyze-btn');
  const refreshBtn = document.getElementById('refresh-pool-btn');
  
  if (input) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        runAnalysis(input.value);
      }
    });
    
    input.addEventListener('input', () => {
      state.tokenAddress = input.value;
    });
  }
  
  if (analyzeBtn) {
    analyzeBtn.addEventListener('click', () => {
      const input = document.getElementById('token-input');
      if (input) {
        runAnalysis(input.value);
      }
    });
  }
  
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      loadOpportunityPool(true);
    });
  }
}

// ============================================================================
// INIT
// ============================================================================

export function initApp() {
  // Load saved data
  loadRecentAnalyses();
  
  // Initial render
  render();
  
  // Load opportunity pool
  loadOpportunityPool();
  
  // Start refresh timer
  startPoolRefreshTimer();
  
  // Register service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(console.warn);
  }
}
