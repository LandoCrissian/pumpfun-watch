// VERDICT - Main Analysis Engine
// Orchestrates all modules and produces final verdict

import { runWorthMyTimeModule } from './modules/worthMyTime.js';
import { runFakeMoveModule } from './modules/fakeMove.js';
import { runTooLateModule } from './modules/tooLate.js';
import { runDeadVsSleepingModule } from './modules/deadVsSleeping.js';
import { runHolderPsychologyModule } from './modules/holderPsychology.js';
import { runRugNarrativeModule } from './modules/rugNarrative.js';

// ============================================================================
// TYPES (documented)
// ============================================================================

/**
 * RiskFlag - v2 format with verification status
 * @typedef {Object} RiskFlag
 * @property {string} key - Unique identifier
 * @property {string} label - Human-readable label
 * @property {'warning'|'critical'} severity
 * @property {number} confidence - 0-1
 * @property {'verified'|'unverified'|'stale'|'ambiguous'} status
 * @property {string} evidence - Plain English explanation
 * @property {string} [checkSource] - Where to verify
 */

/**
 * AnalysisResult
 * @typedef {Object} AnalysisResult
 * @property {Object} input - Original input
 * @property {'ENTER'|'WAIT'|'IGNORE'|'EXIT'} verdict
 * @property {'LOW'|'MEDIUM'|'HIGH'} confidence
 * @property {string[]} reasons - 3-5 bullets
 * @property {RiskFlag[]} riskFlags
 * @property {string|null} timingNote
 * @property {'full'|'partial'} dataQuality
 * @property {Object} moduleScores
 * @property {Object} tokenInfo
 */

// ============================================================================
// MODULE WEIGHTS
// ============================================================================

const MODULE_WEIGHTS = {
  worthMyTime: 0.15,
  fakeMove: 0.25,
  tooLate: 0.20,
  deadVsSleeping: 0.10,
  holderPsychology: 0.15,
  rugNarrative: 0.15
};

// ============================================================================
// MAIN ANALYSIS FUNCTION
// ============================================================================

export async function analyzeToken(address, signals) {
  // Run all modules
  const moduleResults = {
    worthMyTime: runWorthMyTimeModule(signals),
    fakeMove: runFakeMoveModule(signals),
    tooLate: runTooLateModule(signals),
    deadVsSleeping: runDeadVsSleepingModule(signals),
    holderPsychology: runHolderPsychologyModule(signals),
    rugNarrative: runRugNarrativeModule(signals)
  };
  
  // Calculate weighted score
  let weightedScore = 0;
  let totalWeight = 0;
  let avgConfidence = 0;
  
  for (const [name, result] of Object.entries(moduleResults)) {
    const weight = MODULE_WEIGHTS[name] || 0.1;
    weightedScore += result.score * weight;
    totalWeight += weight;
    avgConfidence += result.confidence;
  }
  
  weightedScore = weightedScore / totalWeight;
  avgConfidence = avgConfidence / Object.keys(moduleResults).length;
  
  // Collect and deduplicate flags
  const allFlags = collectAndDeduplicateFlags(moduleResults);
  
  // Collect reasons
  const allReasons = collectReasons(moduleResults);
  
  // Determine data quality
  const dataQuality = determineDataQuality(signals);
  
  // Check for pump.fun specific patterns
  const isPumpFun = signals.helius?.metadata?.isPumpFunOrigin || false;
  const isVeryNew = signals.helius?.metadata?.createdAt 
    ? (Date.now() - signals.helius.metadata.createdAt) < 6 * 60 * 60 * 1000 
    : false;
  
  // Cap confidence for very new tokens
  if (isVeryNew) {
    avgConfidence = Math.min(avgConfidence, 0.55);
  }
  
  // Determine verdict
  const { verdict, confidence, timingNote } = determineVerdict(
    weightedScore,
    avgConfidence,
    moduleResults,
    allFlags,
    dataQuality,
    isPumpFun,
    isVeryNew
  );
  
  // Select best reasons (3-5)
  const selectedReasons = selectBestReasons(allReasons, verdict, moduleResults);
  
  // Build token info from signals
  const tokenInfo = buildTokenInfo(signals);
  
  return {
    input: { address },
    verdict,
    confidence,
    reasons: selectedReasons,
    riskFlags: allFlags,
    timingNote,
    dataQuality,
    moduleScores: Object.fromEntries(
      Object.entries(moduleResults).map(([name, result]) => [
        name,
        { score: Math.round(result.score), confidence: result.confidence }
      ])
    ),
    tokenInfo,
    timestamp: Date.now()
  };
}

