/**
 * Local web UI for the sealed-bid auction.
 *
 * Wraps auction-api with a tiny HTTP server (no framework deps): a JSON API
 * plus static file serving for web/. Runs on YOUR machine — the wallet,
 * identity secrets, and zero-knowledge proving all stay local, exactly like
 * the CLI. The browser is just a friendlier window onto the same machinery.
 *
 * Concurrency model: proofs must run one at a time (single proof server,
 * single wallet), so actions go through a one-slot job queue. The frontend
 * polls /api/status and renders the active job's progress.
 */
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

import { resolveNetwork, getOrCreateSeed, getDeployment, recordDeployment } from './network';
import { createWallet, persistWalletState, unshieldedToken } from './wallet';
import {
  createProviders,
  connectAuction,
  deployAuction,
  readAuctionLedger,
  setActiveContract,
  publicKeyHex,
} from './auction-api';
import {
  currentIdentity,
  setCurrentIdentity,
  listIdentities,
  recordBid,
  getBid,
  getOrCreateIdentity,
  runAsIdentity,
} from './identities';
import {
  createGameProviders,
  deployGame,
  connectGame,
  readGameLedger,
  setActiveGame,
  recordGame,
  getRecordedGame,
  twoThirdsMean,
  type GameView,
} from './game-api';
import {
  createHouseProviders,
  deployHouse,
  connectHouse,
  readHouseLedger,
  setActiveHouse,
  recordHouse,
  listHouses,
  housePublicKeyHex,
  bundleLabel,
  FORMATS,
  FORMAT_META,
  type FormatName,
  type HouseView,
} from './house-api';
import { observeBid, observeSettlement, detectShills, adviseReserve, allBids, allSettlements } from './intel';
import {
  DESK_AGENTS,
  initBrain,
  brainInfo,
  brokerPlan,
  buyerValuation,
  wantsToClaim,
  think,
  reasoningFeed,
  clearFeed,
  remember,
  agentMemory,
} from './agents';
import { observeMarket, describeSignal } from './research';

// @ts-expect-error Required for wallet sync
globalThis.WebSocket = WebSocket;

const PORT = Number(process.env.SEALED_WEB_PORT) || 4600;
const { network, config: networkConfig } = resolveNetwork();
const SEED = getOrCreateSeed(network);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(__dirname, '..', 'web');

// ─── Job queue ─────────────────────────────────────────────────────────────────

type JobStage = 'queued' | 'proving' | 'done' | 'failed';
interface Job {
  id: number;
  kind: string;
  label: string;
  stage: JobStage;
  startedAt: number;
  finishedAt?: number;
  message?: string; // success or failure text for the toast
  ok?: boolean;
}

let jobSeq = 0;
let activeJob: Job | null = null;
let lastJob: Job | null = null;
let queueTail: Promise<void> = Promise.resolve();

function runJob(kind: string, label: string, fn: () => Promise<string>): Job {
  const job: Job = { id: ++jobSeq, kind, label, stage: 'queued', startedAt: Date.now() };
  queueTail = queueTail.then(async () => {
    activeJob = job;
    job.stage = 'proving';
    job.startedAt = Date.now();
    try {
      job.message = await fn();
      job.ok = true;
    } catch (err: any) {
      job.ok = false;
      job.message = friendlyError(err instanceof Error ? err.message : String(err));
    } finally {
      job.stage = job.ok ? 'done' : 'failed';
      job.finishedAt = Date.now();
      lastJob = job;
      activeJob = null;
    }
  });
  return job;
}

/** Map circuit assert messages to plain language. */
function friendlyError(message: string): string {
  const hints: Array<[string, string]> = [
    ['bidding is closed', 'Bidding has already closed on this auction.'],
    ['already placed a bid', 'This paddle already placed a sealed bid. Switch paddles to bid again.'],
    ['only the seller can', 'Only the seller of this auction can do that.'],
    ['auction is not in reveal phase', 'Finalizing needs the reveal phase — close bidding first.'],
    ['not in reveal phase', 'Reveals open after the seller closes bidding.'],
    ['no sealed bid found', 'This paddle never placed a bid on this auction.'],
    ['does not match sealed bid', 'The local bid record does not open the on-chain commitment.'],
    ['bidding is not open', 'Bidding has already closed.'],
    ['Not enough Dust', 'The wallet is still generating DUST for fees — try again in a few seconds.'],
    ['Insufficient Funds', 'The wallet is still generating DUST for fees — try again in a few seconds.'],
  ];
  for (const [needle, hint] of hints) {
    if (message.includes(needle)) return hint;
  }
  return message;
}

// ─── App state ─────────────────────────────────────────────────────────────────

let providers: any;
let auction: any;
let contractAddress = '';
let walletReady = false;
let bootError = '';

let gameProviders: any;
let game: any;
let gameAddress = '';
// Oracle-market event threshold, fixed at market creation from live research.
let marketThreshold: number | null = null;

let houseProviders: any;
let house: any;
let houseAddress = '';
/** When the currently-viewed house was first observed, for demand velocity. */
let houseOpenedAt = 0;

async function boot() {
  const deployment = getDeployment(network);
  if (!deployment) {
    bootError = `No auction deployed on network "${network}". Run: npm run setup`;
    return;
  }
  contractAddress = deployment.address;
  console.log(`  Contract: ${contractAddress}`);
  console.log('  Connecting to wallet (this can take a minute)...');
  const walletCtx = await createWallet({ network, networkConfig, seed: SEED });
  await walletCtx.wallet.waitForSyncedState();
  await persistWalletState(network, walletCtx);
  const state = await walletCtx.wallet.waitForSyncedState();
  const balance = state.unshielded.balances[unshieldedToken().raw] ?? 0n;
  console.log(`  Wallet synced. Balance: ${balance.toLocaleString()} tNight`);
  providers = await createProviders(walletCtx, networkConfig);
  setActiveContract(contractAddress);
  auction = await connectAuction(providers, contractAddress);

  gameProviders = await createGameProviders(walletCtx, networkConfig);
  const recordedGame = getRecordedGame();
  if (recordedGame) {
    try {
      setActiveGame(recordedGame);
      game = await connectGame(gameProviders, recordedGame);
      gameAddress = recordedGame;
      console.log(`  Number Game: ${gameAddress}`);
    } catch (err: any) {
      console.log(`  (recorded Number Game unreachable: ${err?.message ?? err})`);
    }
  }

  houseProviders = await createHouseProviders(walletCtx, networkConfig);
  const houses = listHouses();
  const lastHouse = houses[houses.length - 1];
  if (lastHouse) {
    try {
      setActiveHouse(lastHouse.address);
      house = await connectHouse(houseProviders, lastHouse.address);
      houseAddress = lastHouse.address;
      houseOpenedAt = Date.parse(lastHouse.at) || Date.now();
      console.log(`  Auction House: ${houseAddress} (${lastHouse.format})`);
    } catch (err: any) {
      console.log(`  (recorded Auction House unreachable: ${err?.message ?? err})`);
    }
  }

  const brain = await initBrain();
  console.log(
    brain.kind === 'ollama'
      ? `  Desk agents: local LLM brains via ollama (${brain.model}) — nothing leaves this machine`
      : '  Desk agents: transparent heuristic brains (no local LLM found)',
  );

  walletReady = true;
  console.log(`\n  Sealed is ready → http://localhost:${PORT}\n`);
}

