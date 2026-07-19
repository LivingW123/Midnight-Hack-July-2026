/**
 * Unit checks for the intelligence engines. Pure functions over synthetic
 * event logs — no chain, no wallet, runs in milliseconds.
 *
 * The point of these is not coverage; it is that the detector fires on a
 * planted shill and stays quiet on an honest field. A fraud score that flags
 * everyone is worse than none at all, so the negative cases matter more than
 * the positive one.
 */
import { detectShills, adviseReserve, type BidEvent, type SettlementEvent } from '../src/intel';

let failures = 0;
function check(cond: boolean, label: string): void {
  if (cond) console.log(`  ✅ ${label}`);
  else {
    failures++;
    console.error(`  ❌ ${label}`);
  }
}

const T0 = 1_700_000_000_000;
const bid = (o: Partial<BidEvent> & Pick<BidEvent, 'house' | 'bidderId' | 'index' | 'at'>): BidEvent => ({
  format: 'firstPrice',
  revealed: true,
  isSeller: false,
  ...o,
});

console.log('\nIntel engine checks\n');

// ─── Shill detection ─────────────────────────────────────────────────────────

console.log('─── never-opens ────────────────────────────────────────────────');
{
  // A paddle that seals bids across four auctions and opens none of them.
  // The honest comparison bidder must look genuinely human: irregular gaps
  // (otherwise machine-cadence correctly fires) and not present in every one
  // of the same auctions (otherwise shadowing correctly fires).
  const shillAt = [0, 900_000, 1_800_000, 2_700_000];
  const honestAt = [140_000, 1_050_000];
  const events: BidEvent[] = [];
  shillAt.forEach((offset, i) => {
    events.push(bid({ house: `h${i}`, bidderId: 'shill', index: 0, at: T0 + offset, revealed: false }));
  });
  honestAt.forEach((offset, i) => {
    events.push(bid({ house: `h${i}`, bidderId: 'honest', index: 1, at: T0 + offset }));
  });
  const found = detectShills('h0', events);
  const shill = found.find((f) => f.bidderId === 'shill')!;
  const honest = found.find((f) => f.bidderId === 'honest')!;
  check(shill.signals.some((s) => s.name === 'never-opens'), 'never-opens fires on a paddle that never reveals');
  check(shill.risk > honest.risk, 'the never-opening paddle outranks the honest one');
  check(honest.band === 'clear', 'honest bidder stays in the clear band');
}

console.log('\n─── honest field stays quiet ───────────────────────────────────');
{
  // Four independent bidders, irregular human timing, all reveal.
  const gaps = [0, 47_000, 210_000, 95_000];
  const events = gaps.map((g, i) =>
    bid({ house: 'h', bidderId: `b${i}`, index: i, at: T0 + gaps.slice(0, i + 1).reduce((a, b) => a + b, 0) }),
  );
  const found = detectShills('h', events);
  check(found.length === 4, 'scored all four bidders');
  check(found.every((f) => f.band === 'clear'), 'no false positives on an honest field');
  check(found.every((f) => f.risk === 0), 'honest field scores zero risk');
}

console.log('\n─── reflexive timing ───────────────────────────────────────────');
{
  // "tail" bids immediately behind "target" in three separate auctions.
  const events: BidEvent[] = [];
  for (let i = 0; i < 3; i++) {
    events.push(bid({ house: 'h', bidderId: 'target', index: i * 2, at: T0 + i * 300_000 }));
    events.push(bid({ house: 'h', bidderId: 'tail', index: i * 2 + 1, at: T0 + i * 300_000 + 8_000 }));
  }
  const found = detectShills('h', events);
  const tail = found.find((f) => f.bidderId === 'tail')!;
  check(tail.signals.some((s) => s.name === 'reflexive-timing'), 'reflexive-timing fires on a consistent follower');
  check(tail.risk >= 25, 'follower lands at least in the watch band');
}

