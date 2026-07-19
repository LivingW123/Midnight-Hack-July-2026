/**
 * End-to-end flow test for the multi-format Auction House.
 *
 * Each format makes a claim that a transparent chain could not make. This
 * script deploys a real contract per format on the active network and checks
 * the claim against indexer-visible state:
 *
 *   dutch          The winner's reservation price NEVER appears on-chain — not
 *                  in the commitment, not on winning. Only the public clock
 *                  price does. This is the strongest claim in the project.
 *   batch          Every winner clears at the SAME price (the lowest winning
 *                  bid), and bids that fall off the ladder stay sealed.
 *   candle         A bid that arrived after the secret end-index cannot
 *                  reveal, and the index was committed before any bid landed.
 *   combinatorial  lockAllocation picks the revenue-maximising partition of
 *                  the three lots, not merely a seller-asserted one.
 *
 * Run a single format with: npm run test:house -- dutch
 */
import { WebSocket } from 'ws';
import { Buffer } from 'node:buffer';

import { resolveNetwork, getOrCreateSeed } from '../src/network';
import { createWallet, persistWalletState } from '../src/wallet';
import {
  createHouseProviders,
  deployHouse,
  connectHouse,
  readHouseLedger,
  setActiveHouse,
  housePublicKeyHex,
  type FormatName,
} from '../src/house-api';
import { setCurrentIdentity, recordBid, getOrCreateIdentity } from '../src/identities';

// @ts-expect-error wallet sync requires WebSocket
globalThis.WebSocket = WebSocket;

const { network, config: networkConfig } = resolveNetwork();
const SEED = getOrCreateSeed(network);

let failures = 0;
function check(cond: boolean, label: string): void {
  if (cond) console.log(`  ✅ ${label}`);
  else {
    failures++;
    console.error(`  ❌ ${label}`);
  }
}

/** hex big-endian, hex little-endian, decimal — all three encodings of a value. */
function amountPatterns(n: bigint): string[] {
  const be = n.toString(16).padStart(16, '0');
  const le = Buffer.from(be, 'hex').reverse().toString('hex');
  return [be, le, n.toString()];
}