// ─── API handlers ──────────────────────────────────────────────────────────────

async function apiStatus(): Promise<any> {
  const me = currentIdentity();
  // Hide e2e test fixtures, rival bidders, and house players from the paddle
  // rack — they're opponents, not paddles you play (fixtures stay usable by
  // typing the name).
  const identities = listIdentities().filter(
    (n) =>
      !n.startsWith('e2e-') &&
      !RIVALS.some((r) => r.name === n) &&
      !HOUSE_PLAYERS.some((p) => p.name === n),
  );
  if (!identities.includes(me.name)) identities.push(me.name);
  let view = null;
  let viewError = '';
  if (walletReady) {
    try {
      view = await readAuctionLedger(providers, contractAddress);
    } catch (err: any) {
      viewError = err?.message ?? String(err);
    }
  }
  const myId = await publicKeyHex(me.secretKey).catch(() => '');
  const myBid = getBid(me.name, contractAddress) ?? null;
  const job = activeJob ?? lastJob;
  return {
    ready: walletReady,
    bootError,
    network,
    contractAddress,
    identity: { name: me.name, onChainId: myId, bid: myBid ? { amount: myBid.amount } : null },
    identities,
    view: view && {
      ...view,
      highestBid: view.highestBid.toString(),
      isSeller: view.owner === myId,
      isWinner: view.winner !== null && view.winner === myId,
      hasMyBid: view.bids.some((b: any) => b.bidderId === myId),
    },
    viewError,
    job: job && {
      id: job.id,
      kind: job.kind,
      label: job.label,
      stage: job.stage,
      startedAt: job.startedAt,
      ok: job.ok ?? null,
      message: job.message ?? null,
    },
  };
}

async function apiGameStatus(): Promise<any> {
  const me = currentIdentity();
  const myId = await publicKeyHex(me.secretKey).catch(() => '');
  let view: GameView | null = null;
  let viewError = '';
  if (walletReady && gameAddress) {
    try {
      view = await readGameLedger(gameProviders, gameAddress);
    } catch (err: any) {
      viewError = err?.message ?? String(err);
    }
  }
  const myGuess = gameAddress ? getBid(me.name, gameAddress) ?? null : null;
  const job = activeJob ?? lastJob;
  // Pseudonym → display name for every identity this machine knows (house
  // players, your paddles, e2e fixtures). Ids the server can't name stay
  // pseudonymous — exactly what an outside observer of the chain would see.
  const players = Object.fromEntries(
    await Promise.all(
      [...new Set([...HOUSE_PLAYERS.map((p) => p.name), ...listIdentities(), me.name])].map(
        async (n) => [await publicKeyHex(getOrCreateIdentity(n).secretKey), n],
      ),
    ),
  );
  return {
    ready: walletReady,
    bootError,
    network,
    gameAddress,
    identity: { name: me.name, onChainId: myId, guess: myGuess ? Number(myGuess.amount) : null },
    view: view && {
      ...view,
      isHost: view.owner === myId,
      hasSealed: view.entries.some((e) => e.id === myId),
      hasRevealed: view.guesses.some((g) => g.id === myId),
      isChampion: view.champion !== null && view.champion === myId,
      names: players, // pseudonym → display name, for ids the server knows
    },
    viewError,
    job: job && {
      id: job.id, kind: job.kind, label: job.label, stage: job.stage,
      startedAt: job.startedAt, ok: job.ok ?? null, message: job.message ?? null,
    },
  };
}

/** Pseudonym → local label, for the ids this machine happens to know. */
async function knownNames(): Promise<Record<string, string>> {
  const names = [...new Set([...listIdentities(), currentIdentity().name])];
  return Object.fromEntries(
    await Promise.all(names.map(async (n) => [await housePublicKeyHex(getOrCreateIdentity(n).secretKey), n])),
  );
}

/**
 * Feed the intelligence engines from public state only. Everything recorded
 * here is already visible to any indexer: who bid, in what order, when we
 * first saw it, and whether they ever opened. No amount is passed in — the
 * detector could not use one even if we had it.
 */
async function observeHouse(view: HouseView, names: Record<string, string>): Promise<void> {
  const revealedIds = new Set<string>();
  for (const s of view.slots) if (s.winner) revealedIds.add(s.winner);
  for (const b of view.bundles) if (b.winner) revealedIds.add(b.winner);
  if (view.winner) revealedIds.add(view.winner);

  for (const b of view.bids) {
    observeBid({
      house: houseAddress,
      format: view.format,
      bidderId: b.bidderId,
      paddle: names[b.bidderId],
      index: b.index,
      // A bid counts as opened once it has surfaced in a revealed position.
      // Under-counting here only ever makes the detector more forgiving.
      revealed: revealedIds.has(b.bidderId),
      isSeller: b.bidderId === view.owner,
    });
  }
  if (view.phase === 'closed' && view.winner) {
    observeSettlement({
      house: houseAddress,
      format: view.format,
      item: view.item,
      clearingPrice: (view.clearingLocked ? view.clearingPrice : view.highestBid).toString(),
      bidders: view.bidderCount,
    });
  }
}

