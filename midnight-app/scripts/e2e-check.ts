/**
 * End-to-end flow test for the sealed-bid auction.
 *
 * Deploys a fresh auction on the active network, runs the whole
 * commit → close → reveal → finalize lifecycle with three bidders, and
 * asserts the two claims the project makes:
 *
 *   1. Correctness — the highest revealed bid wins, phase guards reject
 *      out-of-phase actions.
 *   2. Privacy — losing bid amounts NEVER appear in indexer-visible contract
 *      state, before or after reveal. (Amounts are chosen so their 8-byte
 *      encodings cannot occur by coincidence.)
 *
 * Reveal order is worst-case for privacy: the eventual winner reveals FIRST,
 * so every later reveal is a losing reveal.
 */
import { WebSocket } from 'ws';
import { Buffer } from 'node:buffer';
import * as Rx from 'rxjs';

import { resolveNetwork, getOrCreateSeed } from '../src/network';
import { createWallet, persistWalletState } from '../src/wallet';
import {
  createProviders,
  deployAuction,
  connectAuction,
  readAuctionLedger,
  setActiveContract,
  publicKeyHex,
} from '../src/auction-api';
import { setCurrentIdentity, recordBid, getOrCreateIdentity } from '../src/identities';

// @ts-expect-error wallet sync requires WebSocket
globalThis.WebSocket = WebSocket;

const { network, config: networkConfig } = resolveNetwork();
const SEED = getOrCreateSeed(network);

// Distinctive amounts: their 8-byte encodings can't appear in ledger bytes by
// coincidence, making the "losing bids never on-chain" assertion meaningful.
const AMOUNTS: Record<string, bigint> = {
  'e2e-alice': 1_311_768_467_463_790_320n, // 0x1234567890abcdf0 — the winner
  'e2e-bob': 9_007_199_254_740_991n,       // 0x001fffffffffffff
  'e2e-carol': 3_735_928_559_000n,         // 0x00000365f9cdff98
};
const WINNER = 'e2e-alice';

let failures = 0;
function check(cond: boolean, label: string): void {
  if (cond) {
    console.log(`  ✅ ${label}`);
  } else {
    failures++;
    console.error(`  ❌ ${label}`);
  }
}

function amountPatterns(n: bigint): string[] {
  const be = n.toString(16).padStart(16, '0');
  const le = Buffer.from(be, 'hex').reverse().toString('hex');
  return [be, le, n.toString()]; // hex big-endian, hex little-endian, decimal
}

/** Everything the indexer exposes about the contract, flattened to one
 * searchable string: raw serialized state (when available) + parsed view. */
