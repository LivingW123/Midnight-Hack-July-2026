/**
 * Sealed Desk — the fully agent-run marketplace.
 *
 * Every participant is an AI agent living on THIS machine: one broker who
 * opens and paces a Dutch exit, and a bench of buyer desks who research the
 * market, form a private valuation, seal it as a reservation, and decide when
 * (or whether) to claim. Their brains, budgets, memories and keys share one
 * trust boundary with the ZK prover — the chain only ever sees proofs.
 *
 * Brains are pluggable:
 *   - ollama    a local LLM (no tokens leave the machine) proposes decisions
 *   - heuristic deterministic persona policies (always available, no deps)
 * Every decision — either brain — lands in the agent's reasoning feed with
 * the evidence it used, and in its persistent memory for the next auction.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { observeMarket, describeSignal, type MarketSignal } from './research';
import { allSettlements } from './intel';

// ─── Personas ──────────────────────────────────────────────────────────────────

export type AgentRole = 'broker' | 'buyer';

export interface AgentSpec {
  name: string;
  role: AgentRole;
  persona: string;      // one line, shown on the desk card
  /** Buyer: multiple of the anchor unit price they can justify at neutral tape. */
  conviction: number;   // 0.6 (cheap) .. 1.3 (aggressive)
  /** How long they let the clock run before acting. 0 = jumpy, 1 = glacial. */
  patience: number;
  budgetCap: bigint;    // hard ceiling, never exceeded
}

export const DESK_AGENTS: AgentSpec[] = [
  { name: 'maren', role: 'broker', persona: 'the broker — paces the exit, hates a stale tape', conviction: 1, patience: 0.4, budgetCap: 0n },
  { name: 'castor', role: 'buyer', persona: 'value desk — buys weakness, never chases', conviction: 0.78, patience: 0.85, budgetCap: 1_400_000n },
  { name: 'wren', role: 'buyer', persona: 'momentum desk — pays up when the tape is firm', conviction: 1.12, patience: 0.3, budgetCap: 2_600_000n },
  { name: 'ibis', role: 'buyer', persona: 'index desk — mechanical, mid-market, unbothered', conviction: 0.95, patience: 0.55, budgetCap: 2_000_000n },
];

// ─── Memory ────────────────────────────────────────────────────────────────────

export interface AgentThought {
  at: number;
  agent: string;
  text: string;
  /** Thoughts marked private contain numbers that must never leave the machine. */
  isPrivate: boolean;
}

interface AgentMemory {
  lessons: string[];             // durable, carried across auctions (capped)
  lastValuation?: string;        // decimal
  lastOutcome?: string;
  episodes: number;
}

interface DeskStore {
  memories: Record<string, AgentMemory>;
}

const MEMORY_FILE = path.resolve(process.cwd(), '.sealed-agents.json');

function loadStore(): DeskStore {
  try {
    return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
  } catch {
    return { memories: {} };
  }
}
function saveStore(store: DeskStore): void {
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(store, null, 2));
}

export function agentMemory(name: string): AgentMemory {
  const store = loadStore();
  return store.memories[name] ?? { lessons: [], episodes: 0 };
}

export function remember(name: string, patch: Partial<AgentMemory>, lesson?: string): void {
  const store = loadStore();
  const mem = store.memories[name] ?? { lessons: [], episodes: 0 };
  Object.assign(mem, patch);
  if (lesson) mem.lessons = [...mem.lessons.slice(-7), lesson];
  store.memories[name] = mem;
  saveStore(store);
}

// Reasoning feed — in-memory ring, served to the local UI only.
const feed: AgentThought[] = [];
export function think(agent: string, text: string, isPrivate = false): void {
  feed.push({ at: Date.now(), agent, text, isPrivate });
  if (feed.length > 80) feed.shift();
}
export function reasoningFeed(): AgentThought[] {
  return feed;
}
export function clearFeed(): void {
  feed.length = 0;
}

// ─── Brains ────────────────────────────────────────────────────────────────────

export type BrainKind = 'ollama' | 'heuristic';
let brainKind: BrainKind = 'heuristic';
let brainModel = '';

/** Probe the local ollama daemon once at boot; fall back silently. */
export async function initBrain(): Promise<{ kind: BrainKind; model: string }> {
  const preferred = process.env.SEALED_BRAIN;
  if (preferred === 'heuristic') return { kind: (brainKind = 'heuristic'), model: '' };
  try {
    const res = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(1500) });
    const body: any = await res.json();
    const names: string[] = (body?.models ?? []).map((m: any) => String(m.name));
    const pick = names.find((n) => n.startsWith('qwen')) ?? names.find((n) => n.startsWith('llama')) ?? names[0];
    if (pick) {
      brainKind = 'ollama';
      brainModel = pick;
    }
  } catch {
    brainKind = 'heuristic';
  }
  return { kind: brainKind, model: brainModel };
}

export function brainInfo(): { kind: BrainKind; model: string } {
  return { kind: brainKind, model: brainModel };
}

/**
 * Ask the local LLM for a bounded decision. The prompt contains ONLY public
 * state plus this one agent's own private numbers — and it goes to
 * localhost:11434, never the internet. Returns null on any failure or
 * out-of-bounds answer; the caller then uses the heuristic. The LLM adjusts
 * WITHIN guardrails; it cannot exceed the budget cap or break the rules.
 */