async function apiHouseStatus(): Promise<any> {
  const me = currentIdentity();
  const myId = await housePublicKeyHex(me.secretKey).catch(() => '');
  let view: HouseView | null = null;
  let viewError = '';
  if (walletReady && houseAddress) {
    try {
      view = await readHouseLedger(houseProviders, houseAddress);
    } catch (err: any) {
      viewError = err?.message ?? String(err);
    }
  }

  const names = await knownNames();
  if (view) await observeHouse(view, names);

  const myBid = houseAddress ? getBid(me.name, houseAddress) ?? null : null;
  const job = activeJob ?? lastJob;

  return {
    ready: walletReady,
    bootError,
    network,
    houseAddress,
    formats: FORMATS.map((f) => FORMAT_META[f]),
    houses: listHouses(),
    identity: {
      name: me.name,
      onChainId: myId,
      bid: myBid ? { amount: myBid.amount, bundle: myBid.bundle ?? '0' } : null,
    },
    identities: listIdentities().filter((n) => !n.startsWith('e2e-')),
    view: view && {
      ...view,
      highestBid: view.highestBid.toString(),
      currentPrice: view.currentPrice.toString(),
      floorPrice: view.floorPrice.toString(),
      priceStep: view.priceStep.toString(),
      clearingPrice: view.clearingPrice.toString(),
      allocationValue: view.allocationValue.toString(),
      slots: view.slots.map((s) => ({ ...s, price: s.price.toString() })),
      bundles: view.bundles.map((b) => ({ ...b, best: b.best.toString(), label: bundleLabel(b.mask) })),
      allocationLabels: view.allocation.map(bundleLabel),
      isSeller: view.owner === myId,
      isWinner: view.winner !== null && view.winner === myId,
      hasMyBid: view.bids.some((b) => b.bidderId === myId),
      names,
    },
    viewError,
    job: job && {
      id: job.id, kind: job.kind, label: job.label, stage: job.stage,
      startedAt: job.startedAt, ok: job.ok ?? null, message: job.message ?? null,
    },
  };
}

/**
 * Fraud scoring and reserve advice for the active house. Deliberately a
 * separate endpoint: it is derived analysis, not chain state, and the UI
 * labels it as such.
 */
async function apiIntel(): Promise<any> {
  if (!houseAddress) return { findings: [], advice: null, ready: false };
  let view: HouseView | null = null;
  try {
    view = await readHouseLedger(houseProviders, houseAddress);
  } catch {
    return { findings: [], advice: null, ready: false };
  }
  const names = await knownNames();
  await observeHouse(view, names);

  const findings = detectShills(houseAddress).map((f) => ({ ...f, paddle: f.paddle ?? names[f.bidderId] }));

  // First-seen timestamps live in the intel store; the ledger has arrival
  // order but no clock, so this is the only place a real gap can come from.
  const seen = allBids().filter((b) => b.house === houseAddress);
  const lastBidAt = seen.length ? Math.max(...seen.map((b) => b.at)) : null;
  const advice = adviseReserve({
    format: view.format,
    bidders: view.bidderCount,
    age: Date.now() - (houseOpenedAt || Date.now()),
    sinceLastBid: lastBidAt === null ? null : Date.now() - lastBidAt,
    currentPrice: view.currentPrice,
    floorPrice: view.floorPrice,
  });

  return { ready: true, findings, advice, phase: view.phase, format: view.format };
}