// ============================================================================
// FLAG COLLECTION & DEDUPLICATION
// ============================================================================

function collectAndDeduplicateFlags(moduleResults) {
  const flagMap = new Map();
  
  // Priority for LP flags - only keep the most relevant one
  const lpFlagPriority = ['lp_unlocked', 'lp_mixed', 'lp_stale', 'lp_unverified', 'lp_unknown'];
  let bestLpFlag = null;
  let bestLpPriority = Infinity;
  
  for (const result of Object.values(moduleResults)) {
    if (!result.flags) continue;
    
    for (const flag of result.flags) {
      // Normalize flag to v2 format if needed
      const normalizedFlag = normalizeFlag(flag);
      
      // Handle LP flags specially - only keep one
      if (normalizedFlag.key.startsWith('lp_')) {
        const priority = lpFlagPriority.indexOf(normalizedFlag.key);
        if (priority !== -1 && priority < bestLpPriority) {
          bestLpPriority = priority;
          bestLpFlag = normalizedFlag;
        }
        continue;
      }
      
      // For other flags, keep highest severity version
      const existing = flagMap.get(normalizedFlag.key);
      if (!existing || 
          (normalizedFlag.severity === 'critical' && existing.severity === 'warning') ||
          (normalizedFlag.confidence > (existing.confidence || 0))) {
        flagMap.set(normalizedFlag.key, normalizedFlag);
      }
    }
  }
  
  // Add best LP flag if exists
  if (bestLpFlag) {
    flagMap.set(bestLpFlag.key, bestLpFlag);
  }
  
  // Sort: critical first, then by confidence
  return Array.from(flagMap.values()).sort((a, b) => {
    if (a.severity === 'critical' && b.severity !== 'critical') return -1;
    if (b.severity === 'critical' && a.severity !== 'critical') return 1;
    return (b.confidence || 0) - (a.confidence || 0);
  });
}

function normalizeFlag(flag) {
  // If already v2 format
  if (typeof flag === 'object' && flag.key && flag.severity) {
    return {
      key: flag.key,
      label: flag.label || formatFlagLabel(flag.key),
      severity: flag.severity,
      confidence: flag.confidence || 0.5,
      status: flag.status || 'unverified',
      evidence: flag.evidence || '',
      checkSource: flag.checkSource || null
    };
  }
  
  // If old string format
  const key = typeof flag === 'string' ? flag : flag.key;
  return {
    key,
    label: formatFlagLabel(key),
    severity: getCriticalFlags().includes(key) ? 'critical' : 'warning',
    confidence: 0.5,
    status: 'unverified',
    evidence: '',
    checkSource: null
  };
}

function formatFlagLabel(key) {
  const labels = {
    'lp_unlocked': 'LP unlocked (verified)',
    'lp_unverified': 'LP lock not verified',
    'lp_mixed': 'Multiple pools — lock mixed',
    'lp_stale': 'LP lock data outdated',
    'lp_unknown': 'LP lock status unknown',
    'whale_dominated': 'Whale dominated',
    'high_concentration': 'High holder concentration',
    'circular_trading': 'Circular trading detected',
    'wash_trading': 'Wash trading suspected',
    'bot_pattern': 'Bot pattern detected',
    'wallet_recycling': 'Wallet recycling detected',
    'shallow_liquidity': 'Shallow liquidity',
    'rug_risk_liquidity': 'Critical liquidity risk',
    'post_pump': 'Already pumped',
    'recent_pump': 'Recent pump',
    'distribution_starting': 'Distribution starting',
    'dev_dumping': 'Dev selling detected',
    'selling_pressure': 'Selling pressure',
    'flipper_heavy': 'High flipper activity',
    'low_volume': 'Low volume',
    'low_holders': 'Few holders',
    'identical_amounts': 'Identical tx amounts',
    'uniform_tx_sizes': 'Uniform tx sizes',
    'phase_transition': 'Phase transition risk',
    'possibly_dead': 'Possibly abandoned',
    'stale_activity': 'Stale activity',
    'dormant': 'Dormant token',
    'concentrated_holdings': 'Concentrated holdings',
    'late_stage_pump': 'Late stage pump',
    'mass_exit': 'Mass exit happening',
    'distribution_phase': 'Distribution phase',
    'whale_dependent': 'Whale dependent',
    'data_unavailable': 'Data unavailable',
    'unverified_activity': 'Activity unverified'
  };
  return labels[key] || key.replace(/_/g, ' ');
}

