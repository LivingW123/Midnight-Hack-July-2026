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
  const players = Object.fromEntries(
    await Promise.all(
      [...HOUSE_PLAYERS.map((p) => p.name), me.name].map(async (n) => [
        await publicKeyHex(getOrCreateIdentity(n).secretKey),
        n,
      ]),
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
      const question = String(body?.question ?? '').trim().slice(0, 140) ||
        'Guess a number from 1 to 100. Closest to two-thirds of the mean wins.';
      runJob('game-new', 'Opening a new Number Game', async () => {
        const addr = await deployGame(gameProviders, question);
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
    case 'game-reckon': {
      // Fix the target, then crown the true closest — one proof each. The
      // reckoning is permissionless: a wrong target cannot prove, and anyone
      // could score a closer entrant if we picked the wrong one.
      runJob('game-reckon', 'Fixing the target and crowning the champion', async () => {
        const view = await readGameLedger(gameProviders, gameAddress);
        if (view.phase === 'reveal') {
          const target = twoThirdsMean(view.revealedSum, view.revealedCount);
          await game.callTx.lockTarget(BigInt(target));
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
  name: string;
  think: () => number; // their guess, with personality noise
  patienceMs: [number, number];
}

const rand = (lo: number, hi: number) => lo + Math.floor(Math.random() * (hi - lo + 1));

const HOUSE_PLAYERS: HousePlayer[] = [
  { name: 'meridian', think: () => rand(44, 58), patienceMs: [5_000, 20_000] },   // level 0: "average is 50"
  { name: 'vesper', think: () => rand(29, 37), patienceMs: [8_000, 25_000] },     // level 1: 2/3 of 50
  { name: 'orpheus', think: () => rand(19, 25), patienceMs: [12_000, 32_000] },   // level 2: 2/3 of 33
  { name: 'juno', think: () => rand(1, 100), patienceMs: [4_000, 15_000] },       // chaos: pure noise
  { name: 'the-theorist', think: () => rand(1, 4), patienceMs: [15_000, 40_000] } // Nash: plays 0-ish, rarely wins
];

const housePlans = new Map<string, number>();

async function houseTick(): Promise<void> {
  if (!walletReady || activeJob || !gameAddress) return;
  let view: GameView;
  try {
    view = await readGameLedger(gameProviders, gameAddress);
  } catch {
    return;
  }
  const addr = gameAddress;

  for (const player of HOUSE_PLAYERS) {
    const key = `${addr}:${player.name}:${view.phase}`;
    const myId = await publicKeyHex(getOrCreateIdentity(player.name).secretKey);
    const sealed = view.entries.some((e) => e.id === myId);
    const revealed = view.guesses.some((g) => g.id === myId);

    if (view.phase === 'sealing' && !sealed) {
      if (!rivalReady(key, player.patienceMs)) continue;
      if (!getBid(player.name, addr)) recordBid(player.name, addr, BigInt(player.think()));
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
      if (!rivalReady(key, [3_000, 14_000])) continue;
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

setInterval(() => {
  houseTick().catch(() => {});
}, 8_000);

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
    // Static files
    let file = url.pathname === '/' ? '/index.html' : url.pathname;
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