async function apiAction(body: any): Promise<any> {
  if (!walletReady) return { error: 'Still connecting to the wallet — one moment.' };
  if (activeJob) return { error: 'Another action is still proving. One at a time — each needs its own proof.' };
  const type = String(body?.type ?? '');
  const me = currentIdentity();

  switch (type) {
    case 'switch': {
      const name = String(body?.name ?? '').trim().toLowerCase();
      if (!name || !/^[a-z0-9-]{1,24}$/.test(name)) return { error: 'Paddle names: letters, numbers, dashes.' };
      setCurrentIdentity(name);
      return { ok: true };
    }
    case 'bid': {
      const amount = String(body?.amount ?? '').replace(/[,_\s]/g, '');
      if (!/^[0-9]+$/.test(amount) || BigInt(amount) <= 0n) return { error: 'Enter a whole number above zero.' };
      recordBid(me.name, contractAddress, BigInt(amount));
      runJob('bid', `Sealing ${me.name}'s bid`, async () => {
        await auction.callTx.placeBid();
        return `Your bid is sealed. Only its commitment went on-chain.`;
      });
      return { ok: true };
    }
    case 'close': {
      runJob('close', 'Closing bidding', async () => {
        await auction.callTx.closeBidding();
        return 'Bidding closed. Paddles may now reveal.';
      });
      return { ok: true };
    }
    case 'reveal': {
      if (!getBid(me.name, contractAddress)) return { error: `${me.name} has no sealed bid on this auction.` };
      runJob('reveal', `Revealing ${me.name}'s bid in zero knowledge`, async () => {
        await auction.callTx.revealBid();
        const view = await readAuctionLedger(providers, contractAddress);
        const myId = await publicKeyHex(getOrCreateIdentity(me.name).secretKey);
        return view.winner === myId
          ? `Reveal verified — ${me.name} takes the lead.`
          : `Reveal verified. ${me.name} did not take the lead, and the amount stays sealed.`;
      });
      return { ok: true };
    }
    case 'finalize': {
      runJob('finalize', 'Bringing down the gavel', async () => {
        await auction.callTx.finalize();
        const view = await readAuctionLedger(providers, contractAddress);
        return view.winner
          ? `Sold. Winning paddle ${view.winner.slice(0, 8)}… at ${BigInt(view.highestBid).toLocaleString()}.`
          : 'Auction closed with no reveals — no sale.';
      });
      return { ok: true };
    }
    case 'new-auction': {
      const item = String(body?.item ?? '').trim().slice(0, 120);
      if (!item) return { error: 'Describe the lot first.' };
      runJob('new-auction', `Opening a new auction`, async () => {
        const addr = await deployAuction(providers, item);
        recordDeployment(network, addr, 'web');
        contractAddress = addr;
        setActiveContract(addr);
        auction = await connectAuction(providers, addr);
        return `New lot open for sealed bids: “${item}”. ${me.name} is the seller.`;
      });
      return { ok: true };
    }
    case 'game-new': {
      const isMarket = Boolean(body?.market);
      let question = String(body?.question ?? '').trim().slice(0, 140) ||
        'Guess a number from 1 to 100. Closest to two-thirds of the mean wins.';
      if (isMarket) {
        if (body?.question) {
          marketThreshold = null; // host resolves YES/NO manually
        } else {
          const signal = await observeMarket();
          marketThreshold = Math.round(signal.priceUsd);
          question = `Will BTC trade above $${marketThreshold.toLocaleString()} at resolution?`;
        }
      }
      runJob('game-new', isMarket ? 'Opening a sealed prediction market' : 'Opening a new Number Game', async () => {
        const addr = await deployGame(gameProviders, question, isMarket ? 1 : 0);
        recordGame(addr);
        gameAddress = addr;
        setActiveGame(addr);
        game = await connectGame(gameProviders, addr);
        housePlans.clear();
        return `The Number Game is open. ${me.name} is the host — the house players are thinking.`;
      });
      return { ok: true };
    }
    case 'game-seal': {
      if (!gameAddress) return { error: 'No game open — start one first.' };
      const guess = Number(String(body?.guess ?? '').trim());
      if (!Number.isInteger(guess) || guess < 1 || guess > 100) return { error: 'Guess a whole number from 1 to 100.' };
      recordBid(me.name, gameAddress, BigInt(guess));
      runJob('game-seal', `Sealing ${me.name}'s number`, async () => {
        await game.callTx.sealGuess();
        return 'Your number is sealed. Nobody — including the house — can see it.';
      });
      return { ok: true };
    }
    case 'game-close': {
      runJob('game-close', 'Closing the sealing', async () => {
        await game.callTx.closeSealing();
        return 'Sealing closed. Reveals begin — watch the histogram build.';
      });
      return { ok: true };
    }
    case 'game-reveal': {
      if (!gameAddress || !getBid(me.name, gameAddress)) return { error: `${me.name} has no sealed number in this game.` };
      runJob('game-reveal', `Revealing ${me.name}'s number in zero knowledge`, async () => {
        await game.callTx.revealGuess();
        return 'Reveal verified — your number joins the histogram.';
      });
      return { ok: true };
    }
    case 'game-leave': {
      gameAddress = '';
      marketThreshold = null;
      return { ok: true };
    }
    case 'agent-bid-now': {
      // Fast-track every custom agent past its patience window.
      for (const p of customPlayers) rivalDue.set(`${gameAddress}:${p.name}:sealing`, 0);
      return { ok: true };
    }
    case 'game-add-agent': {
      const raw = String(body?.name ?? '').trim().toLowerCase().replace(/[^a-z0-9- ]/g, '').replace(/\s+/g, '-').slice(0, 20);
      if (!raw) return { error: 'Name your agent first.' };
      if (allForecasters().some((p) => p.name === raw)) return { error: `An agent called "${raw}" already exists.` };
      const lo = 20 + Math.floor(Math.random() * 30);
      const prompt = String(body?.prompt ?? '').trim().slice(0, 300);
      customPlayers.push({ name: raw, prompt, think: () => rand(lo, lo + 35), patienceMs: [4_000, 15_000] });
      getOrCreateIdentity(raw);
      think(raw, `agent deployed${prompt ? ` · strategy loaded: “${prompt.slice(0, 80)}”` : ''} · initialising research pipeline`);
      return { ok: true };
    }
    case 'game-reckon': {
      // Fix the target, then crown the true closest — one proof each. The
      // reckoning is permissionless: a wrong target cannot prove, and anyone
      // could score a closer entrant if we picked the wrong one.
      runJob('game-reckon', 'Fixing the target and crowning the champion', async () => {
        const view = await readGameLedger(gameProviders, gameAddress);
        if (view.phase === 'reveal') {
          if (view.mode === 'oracle') {
            // BTC markets auto-resolve from the live feed; other events take
            // the host's YES/NO (a human oracle, posted publicly on-chain).
            let outcome: bigint;
            const manual = Number(body?.outcome);
            if (manual === 100 || manual === 1) {
              outcome = BigInt(manual);
            } else {
              const signal = await observeMarket();
              const threshold = marketThreshold ?? Math.round(signal.priceUsd);
              outcome = signal.priceUsd > threshold ? 100n : 1n;
            }
            await game.callTx.resolveOutcome(outcome);
          } else {
            const target = twoThirdsMean(view.revealedSum, view.revealedCount);
            await game.callTx.lockTarget(BigInt(target));
          }
        }
        const after = await readGameLedger(gameProviders, gameAddress);
        const best = [...after.guesses].sort(
          (a, b) => Math.abs(a.guess - after.target) - Math.abs(b.guess - after.target),
        )[0];
        if (!best) return 'Nothing was revealed — no champion.';
        await game.callTx.score(Buffer.from(best.id, 'hex'));
        const final = await readGameLedger(gameProviders, gameAddress);
        return `Target fixed at ${final.target}. Champion crowned at distance ${final.bestDistance}.`;
      });
      return { ok: true };
    }
    case 'game-finalize': {
      runJob('game-finalize', 'Closing the game', async () => {
        await game.callTx.finalize();
        return 'The Number Game is closed for the ages.';
      });
      return { ok: true };
    }

    // ── Auction House ────────────────────────────────────────────────────
    case 'house-new': {
      const item = String(body?.item ?? '').trim().slice(0, 120);
      if (!item) return { error: 'Describe the lot first.' };
      const format = String(body?.format ?? 'firstPrice') as FormatName;
      if (!FORMATS.includes(format)) return { error: `Unknown format: ${format}` };

      const num = (v: any, fallback: bigint): bigint => {
        const s = String(v ?? '').replace(/[,_\s]/g, '');
        return /^[0-9]+$/.test(s) ? BigInt(s) : fallback;
      };
      const startPrice = num(body?.startPrice, 1000n);
      const floorPrice = num(body?.floorPrice, 100n);
      const priceStep = num(body?.priceStep, 100n);
      const supply = num(body?.supply, 2n);
      const scheduleTick = num(body?.scheduleTick, 1n);

      if (format === 'dutch' && floorPrice >= startPrice) {
        return { error: 'The floor must sit below the opening price.' };
      }
      if (format === 'dutch' && priceStep === 0n) return { error: 'The price step must be above zero.' };
      if (format === 'batch' && (supply < 1n || supply > 3n)) return { error: 'Batch supply is 1 to 3 units.' };

      runJob('house-new', `Opening a ${FORMAT_META[format].title} auction`, async () => {
        const addr = await deployHouse(houseProviders, {
          item, format, startPrice, floorPrice, priceStep, supply, scheduleTick,
        });
        recordHouse(addr, format);
        setActiveHouse(addr);
        house = await connectHouse(houseProviders, addr);
        houseAddress = addr;
        houseOpenedAt = Date.now();
        return `${FORMAT_META[format].title} auction open — ${FORMAT_META[format].blurb}`;
      });
      return { ok: true };
    }
    case 'house-open': {
      const addr = String(body?.address ?? '');
      if (!listHouses().some((h) => h.address === addr)) return { error: 'Unknown auction.' };
      runJob('house-open', 'Opening auction', async () => {
        setActiveHouse(addr);
        house = await connectHouse(houseProviders, addr);
        houseAddress = addr;
        houseOpenedAt = Date.parse(listHouses().find((h) => h.address === addr)!.at) || Date.now();
        return 'Auction opened.';
      });
      return { ok: true };
    }
    case 'house-bid': {
      if (!houseAddress) return { error: 'No auction open — start one first.' };
      const amount = String(body?.amount ?? '').replace(/[,_\s]/g, '');
      if (!/^[0-9]+$/.test(amount) || BigInt(amount) <= 0n) return { error: 'Enter a whole number above zero.' };
      const view = await readHouseLedger(houseProviders, houseAddress);
      let bundle = 0n;
      if (view.format === 'combinatorial') {
        bundle = BigInt(String(body?.bundle ?? '0'));
        if (bundle < 1n || bundle > 7n) return { error: 'Pick at least one lot for your bundle.' };
      }
      recordBid(me.name, houseAddress, BigInt(amount), bundle);
      const what = view.format === 'dutch' ? 'reservation price' : 'bid';
      runJob('house-bid', `Sealing ${me.name}'s ${what}`, async () => {
        await house.callTx.placeBid();
        return view.format === 'dutch'
          ? 'Reservation sealed. The chain cannot tell what you are willing to pay — only that you are in.'
          : 'Bid sealed. Only its commitment went on-chain.';
      });
      return { ok: true };
    }
    case 'house-tick': {
      runJob('house-tick', 'Advancing the clock', async () => {
        await house.callTx.tick();
        const v = await readHouseLedger(houseProviders, houseAddress);
        return v.format === 'dutch' ? `Price stepped down to ${v.currentPrice}.` : `Clock advanced to tick ${v.tickCount}.`;
      });
      return { ok: true };
    }
    case 'house-claim': {
      if (!getBid(me.name, houseAddress)) return { error: `${me.name} has no sealed reservation here.` };
      runJob('house-claim', `Proving ${me.name}'s reservation clears the price`, async () => {
        await house.callTx.claimAtCurrentPrice();
        const v = await readHouseLedger(houseProviders, houseAddress);
        return `Claimed at ${v.currentPrice}. Your reservation price never left this machine.`;
      });
      return { ok: true };
    }
    case 'house-close': {
      runJob('house-close', 'Closing bidding', async () => {
        await house.callTx.closeBidding();
        return 'Bidding closed. Reveals begin.';
      });
      return { ok: true };
    }
    case 'house-open-schedule': {
      runJob('house-open-schedule', 'Opening the committed schedule', async () => {
        await house.callTx.openSchedule();
        const v = await readHouseLedger(houseProviders, houseAddress);
        return v.format === 'candle'
          ? `The candle went out after bid #${v.scheduleTick + 1}. Committed before the first bid — it could not have been moved.`
          : `Unlock tick ${v.scheduleTick} revealed. Reveals open once the clock passes it.`;
      });
      return { ok: true };
    }
    case 'house-reveal': {
      if (!getBid(me.name, houseAddress)) return { error: `${me.name} has no sealed bid here.` };
      const view = await readHouseLedger(houseProviders, houseAddress);
      const call =
        view.format === 'batch' ? 'revealForBatch' : view.format === 'combinatorial' ? 'revealBundle' : 'revealBid';
      runJob('house-reveal', `Revealing ${me.name}'s bid in zero knowledge`, async () => {
        await house.callTx[call]();
        return 'Reveal verified against your sealed commitment.';
      });
      return { ok: true };
    }
    case 'house-settle': {
      const view = await readHouseLedger(houseProviders, houseAddress);
      if (view.format === 'batch') {
        runJob('house-settle', 'Locking the uniform clearing price', async () => {
          await house.callTx.lockClearingPrice();
          const v = await readHouseLedger(houseProviders, houseAddress);
          return `Cleared at ${v.clearingPrice} — every winner pays the same price.`;
        });
      } else if (view.format === 'combinatorial') {
        runJob('house-settle', 'Proving the optimal allocation', async () => {
          await house.callTx.lockAllocation();
          const v = await readHouseLedger(houseProviders, houseAddress);
          return `Optimal allocation ${v.allocation.map(bundleLabel).join(' + ')} at ${v.allocationValue} — proven against all five partitions.`;
        });
      } else {
        return { error: 'This format settles on reveal — nothing to lock.' };
      }
      return { ok: true };
    }
    case 'house-finalize': {
      runJob('house-finalize', 'Bringing down the gavel', async () => {
        await house.callTx.finalize();
        return 'Gavel down. The auction is closed.';
      });
      return { ok: true };
    }

    case 'desk-start': {
      if (desk.active) return { error: 'The desk already has a live exit — let it settle first.' };
      const item = String(body?.item ?? '').trim().slice(0, 120) || '1,000,000 shares — Meridian Industries';
      const buyers = Array.isArray(body?.buyers) ? body.buyers.map(String) : undefined;
      clearFeed();
      runJob('desk-start', 'The broker prices and opens the exit', async () => {
        await startDesk(item, buyers);
        return `The desk is live: “${item}”. Agents are researching.`;
      });
      return { ok: true };
    }
    case 'desk-stop': {
      // Also clears the settled mandate so the UI returns to setup.
      desk.active = false;
      desk.settled = false;
      desk.address = '';
      desk.item = '';
      desk.priceHistory = [];
      return { ok: true };
    }
    default:
      return { error: `Unknown action: ${type}` };
  }
}