async function stateHaystack(providers: any, addr: string): Promise<string> {
  const parts: string[] = [];
  try {
    const cs = await providers.publicDataProvider.queryContractState(addr);
    const data: any = cs?.data;
    if (data && typeof data.serialize === 'function') {
      parts.push(Buffer.from(data.serialize()).toString('hex'));
    } else if (data instanceof Uint8Array) {
      parts.push(Buffer.from(data).toString('hex'));
    } else if (data && typeof data.toString === 'function') {
      parts.push(String(data.toString()));
    }
  } catch {
    // raw form unavailable — parsed view below still covers ledger contents
  }
  const view = await readAuctionLedger(providers, addr);
  parts.push(JSON.stringify(view, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  parts.push(view.bids.map((b) => b.commitment).join(''));
  return parts.join('|').toLowerCase();
}

function assertAmountAbsent(haystack: string, name: string, label: string): void {
  const found = amountPatterns(AMOUNTS[name]).some((p) => haystack.includes(p.toLowerCase()));
  check(!found, `${label}: ${name}'s amount not present in on-chain state`);
}

/** Retry a tx on transient DUST-projection shortages (same race the deploy
 * path handles — wall-clock DUST projection lags block timestamps). */
async function tx(label: string, fn: () => Promise<any>): Promise<any> {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      console.log(`  → ${label}...`);
      return await fn();
    } catch (err: any) {
      const full = `${err?.message ?? ''} ${err?.cause?.message ?? ''}`;
      const dust = full.includes('Not enough Dust') || full.includes('Insufficient Funds') || full.includes('could not balance dust');
      if (!dust || attempt === 5) throw err;
      console.log(`    (DUST still generating, retry ${attempt}/5 in 5s)`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

async function expectReject(label: string, fn: () => Promise<any>): Promise<void> {
  try {
    await fn();
    check(false, `${label} (expected rejection, but it succeeded)`);
  } catch {
    check(true, label);
  }
}

async function main() {
  console.log(`\nSealed-auction e2e — network: ${network}\n`);

  console.log('─── Setup ──────────────────────────────────────────────────────');
  const walletCtx = await createWallet({ network, networkConfig, seed: SEED });
  await walletCtx.wallet.waitForSyncedState();
  await persistWalletState(network, walletCtx);
  const providers = await createProviders(walletCtx, networkConfig);
  console.log('  wallet synced, providers ready');

  // 1. Deploy a fresh auction as the e2e seller.
  setCurrentIdentity('e2e-seller');
  const addr = await tx('deploy fresh auction', () => deployAuction(providers, 'e2e test lot'));
  setActiveContract(addr);
  const auction = await connectAuction(providers, addr);
  console.log(`  auction at ${addr}`);

  let view = await readAuctionLedger(providers, addr);
  check(view.phase === 'open', 'fresh auction starts in OPEN phase');
  check(view.bidderCount === 0, 'fresh auction has zero bids');
  check(view.item === 'e2e test lot', 'item description readable on-chain');
  check(view.owner === (await publicKeyHex(getOrCreateIdentity('e2e-seller').secretKey)), 'owner id matches seller identity');

  // 2. Three sealed bids.
  console.log('\n─── Commit phase ───────────────────────────────────────────────');
  for (const name of Object.keys(AMOUNTS)) {
    setCurrentIdentity(name);
    recordBid(name, addr, AMOUNTS[name]);
    await tx(`placeBid as ${name}`, () => auction.callTx.placeBid());
  }
  view = await readAuctionLedger(providers, addr);
  check(view.bidderCount === 3, 'three sealed bids recorded');
  check(new Set(view.bids.map((b) => b.commitment)).size === 3, 'three distinct commitments on-chain');

  let haystack = await stateHaystack(providers, addr);
  for (const name of Object.keys(AMOUNTS)) assertAmountAbsent(haystack, name, 'commit phase');

  // 3. Double-bid guard.
  setCurrentIdentity('e2e-bob');
  await expectReject('double bid by same identity rejected', () => auction.callTx.placeBid());

  // 4. Non-seller cannot close; seller closes.
  console.log('\n─── Close ──────────────────────────────────────────────────────');
  await expectReject('non-seller closeBidding rejected', () => auction.callTx.closeBidding());
  setCurrentIdentity('e2e-seller');
  await tx('closeBidding as seller', () => auction.callTx.closeBidding());
  view = await readAuctionLedger(providers, addr);
  check(view.phase === 'reveal', 'phase advanced to REVEAL');

  // 5. Late bid rejected.
  setCurrentIdentity('e2e-mallory');
  recordBid('e2e-mallory', addr, 999_999_999_999n);
  await expectReject('late bid after close rejected', () => auction.callTx.placeBid());

  // 6. Reveals — winner first (worst case: all later reveals are losers).
  console.log('\n─── Reveal phase ───────────────────────────────────────────────');
  const order = [WINNER, ...Object.keys(AMOUNTS).filter((n) => n !== WINNER)];
  for (const name of order) {
    setCurrentIdentity(name);
    await tx(`revealBid as ${name}`, () => auction.callTx.revealBid());
  }
  view = await readAuctionLedger(providers, addr);
  const winnerId = await publicKeyHex(getOrCreateIdentity(WINNER).secretKey);
  check(view.winner === winnerId, `winner is ${WINNER}`);
  check(view.highestBid === AMOUNTS[WINNER], 'winning price on-chain equals winning bid');

  haystack = await stateHaystack(providers, addr);
  for (const name of Object.keys(AMOUNTS)) {
    if (name !== WINNER) assertAmountAbsent(haystack, name, 'after all reveals');
  }

  // 7. Finalize; then no further reveals.
  console.log('\n─── Finalize ───────────────────────────────────────────────────');
  setCurrentIdentity('e2e-seller');
  await tx('finalize as seller', () => auction.callTx.finalize());
  view = await readAuctionLedger(providers, addr);
  check(view.phase === 'closed', 'phase advanced to CLOSED');
  setCurrentIdentity('e2e-carol');
  await expectReject('reveal after finalize rejected', () => auction.callTx.revealBid());

  haystack = await stateHaystack(providers, addr);
  for (const name of Object.keys(AMOUNTS)) {
    if (name !== WINNER) assertAmountAbsent(haystack, name, 'final state');
  }

  await persistWalletState(network, walletCtx);
  await walletCtx.wallet.stop();

  console.log(`\n${failures === 0 ? '✅ e2e passed' : `❌ e2e finished with ${failures} failing check(s)`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n❌ e2e crashed:', err);
  process.exit(1);
});
