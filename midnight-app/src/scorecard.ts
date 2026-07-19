/**
 * Agent scorecards — how your own agents are actually doing.
 *
 * There is no settlement layer and no stake: this contract proves who forecast
 * closest, it does not move funds. So a scorecard here is accuracy, not profit.
 * Everything below is derived from data that really exists — the forecast the
 * agent sealed (private, local), the outcome the oracle resolved, and whether
 * the chain crowned it champion. Nothing is simulated.
 *
 * Persisted so a record survives across markets and across restarts.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface MarketResult {
  at: number;
  market: string;      // contract address
  question: string;
  forecast: number;    // what the agent sealed, 1..100
  outcome: number;     // what the oracle resolved
  distance: number;    // |forecast - outcome| — lower is better
  won: boolean;        // crowned champion on-chain
  field: number;       // how many agents were at the table
}

export interface AgentRecord {
  markets: number;
  wins: number;
  winRate: number;      // 0..1
  avgDistance: number;  // mean |forecast - outcome|
  bestDistance: number; // closest call to date
  lastResult: MarketResult | null;
  results: MarketResult[]; // newest first, capped
}

interface Store {
  results: Record<string, MarketResult[]>; // agent name -> results, newest first
}

const FILE = path.resolve(process.cwd(), '.sealed-scorecard.json');
const CAP = 40;

function load(): Store {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return { results: {} };
  }
}

function save(store: Store): void {
  fs.writeFileSync(FILE, JSON.stringify(store, null, 2));
}

/** Record one settled market for one agent. Ignores duplicates. */
export function recordResult(agent: string, result: MarketResult): void {
  const store = load();
  const list = store.results[agent] ?? [];
  if (list.some((r) => r.market === result.market)) return; // already scored
  store.results[agent] = [result, ...list].slice(0, CAP);
  save(store);
}

export function agentRecord(agent: string): AgentRecord {
  const results = load().results[agent] ?? [];
  if (results.length === 0) {
    return { markets: 0, wins: 0, winRate: 0, avgDistance: 0, bestDistance: 0, lastResult: null, results: [] };
  }
  const wins = results.filter((r) => r.won).length;
  const distances = results.map((r) => r.distance);
  return {
    markets: results.length,
    wins,
    winRate: wins / results.length,
    avgDistance: Math.round((distances.reduce((a, b) => a + b, 0) / distances.length) * 10) / 10,
    bestDistance: Math.min(...distances),
    lastResult: results[0],
    results,
  };
}

/** Leaderboard across every agent that has settled at least one market. */
export function standings(): Array<{ agent: string } & AgentRecord> {
  return Object.keys(load().results)
    .map((agent) => ({ agent, ...agentRecord(agent) }))
    .sort((a, b) => b.wins - a.wins || a.avgDistance - b.avgDistance);
}