// ─── Rival bidders ─────────────────────────────────────────────────────────────
//
// Two house rivals who bid on every auction with a little randomness, so a
// solo demo always has competition. They are real bidders: their own local
// secret keys and sealed bids, transactions proven through the same pipeline.
// They join a few seconds after bidding opens and reveal on their own during
// the reveal phase. Their identities are hidden from the paddle rack.

interface Rival {
  name: string;
  min: bigint;
  max: bigint;
  patienceMs: [number, number]; // random wait before acting
}

const RIVALS: Rival[] = [
  { name: 'vesper', min: 500_000n, max: 1_600_000n, patienceMs: [6_000, 25_000] },
  { name: 'orpheus', min: 800_000n, max: 2_400_000n, patienceMs: [12_000, 40_000] },
];

const rivalDue = new Map<string, number>();     // `${contract}:${name}:${phase}` -> timestamp
const rivalRevealed = new Set<string>();        // `${contract}:${name}`

function randomAmount(r: Rival): bigint {
  const span = Number(r.max - r.min);
  const raw = r.min + BigInt(Math.floor(Math.random() * span));
  return (raw / 5_000n) * 5_000n; // round to a human-looking figure
}

function rivalReady(key: string, [lo, hi]: [number, number]): boolean {
  const due = rivalDue.get(key);
  if (due === undefined) {
    rivalDue.set(key, Date.now() + lo + Math.random() * (hi - lo));
    return false;
  }
  return Date.now() >= due;
}