function getCriticalFlags() {
  return [
    'lp_unlocked',
    'rug_risk_liquidity',
    'circular_trading',
    'wash_trading',
    'whale_dominated',
    'dev_dumping',
    'mass_exit',
    'bot_pattern'
  ];
}

// ============================================================================
// REASON COLLECTION
// ============================================================================

function collectReasons(moduleResults) {
  const reasons = [];
  
  for (const [name, result] of Object.entries(moduleResults)) {
    if (result.reasons) {
      for (const reason of result.reasons) {
        reasons.push({
          text: reason,
          module: name,
          score: result.score,
          confidence: result.confidence
        });
      }
    }
  }
  
  return reasons;
}

function selectBestReasons(allReasons, verdict, moduleResults) {
  // Filter out low-confidence or low-score reasons
  let filtered = allReasons.filter(r => r.confidence >= 0.3);
  
  // Sort by relevance to verdict
  filtered.sort((a, b) => {
    // Prioritize reasons from modules most relevant to verdict
    const aWeight = MODULE_WEIGHTS[a.module] || 0.1;
    const bWeight = MODULE_WEIGHTS[b.module] || 0.1;
    
    // For EXIT, prioritize rug/fakeMove
    if (verdict === 'EXIT') {
      if (a.module === 'rugNarrative' || a.module === 'fakeMove') return -1;
      if (b.module === 'rugNarrative' || b.module === 'fakeMove') return 1;
    }
    
    // For ENTER, prioritize positive signals
    if (verdict === 'ENTER') {
      if (a.score >= 60 && b.score < 60) return -1;
      if (b.score >= 60 && a.score < 60) return 1;
    }
    
    return (b.confidence * bWeight) - (a.confidence * aWeight);
  });
  
  // Take top 3-5 unique reasons
  const selected = [];
  const seen = new Set();
  
  for (const reason of filtered) {
    // Skip duplicates or very similar
    const normalized = reason.text.toLowerCase().slice(0, 30);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    
    selected.push(reason.text);
    if (selected.length >= 5) break;
  }
  
  // Ensure we have at least 3
  if (selected.length < 3) {
    // Add generic reasons based on verdict
    if (verdict === 'ENTER' && selected.length < 3) {
      selected.push('Structural signals look acceptable');
    }
    if (verdict === 'IGNORE' && selected.length < 3) {
      selected.push('Not enough evidence to warrant attention');
    }
    if (verdict === 'WAIT' && selected.length < 3) {
      selected.push('Timing or signal clarity needs improvement');
    }
    if (verdict === 'EXIT' && selected.length < 3) {
      selected.push('Risk signals outweigh potential upside');
    }
  }
  
  return selected.slice(0, 5);
}

// ============================================================================
// VERDICT DETERMINATION
// ============================================================================