/** Everything the indexer exposes, flattened into one searchable string. */
async function stateHaystack(providers: any, addr: string): Promise<string> {
  const parts: string[] = [];
  try {
    const cs = await providers.publicDataProvider.queryContractState(addr);
    const data: any = cs?.data;
    if (data && typeof data.serialize === 'function') parts.push(Buffer.from(data.serialize()).toString('hex'));
    else if (data instanceof Uint8Array) parts.push(Buffer.from(data).toString('hex'));
    else if (data?.toString) parts.push(String(data.toString()));
  } catch {
    // raw form unavailable — the parsed view below still covers ledger contents
  }
  const view = await readHouseLedger(providers, addr);
  parts.push(JSON.stringify(view, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  return parts.join('|').toLowerCase();
}

function assertAbsent(haystack: string, value: bigint, label: string): void {
  const found = amountPatterns(value).some((p) => haystack.includes(p.toLowerCase()));
  check(!found, label);
}

async function tx(label: string, fn: () => Promise<any>): Promise<any> {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      console.log(`  → ${label}...`);
      return await fn();
    } catch (err: any) {
      const full = `${err?.message ?? ''} ${err?.cause?.message ?? ''}`;
      const dust =
        full.includes('Not enough Dust') ||
        full.includes('Insufficient Funds') ||
        full.includes('could not balance dust');
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

async function idOf(name: string): Promise<string> {
  return housePublicKeyHex(getOrCreateIdentity(name).secretKey);
}

// ─── dutch ───────────────────────────────────────────────────────────────────

async function testDutch(providers: any): Promise<void> {
  console.log('\n═══ Dutch — hidden bidder demand ═══════════════════════════════');
  // Whale's true reservation is far above where they will actually claim. The
  // gap is the whole point: a transparent auction would leak it.
  const WHALE_RESERVATION = 8_070_450_532_247_928_833n; // 0x70000000000000 01-ish, distinctive
  const START = 1000n;
  const STEP = 100n;
  const FLOOR = 200n;

  setCurrentIdentity('e2e-h-seller');
  const addr = await tx('deploy dutch auction', () =>
    deployHouse(providers, {
      item: 'e2e dutch lot',
      format: 'dutch',
      startPrice: START,
      floorPrice: FLOOR,
      priceStep: STEP,
    }),
  );
  setActiveHouse(addr);
  const house = await connectHouse(providers, addr);

  let view = await readHouseLedger(providers, addr);
  check(view.format === 'dutch', 'format recorded as dutch');
  check(view.currentPrice === START, `opening price is ${START}`);

  // Whale seals a reservation far above the current clock price.
  setCurrentIdentity('e2e-whale');
  recordBid('e2e-whale', addr, WHALE_RESERVATION);
  await tx('seal reservation as whale', () => house.callTx.placeBid());

  let haystack = await stateHaystack(providers, addr);
  assertAbsent(haystack, WHALE_RESERVATION, 'after sealing: reservation absent from chain state');

  // Claiming while the clock is still above the reservation must fail... but
  // the whale's reservation is huge, so instead verify the reverse: a bidder
  // whose reservation is BELOW the clock cannot claim.
  setCurrentIdentity('e2e-minnow');
  recordBid('e2e-minnow', addr, 250n); // below the 1000 opening price
  await tx('seal reservation as minnow', () => house.callTx.placeBid());
  await expectReject('claim rejected when reservation < current price', () =>
    house.callTx.claimAtCurrentPrice(),
  );

  // Walk the clock down two steps, then the whale claims.
  await tx('tick (1000 -> 900)', () => house.callTx.tick());
  await tx('tick (900 -> 800)', () => house.callTx.tick());
  view = await readHouseLedger(providers, addr);
  check(view.currentPrice === START - 2n * STEP, `clock descended to ${START - 2n * STEP}`);

  setCurrentIdentity('e2e-whale');
  await tx('claimAtCurrentPrice as whale', () => house.callTx.claimAtCurrentPrice());

  view = await readHouseLedger(providers, addr);
  check(view.winner === (await idOf('e2e-whale')), 'whale won the lot');
  check(view.highestBid === START - 2n * STEP, 'settled at the PUBLIC clock price, not the private reservation');
  check(view.phase === 'closed', 'dutch auction closed on claim');

  // The headline assertion.
  haystack = await stateHaystack(providers, addr);
  assertAbsent(haystack, WHALE_RESERVATION, 'AFTER WINNING: reservation price still absent from chain state');
  assertAbsent(haystack, 250n, 'losing bidder reservation absent from chain state');
}

// ─── batch ───────────────────────────────────────────────────────────────────

async function testBatch(providers: any): Promise<void> {
  console.log('\n═══ Uniform-price batch ════════════════════════════════════════');
  // 2 units, 4 bidders. Top two clear at the SECOND-highest price.
  const BIDS: Record<string, bigint> = {
    'e2e-b1': 5_000_000_007n,
    'e2e-b2': 4_000_000_009n, // clearing price (lowest winner, supply = 2)
    'e2e-b3': 3_000_000_011n, // falls off
    'e2e-b4': 2_000_000_013n, // falls off
  };

  setCurrentIdentity('e2e-h-seller');
  const addr = await tx('deploy batch auction (supply 2)', () =>
    deployHouse(providers, { item: 'e2e batch drop', format: 'batch', supply: 2n }),
  );
  setActiveHouse(addr);
  const house = await connectHouse(providers, addr);

  for (const [name, amount] of Object.entries(BIDS)) {
    setCurrentIdentity(name);
    recordBid(name, addr, amount);
    await tx(`seal bid as ${name}`, () => house.callTx.placeBid());
  }

  setCurrentIdentity('e2e-h-seller');
  await tx('closeBidding', () => house.callTx.closeBidding());

  // Reveal in ascending order — worst case for the insert-sort ladder.
  for (const name of ['e2e-b4', 'e2e-b3', 'e2e-b2', 'e2e-b1']) {
    setCurrentIdentity(name);
    await tx(`revealForBatch as ${name}`, () => house.callTx.revealForBatch());
  }

  await tx('lockClearingPrice', () => house.callTx.lockClearingPrice());
  const view = await readHouseLedger(providers, addr);

  check(view.clearingLocked, 'clearing price locked');
  check(view.clearingPrice === BIDS['e2e-b2'], 'clearing price = lowest winning bid (uniform price)');
  check(view.slots.length >= 2, 'two winning slots filled');
  check(view.slots[0].winner === (await idOf('e2e-b1')), 'top slot is the highest bidder');
  check(view.slots[1].winner === (await idOf('e2e-b2')), 'second slot is the second-highest bidder');
  // Uniform price means the top bidder does NOT pay their own bid.
  check(view.clearingPrice < BIDS['e2e-b1'], 'top bidder pays the clearing price, not their own bid');
}

// ─── candle ──────────────────────────────────────────────────────────────────

async function testCandle(providers: any): Promise<void> {
  console.log('\n═══ Candle — secret close ══════════════════════════════════════');
  // End-index 1 means arrival indices 0 and 1 count; index 2 arrived too late.
  const END_INDEX = 1n;

  setCurrentIdentity('e2e-h-seller');
  const addr = await tx('deploy candle auction', () =>
    deployHouse(providers, { item: 'e2e candle lot', format: 'candle', scheduleTick: END_INDEX }),
  );
  setActiveHouse(addr);
  const house = await connectHouse(providers, addr);

  let view = await readHouseLedger(providers, addr);
  check(!view.scheduleOpen, 'end-index is sealed while bidding is open');

  const ORDER: Array<[string, bigint]> = [
    ['e2e-c1', 700n],  // index 0 — counts
    ['e2e-c2', 900n],  // index 1 — counts, should win
    ['e2e-c3', 5000n], // index 2 — arrived after the candle went out
  ];
  for (const [name, amount] of ORDER) {
    setCurrentIdentity(name);
    recordBid(name, addr, amount);
    await tx(`seal bid as ${name}`, () => house.callTx.placeBid());
  }

  setCurrentIdentity('e2e-h-seller');
  await tx('closeBidding', () => house.callTx.closeBidding());

  // Reveals are barred until the committed end-index is opened.
  setCurrentIdentity('e2e-c1');
  await expectReject('reveal rejected while the end-index is still sealed', () => house.callTx.revealBid());

  setCurrentIdentity('e2e-h-seller');
  await tx('openSchedule (proves the committed end-index)', () => house.callTx.openSchedule());
  view = await readHouseLedger(providers, addr);
  check(view.scheduleOpen && BigInt(view.scheduleTick) === END_INDEX, 'end-index opened and matches the commitment');

  for (const name of ['e2e-c1', 'e2e-c2']) {
    setCurrentIdentity(name);
    await tx(`revealBid as ${name}`, () => house.callTx.revealBid());
  }
  // The late bid cannot reveal, no matter how large it was.
  setCurrentIdentity('e2e-c3');
  await expectReject('bid after the candle went out cannot reveal', () => house.callTx.revealBid());

  view = await readHouseLedger(providers, addr);
  check(view.winner === (await idOf('e2e-c2')), 'winner is the highest bid that arrived in time');
  check(view.highestBid === 900n, 'winning price is the in-time bid, not the larger late one');
  const haystack = await stateHaystack(providers, addr);
  assertAbsent(haystack, 5000n, 'the late bid amount never reached the chain');
}

// ─── combinatorial ───────────────────────────────────────────────────────────

async function testCombinatorial(providers: any): Promise<void> {
  console.log('\n═══ Combinatorial bundles ══════════════════════════════════════');
  // Masks: 1=A, 2=B, 4=C, 3=A+B, 7=A+B+C.
  // Optimal partition here is {A+B}=900 plus {C}=400 => 1300, which beats
  // {A+B+C}=1200 and {A}+{B}+{C}=100+200+400=700.
  const BIDS: Array<[string, bigint, bigint]> = [
    ['e2e-k1', 1200n, 7n], // whole set
    ['e2e-k2', 900n, 3n],  // A+B
    ['e2e-k3', 400n, 4n],  // C
    ['e2e-k4', 100n, 1n],  // A
    ['e2e-k5', 200n, 2n],  // B
  ];

  setCurrentIdentity('e2e-h-seller');
  const addr = await tx('deploy combinatorial auction', () =>
    deployHouse(providers, { item: 'e2e three-lot set', format: 'combinatorial' }),
  );
  setActiveHouse(addr);
  const house = await connectHouse(providers, addr);

  for (const [name, amount, bundle] of BIDS) {
    setCurrentIdentity(name);
    recordBid(name, addr, amount, bundle);
    await tx(`seal bundle bid as ${name} (mask ${bundle})`, () => house.callTx.placeBid());
  }

  setCurrentIdentity('e2e-h-seller');
  await tx('closeBidding', () => house.callTx.closeBidding());

  for (const [name] of BIDS) {
    setCurrentIdentity(name);
    await tx(`revealBundle as ${name}`, () => house.callTx.revealBundle());
  }

  await tx('lockAllocation (enumerates all 5 partitions in-circuit)', () => house.callTx.lockAllocation());
  const view = await readHouseLedger(providers, addr);

  check(view.allocationLocked, 'allocation locked');
  check(view.allocationValue === 1300n, 'allocation value is the revenue-maximising 1300');
  const masks = [...view.allocation].sort((a, b) => a - b);
  check(
    masks.length === 2 && masks[0] === 3 && masks[1] === 4,
    `winning partition is {A+B} + {C} (got masks [${masks.join(', ')}])`,
  );
  // The greedy answer (take the single biggest bundle bid, 1200 for A+B+C) is
  // NOT optimal — proving the circuit really searches.
  check(view.allocationValue > 1200n, 'optimal allocation beats the largest single bundle bid');
}

// ─── driver ──────────────────────────────────────────────────────────────────

const TESTS: Record<string, (p: any) => Promise<void>> = {
  dutch: testDutch,
  batch: testBatch,
  candle: testCandle,
  combinatorial: testCombinatorial,
};

async function main() {
  const requested = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const names = requested.length ? requested : Object.keys(TESTS);
  for (const n of names) {
    if (!TESTS[n]) {
      console.error(`unknown format: ${n} (have: ${Object.keys(TESTS).join(', ')})`);
      process.exit(2);
    }
  }

  console.log(`\nAuction House e2e — network: ${network} — formats: ${names.join(', ')}\n`);
  const walletCtx = await createWallet({ network, networkConfig, seed: SEED });
  await walletCtx.wallet.waitForSyncedState();
  await persistWalletState(network, walletCtx);
  const providers = await createHouseProviders(walletCtx, networkConfig);
  console.log('  wallet synced, providers ready');

  for (const n of names) await TESTS[n](providers);

  console.log('\n────────────────────────────────────────────────────────────────');
  if (failures === 0) {
    console.log('✅ all auction-house checks passed\n');
    process.exit(0);
  }
  console.error(`❌ ${failures} check(s) failed\n`);
  process.exit(1);
}

main().catch((err) => {
  console.error('\n💥 house e2e crashed:', err);
  process.exit(1);
});