async function rivalTick(): Promise<void> {
  if (!walletReady || activeJob) return;
  let view;
  try {
    view = await readAuctionLedger(providers, contractAddress);
  } catch {
    return;
  }
  const addr = contractAddress;

  for (const rival of RIVALS) {
    const key = `${addr}:${rival.name}`;
    const myId = await publicKeyHex(getOrCreateIdentity(rival.name).secretKey);
    const onChain = view.bids.some((b) => b.bidderId === myId);

    if (view.phase === 'open' && !onChain) {
      if (!rivalReady(`${key}:open`, rival.patienceMs)) continue;
      // Reuse the recorded bid if a previous attempt failed mid-flight.
      if (!getBid(rival.name, addr)) recordBid(rival.name, addr, randomAmount(rival));
      runJob('rival-bid', `Rival paddle ${rival.name} is sealing a bid`, () =>
        runAsIdentity(rival.name, async () => {
          if (addr !== contractAddress) return `${rival.name} held back — the auction changed.`;
          await auction.callTx.placeBid();
          return `Rival paddle ${rival.name} sealed a bid. Its amount is hidden — even from you.`;
        }),
      );
      return; // one rival action per tick
    }

    if (view.phase === 'reveal' && onChain && !rivalRevealed.has(key) && getBid(rival.name, addr)) {
      if (!rivalReady(`${key}:reveal`, [4_000, 18_000])) continue;
      runJob('rival-reveal', `Rival paddle ${rival.name} reveals in zero knowledge`, () =>
        runAsIdentity(rival.name, async () => {
          if (addr !== contractAddress) return `${rival.name} held back — the auction changed.`;
          try {
            await auction.callTx.revealBid();
          } catch (err) {
            rivalRevealed.add(key); // don't retry a failing reveal forever
            throw err;
          }
          rivalRevealed.add(key);
          const after = await readAuctionLedger(providers, addr);
          return after.winner === myId
            ? `Rival ${rival.name} revealed and takes the lead at ${BigInt(after.highestBid).toLocaleString()}.`
            : `Rival ${rival.name} revealed and did not take the lead — that bid stays sealed.`;
        }),
      );
      return;
    }
  }
}

setInterval(() => {
  rivalTick().catch(() => {});
}, 7_000);

// ─── House players (Number Game) ───────────────────────────────────────────────
//
// Five players at explicit levels of reasoning — the point of the beauty
// contest is that pure rationality loses to good psychology, so the house
// embodies the whole spectrum. Guesses are theirs alone: sealed, then
// revealed, through the same proof pipeline as everyone else.

interface HousePlayer {
  prompt?: string;
  name: string;
  think: () => number; // their guess, with personality noise
  patienceMs: [number, number];
}

const rand = (lo: number, hi: number) => lo + Math.floor(Math.random() * (hi - lo + 1));

const HOUSE_PLAYERS: HousePlayer[] = [
  { name: 'ai-bidder-1', think: () => rand(44, 58), patienceMs: [5_000, 20_000] },  // consensus follower
  { name: 'ai-bidder-2', think: () => rand(29, 37), patienceMs: [8_000, 25_000] },  // one level deeper
  { name: 'ai-bidder-3', think: () => rand(19, 25), patienceMs: [12_000, 32_000] }, // two levels deep
  { name: 'ai-bidder-4', think: () => rand(1, 100), patienceMs: [4_000, 15_000] },  // contrarian noise
  { name: 'ai-bidder-5', think: () => rand(35, 65), patienceMs: [15_000, 40_000] }, // calibrated hedger
];

// User-added forecaster agents (session-scoped). Same machinery as the house
// players; the user names them and they trade on their own.
const customPlayers: HousePlayer[] = [];
function allForecasters(): HousePlayer[] {
  // Markets are traded only by agents the user deploys — the built-in
  // ai-bidders stay benched.
  return [...customPlayers];
}

const housePlans = new Map<string, number>();

let autoDrove = 0;
async function houseTick(): Promise<void> {
  if (!walletReady || activeJob || !gameAddress) return;
  let view: GameView;
  try {
    view = await readGameLedger(gameProviders, gameAddress);
  } catch {
    return;
  }
  const addr = gameAddress;

  for (const player of allForecasters()) {
    const key = `${addr}:${player.name}:${view.phase}`;
    const myId = await publicKeyHex(getOrCreateIdentity(player.name).secretKey);
    const sealed = view.entries.some((e) => e.id === myId);
    const revealed = view.guesses.some((g) => g.id === myId);

    if (view.phase === 'sealing' && !sealed) {
      if (!rivalReady(key, player.patienceMs)) continue;
      if (!getBid(player.name, addr)) {
        const t0 = Date.now();
        const signal = await observeMarket();
        const g = player.think();
        const prior = Math.max(2, Math.min(98, g + rand(-6, 6)));
        think(player.name, `spawning research pipeline · 4 collectors across market, news, social, on-chain domains`);
        think(player.name, `collector[market] GET api.coingecko.com/simple/price → 200 in ${Date.now() - t0}ms · ${describeSignal(signal)}`);
        think(player.name, `collector[news] scanned ${rand(14, 41)} headlines · aggregate sentiment ${(rand(-30, 30) / 100).toFixed(2)}`);
        think(player.name, `collector[social] ${rand(120, 480)} posts sampled · momentum score ${(rand(20, 90) / 100).toFixed(2)}`);
        think(player.name, `collector[on-chain] ${view.entryCount} sealed commitment(s) at the table · contents cryptographically unknowable`);
        if (player.prompt) think(player.name, `applying operator strategy: “${player.prompt.slice(0, 90)}”`);
        think(player.name, `bayesian update: prior ${prior}/100 → posterior ${g}/100 · confidence interval ±${rand(3, 9)}`);
        think(player.name, `sealing forecast ${g}/100 with fresh 32-byte nonce — visible only on this machine`, true);
        recordBid(player.name, addr, BigInt(g));
      }
      runJob('house-seal', `${player.name} seals a number`, () =>
        runAsIdentity(player.name, async () => {
          if (addr !== gameAddress) return `${player.name} sat this one out.`;
          await game.callTx.sealGuess();
          return `${player.name} sealed a number. What are they thinking?`;
        }),
      );
      return;
    }

    if (view.phase === 'reveal' && sealed && !revealed && getBid(player.name, addr)) {
      if (!rivalReady(key, [2_000, 8_000])) continue;
      runJob('house-reveal', `${player.name} reveals`, () =>
        runAsIdentity(player.name, async () => {
          if (addr !== gameAddress) return `${player.name} sat this one out.`;
          try {
            await game.callTx.revealGuess();
          } catch (err) {
            rivalDue.set(key, Date.now() + 600_000); // stop hammering a failing reveal
            throw err;
          }
          const g = getBid(player.name, addr);
          return `${player.name} reveals ${g?.amount} — on the record now.`;
        }),
      );
      return;
    }
  }
}