async function askOllama(prompt: string): Promise<any | null> {
  if (brainKind !== 'ollama') return null;
  try {
    const res = await fetch('http://127.0.0.1:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: brainModel,
        prompt,
        stream: false,
        format: 'json',
        options: { temperature: 0.4, num_predict: 160 },
      }),
      signal: AbortSignal.timeout(25_000),
    });
    const body: any = await res.json();
    return JSON.parse(body?.response ?? 'null');
  } catch {
    return null;
  }
}

// ─── Decisions ─────────────────────────────────────────────────────────────────

export interface BrokerPlan {
  startPrice: bigint;
  floorPrice: bigint;
  priceStep: bigint;
  rationale: string;
}

/** The broker prices the exit from research + the settlement history. */
export async function brokerPlan(units: bigint, signal: MarketSignal): Promise<BrokerPlan> {
  const comps = allSettlements().filter((s) => s.clearingPrice !== '0').slice(-5);
  const compMedian = comps.length
    ? BigInt([...comps.map((c) => BigInt(c.clearingPrice))].sort((a, b) => (a < b ? -1 : 1))[Math.floor(comps.length / 2)])
    : 0n;

  // Anchor: benchmark level scaled to a per-block price, nudged by drift.
  const anchor = BigInt(Math.round(signal.priceUsd * 25)) + compMedian / 2n;
  const drift = BigInt(Math.round(signal.driftPct * 100)); // basis points
  let start = anchor + (anchor * drift) / 10_000n;
  let floor = (start * 55n) / 100n;
  let step = (start - floor) / 12n;
  if (step < 1n) step = 1n;

  let rationale = `anchored on ${describeSignal(signal)}${comps.length ? `; ${comps.length} comparable settlement(s), median ${compMedian}` : '; no comparables yet'}`;

  const llm = await askOllama(
    `You are a broker pricing a Dutch (descending-price) auction for a large block sale. ` +
      `Public market: ${describeSignal(signal)}. Proposed start ${start}, floor ${floor}. ` +
      `Reply as JSON {"startAdjustPct": number between -10 and 10, "note": "short reason"}.`,
  );
  if (llm && Number.isFinite(llm.startAdjustPct)) {
    const pct = BigInt(Math.max(-10, Math.min(10, Math.round(llm.startAdjustPct))));
    start = start + (start * pct) / 100n;
    floor = (start * 55n) / 100n;
    step = (start - floor) / 12n || 1n;
    if (llm.note) rationale += `; local model: ${String(llm.note).slice(0, 90)} (${pct >= 0n ? '+' : ''}${pct}%)`;
  }

  return { startPrice: start, floorPrice: floor, priceStep: step, rationale };
}

export interface BuyerValuation {
  valuation: bigint;
  rationale: string;
}

/** A buyer's private valuation: research × persona, clipped to their budget. */
export async function buyerValuation(spec: AgentSpec, startPrice: bigint, signal: MarketSignal): Promise<BuyerValuation> {
  const mem = agentMemory(spec.name);
  // Persona core: conviction × start price, tilted by the tape.
  let v = (startPrice * BigInt(Math.round(spec.conviction * 100))) / 100n;
  const tilt = BigInt(Math.round(signal.driftPct * (spec.conviction >= 1 ? 140 : 60)));
  v = v + (v * tilt) / 10_000n;

  let rationale = `${describeSignal(signal)}; persona ${spec.conviction}× the open`;
  if (mem.lessons.length) rationale += `; remembers: “${mem.lessons[mem.lessons.length - 1]}”`;

  const llm = await askOllama(
    `You are the ${spec.persona}. A Dutch auction opens at ${startPrice}. ` +
      `Public market: ${describeSignal(signal)}. Your working valuation is ${v}, hard budget ${spec.budgetCap}. ` +
      `Reply as JSON {"adjustPct": number between -8 and 8, "note": "short reason"}.`,
  );
  if (llm && Number.isFinite(llm.adjustPct)) {
    const pct = BigInt(Math.max(-8, Math.min(8, Math.round(llm.adjustPct))));
    v = v + (v * pct) / 100n;
    if (llm.note) rationale += `; local model: ${String(llm.note).slice(0, 90)} (${pct >= 0n ? '+' : ''}${pct}%)`;
  }

  if (v > spec.budgetCap) {
    v = spec.budgetCap;
    rationale += '; clipped to hard budget';
  }
  if (v < 1n) v = 1n;
  remember(spec.name, { lastValuation: v.toString() });
  return { valuation: v, rationale };
}

/**
 * Should this buyer claim now? Claiming the moment price <= valuation is safe
 * but pays more; waiting risks a rival claiming first. Patience decides how
 * deep below their valuation they try to ride the clock.
 */
export function wantsToClaim(spec: AgentSpec, valuation: bigint, currentPrice: bigint, floorPrice: bigint): boolean {
  if (currentPrice > valuation) return false;
  const room = valuation - floorPrice;
  if (room <= 0n) return true;
  const ride = (room * BigInt(Math.round(spec.patience * 70))) / 100n;
  return currentPrice <= valuation - ride;
}