console.log('\n─── seller-adjacent ────────────────────────────────────────────');
{
  const events: BidEvent[] = [
    bid({ house: 'h', bidderId: 'seller', index: 0, at: T0, isSeller: true }),
    bid({ house: 'h', bidderId: 'puppet', index: 1, at: T0 + 4_000 }),
    bid({ house: 'h', bidderId: 'stranger', index: 2, at: T0 + 600_000 }),
  ];
  const found = detectShills('h', events);
  check(
    found.find((f) => f.bidderId === 'puppet')!.signals.some((s) => s.name === 'seller-adjacent'),
    'seller-adjacent fires on a bid seconds after the seller acts',
  );
  check(
    !found.find((f) => f.bidderId === 'stranger')!.signals.some((s) => s.name === 'seller-adjacent'),
    'a bidder ten minutes later does not trip it',
  );
  check(!found.some((f) => f.bidderId === 'seller'), 'the seller is not scored as a bidder');
}

console.log('\n─── privacy invariant ──────────────────────────────────────────');
{
  // The whole engine must never need a bid value: BidEvent has no amount
  // field, so this is a type-level guarantee. Assert it at runtime too.
  const events = [bid({ house: 'h', bidderId: 'x', index: 0, at: T0 })];
  const serialized = JSON.stringify(detectShills('h', events));
  check(!/amount|value|price/i.test(serialized), 'no bid value appears anywhere in detector output');
  check(!('amount' in events[0]), 'BidEvent carries no bid amount to begin with');
}

// ─── Reserve advice ──────────────────────────────────────────────────────────

const settled = (price: string, format = 'firstPrice'): SettlementEvent => ({
  house: `s${price}`,
  format,
  item: 'x',
  clearingPrice: price,
  bidders: 3,
  at: T0,
});

console.log('\n─── reserve advice ─────────────────────────────────────────────');
{
  const comps = [settled('1000'), settled('1200'), settled('1400')];

  const hot = adviseReserve({ format: 'firstPrice', bidders: 5, age: 2 * 60_000, sinceLastBid: 5_000 }, comps);
  check(hot.action === 'raise', 'hot demand (5 bids in 2 min) recommends raising');
  check(hot.suggested === '1380', 'raise suggestion is 115% of the 1200 median');

  const cold = adviseReserve({ format: 'firstPrice', bidders: 0, age: 20 * 60_000, sinceLastBid: null }, comps);
  check(cold.action === 'lower', 'a dead lot after 20 min recommends lowering');
  check(cold.suggested === '960', 'lower suggestion is 80% of the 1200 median');

  const forming = adviseReserve({ format: 'firstPrice', bidders: 2, age: 4 * 60_000, sinceLastBid: 30_000 }, comps);
  check(forming.action === 'hold', 'a forming field holds');

  const noComps = adviseReserve({ format: 'firstPrice', bidders: 1, age: 60_000, sinceLastBid: 10_000 }, []);
  check(noComps.suggested === null, 'no comparables yields no number rather than a guess');
  check(noComps.confidence <= 0.4, 'confidence stays low without history');
  check(hot.confidence > noComps.confidence, 'confidence rises with evidence');

  // Dutch floor must never be undercut.
  const dutch = adviseReserve(
    {
      format: 'dutch',
      bidders: 0,
      age: 20 * 60_000,
      sinceLastBid: null,
      currentPrice: 900n,
      floorPrice: 800n,
    },
    [settled('100', 'dutch'), settled('100', 'dutch')],
  );
  check(BigInt(dutch.suggested!) >= 800n, 'a suggestion below the Dutch floor is clipped to the floor');
}

console.log('\n────────────────────────────────────────────────────────────────');
if (failures === 0) {
  console.log('✅ all intel checks passed\n');
  process.exit(0);
}
console.error(`❌ ${failures} check(s) failed\n`);
process.exit(1);