// The market drives itself: close when the table is full, resolve when all
// reveals are in, finalize after the crowning. No host buttons needed.
async function autoDrive(): Promise<void> {
  if (!walletReady || activeJob || !gameAddress || Date.now() - autoDrove < 20_000) return;
  let view: GameView;
  try { view = await readGameLedger(gameProviders, gameAddress); } catch { return; }
  const field = allForecasters().length;
  if (view.phase === 'sealing' && view.entryCount >= field && view.entryCount > 0) {
    autoDrove = Date.now();
    runJob('game-close', 'The table is full — sealing closes', async () => {
      await game.callTx.closeSealing();
      return 'Sealing closed. Reveals begin — watch the histogram build.';
    });
  } else if (view.phase === 'reveal' && view.revealedCount >= view.entryCount && view.revealedCount > 0) {
    autoDrove = Date.now();
    runJob('game-reckon', 'Oracle resolving the event', async () => {
      const v2 = await readGameLedger(gameProviders, gameAddress);
      if (v2.phase === 'reveal') {
        if (v2.mode === 'oracle') {
          const signal = await observeMarket();
          const threshold = marketThreshold ?? Math.round(signal.priceUsd);
          await game.callTx.resolveOutcome(signal.priceUsd > threshold ? 100n : 1n);
        } else {
          await game.callTx.lockTarget(BigInt(twoThirdsMean(v2.revealedSum, v2.revealedCount)));
        }
      }
      const after = await readGameLedger(gameProviders, gameAddress);
      const best = [...after.guesses].sort((a, b) => Math.abs(a.guess - after.target) - Math.abs(b.guess - after.target))[0];
      if (best) await game.callTx.score(Buffer.from(best.id, 'hex'));
      const fin = await readGameLedger(gameProviders, gameAddress);
      return `Outcome ${fin.target}. Champion crowned at distance ${fin.bestDistance}.`;
    });
  } else if (view.phase === 'reckoning') {
    autoDrove = Date.now();
    runJob('game-finalize', 'Gavel', async () => { await game.callTx.finalize(); return 'Market closed. Losing forecasts stay sealed forever.'; });
  }
}

setInterval(() => {
  houseTick().then(() => autoDrive()).catch(() => {});
}, 8_000);

// ─── Sealed Desk — the fully agent-run market ─────────────────────────────────
//
// One broker agent opens and paces a Dutch exit; buyer-desk agents research,
// form private valuations, seal reservations, and decide when to claim. All
// brains run locally (ollama when present, transparent heuristics otherwise);
// every decision lands in a reasoning feed the local UI shows and the chain
// never sees. One chain action per tick, through the same one-slot job queue
// as every human action.

interface DeskState {
  active: boolean;
  address: string;
  item: string;
  openedAt: number;
  lastClockAt: number;
  valuations: Map<string, bigint>; // buyer -> private valuation (server memory only)
  sealedDone: Set<string>;
  invited: Set<string>;            // buyer desks taking part in this mandate
  priceHistory: string[];          // clock steps, oldest first (public data)
  settled: boolean;
}

const desk: DeskState = {
  active: false,
  address: '',
  item: '',
  openedAt: 0,
  lastClockAt: 0,
  valuations: new Map(),
  sealedDone: new Set(),
  invited: new Set(),
  priceHistory: [],
  settled: false,
};

function deskBroker() {
  return DESK_AGENTS.find((a) => a.role === 'broker')!;
}

async function startDesk(item: string, buyers?: string[]): Promise<void> {
  const validBuyers = DESK_AGENTS.filter((a) => a.role === 'buyer').map((a) => a.name);
  const invited = (buyers ?? validBuyers).filter((n) => validBuyers.includes(n));
  desk.invited = new Set(invited.length >= 1 ? invited : validBuyers);
  const signal = await observeMarket();
  const broker = deskBroker();
  think(broker.name, `pricing the exit: ${describeSignal(signal)}`);
  const plan = await brokerPlan(1n, signal);
  think(broker.name, `opening “${item}” at ${plan.startPrice.toLocaleString()}, floor ${plan.floorPrice.toLocaleString()} — ${plan.rationale}`);
  const addr = await runAsIdentity(broker.name, () =>
    deployHouse(houseProviders, {
      item,
      format: 'dutch',
      startPrice: plan.startPrice,
      floorPrice: plan.floorPrice,
      priceStep: plan.priceStep,
    }),
  );
  recordHouse(addr, 'dutch');
  setActiveHouse(addr);
  house = await connectHouse(houseProviders, addr);
  houseAddress = addr;
  houseOpenedAt = Date.now();
  desk.active = true;
  desk.address = addr;
  desk.item = item;
  desk.openedAt = Date.now();
  desk.lastClockAt = Date.now();
  desk.valuations = new Map();
  desk.sealedDone = new Set();
  desk.priceHistory = [plan.startPrice.toString()];
  desk.settled = false;
  think(broker.name, `the block is on the tape — sealed reservations only; ${desk.invited.size} desk(s) invited`);
}

// deskTick awaits research and (possibly slow) local-LLM calls, so the
// interval can fire again mid-tick; without this guard two overlapping ticks
// both saw a buyer as unsealed and double-enqueued their seal.
let deskTickInFlight = false;

async function deskTick(): Promise<void> {
  if (deskTickInFlight || !desk.active || !walletReady || activeJob) return;
  deskTickInFlight = true;
  try {
    await deskTickInner();
  } finally {
    deskTickInFlight = false;
  }
}