function determineVerdict(
  weightedScore,
  avgConfidence,
  moduleResults,
  flags,
  dataQuality,
  isPumpFun,
  isVeryNew
) {
  let verdict = 'IGNORE'; // Default
  let confidence = 'LOW';
  let timingNote = null;
  
  const criticalFlags = flags.filter(f => f.severity === 'critical' && f.status === 'verified');
  const hasCriticalVerifiedRisk = criticalFlags.length > 0;
  
  const fakeMoveScore = moduleResults.fakeMove?.score || 50;
  const tooLateScore = moduleResults.tooLate?.score || 50;
  const rugScore = moduleResults.rugNarrative?.score || 50;
  const holderScore = moduleResults.holderPsychology?.score || 50;
  
  // EXIT conditions (most restrictive first)
  if (hasCriticalVerifiedRisk) {
    verdict = 'EXIT';
    confidence = avgConfidence >= 0.7 ? 'HIGH' : 'MEDIUM';
    timingNote = 'Critical verified risk detected — avoid this token.';
  }
  else if (rugScore < 35) {
    verdict = 'EXIT';
    confidence = avgConfidence >= 0.6 ? 'HIGH' : 'MEDIUM';
    timingNote = 'Rug risk signals too high — exit or avoid.';
  }
  else if (fakeMoveScore < 30 && flags.some(f => ['circular_trading', 'wash_trading', 'bot_pattern'].includes(f.key))) {
    verdict = 'EXIT';
    confidence = 'MEDIUM';
    timingNote = 'Fake volume patterns detected — likely manipulation.';
  }
  // ENTER conditions
  else if (
    weightedScore >= 68 &&
    fakeMoveScore >= 55 &&
    tooLateScore >= 50 &&
    rugScore >= 55 &&
    !flags.some(f => f.severity === 'critical') &&
    dataQuality === 'full'
  ) {
    verdict = 'ENTER';
    confidence = avgConfidence >= 0.7 ? 'HIGH' : avgConfidence >= 0.5 ? 'MEDIUM' : 'LOW';
    
    if (isVeryNew) {
      confidence = 'LOW';
      timingNote = 'Very new token — limited history to verify. Size accordingly.';
    } else if (tooLateScore < 60) {
      timingNote = 'Entry window may be narrowing — watch for distribution signs.';
    }
  }
  // WAIT conditions
  else if (
    weightedScore >= 50 &&
    rugScore >= 45 &&
    (tooLateScore < 55 || fakeMoveScore >= 45)
  ) {
    verdict = 'WAIT';
    confidence = avgConfidence >= 0.6 ? 'MEDIUM' : 'LOW';
    
    if (tooLateScore < 50) {
      timingNote = 'Already moved significantly — wait for pullback or confirmation.';
    } else if (fakeMoveScore < 55) {
      timingNote = 'Some volume patterns unclear — monitor for organic confirmation.';
    } else if (isVeryNew) {
      timingNote = 'Too early to assess reliably — check back in a few hours.';
    } else {
      timingNote = 'Mixed signals — wait for clearer setup.';
    }
  }
  // IGNORE (default)
  else {
    verdict = 'IGNORE';
    confidence = avgConfidence >= 0.6 ? 'MEDIUM' : 'LOW';
    
    if (weightedScore < 40) {
      timingNote = 'Insufficient quality signals — not worth your attention.';
    } else if (flags.length > 4) {
      timingNote = 'Too many risk flags to justify attention.';
    }
  }
  
  // Adjust confidence based on data quality
  if (dataQuality === 'partial' && confidence === 'HIGH') {
    confidence = 'MEDIUM';
  }
  
  // Pump.fun specific adjustments
  if (isPumpFun && isVeryNew && verdict === 'ENTER') {
    // Be extra cautious with very new pump.fun tokens
    if (confidence === 'HIGH') confidence = 'MEDIUM';
    timingNote = timingNote || 'New pump.fun token — high volatility expected.';
  }
  
  return { verdict, confidence, timingNote };
}

// ============================================================================
// DATA QUALITY
// ============================================================================

function determineDataQuality(signals) {
  let score = 0;
  let total = 0;
  
  // Helius data
  total += 3;
  if (signals.helius?.success !== false) {
    score += 1;
    if (signals.helius?.tokenInfo) score += 1;
    if (signals.helius?.holderDistribution) score += 1;
  }
  
  // DexScreener data
  total += 2;
  if (signals.dexscreener?.success) {
    score += 1;
    if (signals.dexscreener?.lpLock) score += 1;
  }
  
  return score >= total * 0.7 ? 'full' : 'partial';
}

// ============================================================================
// TOKEN INFO BUILDER
// ============================================================================

function buildTokenInfo(signals) {
  const helius = signals.helius || {};
  const metadata = helius.metadata || {};
  const tokenInfo = helius.tokenInfo || {};
  
  return {
    symbol: metadata.symbol || null,
    name: metadata.name || null,
    holders: tokenInfo.holders || null,
    liquidity: tokenInfo.liquidity || null,
    volume24h: tokenInfo.volume24h || null,
    isPumpFunOrigin: metadata.isPumpFunOrigin || false,
    createdAt: metadata.createdAt || null
  };
}
