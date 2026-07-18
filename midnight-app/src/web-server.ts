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
} from './identities';

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
  walletReady = true;
  console.log(`\n  Sealed is ready → http://localhost:${PORT}\n`);
}

// ─── API handlers ──────────────────────────────────────────────────────────────

async function apiStatus(): Promise<any> {
  const me = currentIdentity();
  // Hide e2e test fixtures from the paddle rack (still usable by typing the name).
  const identities = listIdentities().filter((n) => !n.startsWith('e2e-'));
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
    default:
      return { error: `Unknown action: ${type}` };
  }
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