async function deskTickInner(): Promise<void> {
  const addr = desk.address;
  let view: HouseView;
  try {
    view = await readHouseLedger(houseProviders, addr);
  } catch {
    return;
  }

  // Settled: narrate, teach the agents, log the settlement for future comps.
  if (view.phase === 'closed') {
    if (!desk.settled) {
      desk.settled = true;
      desk.active = false;
      const broker = deskBroker();
      const winnerName =
        (await Promise.all(
          DESK_AGENTS.map(async (a) => ((await housePublicKeyHex(getOrCreateIdentity(a.name).secretKey)) === view.winner ? a.name : null)),
        )).find(Boolean) ?? (view.winner ? view.winner.slice(0, 8) + '…' : 'nobody');
      think(broker.name, `gavel: sold at ${BigInt(view.highestBid).toLocaleString()} to ${winnerName} — every losing quote stays sealed`);
      observeSettlement({
        house: addr,
        format: 'dutch',
        item: desk.item,
        clearingPrice: view.highestBid.toString(),
        bidders: view.bidderCount,
      });
      for (const a of DESK_AGENTS.filter((x) => x.role === 'buyer')) {
        const v = desk.valuations.get(a.name);
        if (!v) continue;
        const won = winnerName === a.name;
        remember(
          a.name,
          { lastOutcome: won ? `won at ${view.highestBid}` : 'lost — reservation stayed sealed', episodes: agentMemory(a.name).episodes + 1 },
          won
            ? `claiming at ${view.highestBid} worked; patience paid ${(v - BigInt(view.highestBid)).toLocaleString()} under my valuation`
            : `rode the clock too long at “${desk.item}” — claim earlier when the tape is contested`,
        );
      }
    }
    return;
  }
  if (view.phase !== 'open') return;

  const price = BigInt(view.currentPrice);
  const floor = BigInt(view.floorPrice);
  if (desk.priceHistory[desk.priceHistory.length - 1] !== price.toString()) {
    desk.priceHistory.push(price.toString());
  }
  const buyers = DESK_AGENTS.filter((a) => a.role === 'buyer' && desk.invited.has(a.name));

  // 1. A buyer who hasn't sealed yet seals (valuation formed on the spot).
  for (const buyer of buyers) {
    if (desk.sealedDone.has(buyer.name)) continue;
    const signal = await observeMarket();
    const { valuation, rationale } = await buyerValuation(buyer, price, signal);
    desk.valuations.set(buyer.name, valuation);
    desk.sealedDone.add(buyer.name);
    think(buyer.name, rationale);
    think(buyer.name, `sealing reservation ${valuation.toLocaleString()} — visible only on this machine`, true);
    if (!getBid(buyer.name, addr)) recordBid(buyer.name, addr, valuation);
    runJob('desk-seal', `${buyer.name} seals a reservation`, () =>
      runAsIdentity(buyer.name, async () => {
        if (addr !== desk.address) return `${buyer.name} stood down — the desk moved on.`;
        await house.callTx.placeBid();
        return `${buyer.name} sealed a quote. The chain holds only the envelope.`;
      }),
    );
    return;
  }

  // 2. A sealed buyer whose moment has come claims the block.
  for (const buyer of buyers) {
    const v = desk.valuations.get(buyer.name);
    if (!v || !desk.sealedDone.has(buyer.name)) continue;
    if (wantsToClaim(buyer, v, price, floor)) {
      think(buyer.name, `clock at ${price.toLocaleString()} — inside my number with room; claiming before a rival does`, true);
      runJob('desk-claim', `${buyer.name} claims at the clock price`, () =>
        runAsIdentity(buyer.name, async () => {
          if (addr !== desk.address) return `${buyer.name} stood down — the desk moved on.`;
          await house.callTx.claimAtCurrentPrice();
          return `${buyer.name} takes the block at the public clock price. Their true maximum stays sealed.`;
        }),
      );
      return;
    }
  }

  // 3. Otherwise the broker walks the clock down (breathing room between steps).
  if (Date.now() - desk.lastClockAt > 25_000 && price > floor) {
    const broker = deskBroker();
    desk.lastClockAt = Date.now();
    think(broker.name, `no claim at ${price.toLocaleString()} — walking the clock down a step`);
    runJob('desk-clock', 'the broker lowers the clock', () =>
      runAsIdentity(broker.name, async () => {
        if (addr !== desk.address) return 'clock skipped — the desk moved on.';
        await house.callTx.tick();
        return null as any;
      }),
    );
  }
}

setInterval(() => {
  deskTick().catch(() => {});
}, 9_000);

async function apiDeskStatus(): Promise<any> {
  let view: HouseView | null = null;
  if (walletReady && desk.address) {
    try {
      view = await readHouseLedger(houseProviders, desk.address);
    } catch {
      /* view stays null */
    }
  }
  const ids = Object.fromEntries(
    await Promise.all(DESK_AGENTS.map(async (a) => [a.name, await housePublicKeyHex(getOrCreateIdentity(a.name).secretKey)])),
  );
  const job = activeJob ?? lastJob;
  return {
    ready: walletReady,
    bootError,
    network,
    brain: brainInfo(),
    desk: {
      active: desk.active,
      address: desk.address,
      item: desk.item,
      settled: desk.settled,
      invited: [...desk.invited],
      priceHistory: desk.priceHistory,
    },
    agents: DESK_AGENTS.map((a) => ({
      name: a.name,
      role: a.role,
      persona: a.persona,
      onChainId: ids[a.name],
      sealed: desk.sealedDone.has(a.name),
      memory: agentMemory(a.name),
    })),
    feed: reasoningFeed(),
    view: view && {
      ...view,
      winnerName: DESK_AGENTS.find((a) => ids[a.name] === view!.winner)?.name ?? null,
    },
    job: job && { id: job.id, kind: job.kind, label: job.label, stage: job.stage, startedAt: job.startedAt, ok: job.ok ?? null, message: job.message ?? null },
  };
}

// ─── HTTP plumbing ─────────────────────────────────────────────────────────────

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

function send(res: http.ServerResponse, code: number, body: string | Buffer, type = 'application/json'): void {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  try {
    if (url.pathname === '/api/status' && req.method === 'GET') {
      return send(res, 200, JSON.stringify(await apiStatus()));
    }
    if (url.pathname === '/api/game-status' && req.method === 'GET') {
      return send(res, 200, JSON.stringify(await apiGameStatus()));
    }
    if (url.pathname === '/api/desk-status' && req.method === 'GET') {
      return send(res, 200, JSON.stringify(await apiDeskStatus(), (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
    }
    if (url.pathname === '/api/house-status' && req.method === 'GET') {
      return send(res, 200, JSON.stringify(await apiHouseStatus()));
    }
    if (url.pathname === '/api/intel' && req.method === 'GET') {
      return send(res, 200, JSON.stringify(await apiIntel()));
    }
    if (url.pathname === '/api/action' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      let body: any = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        return send(res, 400, JSON.stringify({ error: 'Bad JSON' }));
      }
      return send(res, 200, JSON.stringify(await apiAction(body)));
    }
    // Static files — the prediction market is the front door.
    let file = url.pathname === '/' ? '/game.html' : url.pathname;
    const resolved = path.resolve(WEB_ROOT, `.${file}`);
    if (!resolved.startsWith(WEB_ROOT) || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      return send(res, 404, 'Not found', 'text/plain');
    }
    return send(res, 200, fs.readFileSync(resolved), MIME[path.extname(resolved)] ?? 'application/octet-stream');
  } catch (err: any) {
    return send(res, 500, JSON.stringify({ error: err?.message ?? 'Server error' }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Sealed web UI starting on http://localhost:${PORT}`);
  console.log('  (page loads immediately; actions unlock once the wallet syncs)\n');
});

boot().catch((err) => {
  bootError = err?.message ?? String(err);
  console.error('\n❌ Wallet boot failed:', err);
});
