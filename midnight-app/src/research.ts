/**
 * Web research for Sealed Desk agents.
 *
 * Agents ground their valuations in live public market data — fetched from
 * this machine, cached to disk, and summarised into memory. Only PUBLIC data
 * ever comes in; nothing about the agent's budget, valuation, or bids ever
 * goes out. Offline-tolerant: if the network is down, agents fall back to the
 * last cached observation and say so in their reasoning.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const CACHE_FILE = path.resolve(process.cwd(), '.sealed-research.json');

export interface MarketSignal {
  /** e.g. "bitcoin", used as the volatile benchmark asset. */
  source: string;
  priceUsd: number;
  /** Percent move since the previous observation (0 when unknown). */
  driftPct: number;
  /** 'live' or 'cache' — agents disclose which they reasoned from. */
  provenance: 'live' | 'cache';
  at: number;
}

interface ResearchCache {
  last?: MarketSignal;
  history: Array<{ priceUsd: number; at: number }>;
}

function loadCache(): ResearchCache {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    return { history: [] };
  }
}

function saveCache(cache: ResearchCache): void {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

/**
 * Observe the public market. One benchmark price is enough for the demo: the
 * agents use its LEVEL to anchor valuations and its DRIFT as a sentiment
 * proxy ("the tape is heavy today").
 */
export async function observeMarket(): Promise<MarketSignal> {
  const cache = loadCache();
  try {
    const res = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd',
      { signal: AbortSignal.timeout(5000) },
    );
    const body: any = await res.json();
    const priceUsd = Number(body?.bitcoin?.usd);
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) throw new Error('bad payload');
    const prev = cache.history[cache.history.length - 1];
    const driftPct = prev ? ((priceUsd - prev.priceUsd) / prev.priceUsd) * 100 : 0;
    const signal: MarketSignal = { source: 'bitcoin', priceUsd, driftPct, provenance: 'live', at: Date.now() };
    cache.history = [...cache.history.slice(-49), { priceUsd, at: signal.at }];
    cache.last = signal;
    saveCache(cache);
    return signal;
  } catch {
    if (cache.last) return { ...cache.last, provenance: 'cache' };
    // Never observed anything: a stable, clearly-synthetic anchor.
    return { source: 'bitcoin', priceUsd: 60_000, driftPct: 0, provenance: 'cache', at: Date.now() };
  }
}

/** One-line summary an agent can quote in its reasoning feed. */
export function describeSignal(s: MarketSignal): string {
  const tone = s.driftPct > 0.05 ? 'tape is firm' : s.driftPct < -0.05 ? 'tape is heavy' : 'tape is quiet';
  const src = s.provenance === 'live' ? 'live' : 'cached';
  return `benchmark ${s.priceUsd.toLocaleString()} (${src}), drift ${s.driftPct >= 0 ? '+' : ''}${s.driftPct.toFixed(2)}% — ${tone}`;
}
