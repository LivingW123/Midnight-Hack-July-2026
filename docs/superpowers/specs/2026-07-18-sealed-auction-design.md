# Sealed — Private Sealed-Bid Auctions on Midnight

**Date:** 2026-07-18 · **Target:** Midnight Hackathon (deadline 2026-07-19 10:45am CDT) · **Track:** DeFi

## Goal

A first-price sealed-bid auction DApp where bid amounts are cryptographically hidden
on-chain. After bidding closes, bidders reveal to the contract in zero knowledge:
the contract verifies each bid against its commitment and tracks the highest bid —
but losing bid values never appear on the public ledger. Only the winner's identity
(a pseudonymous id) and the winning price become public, because settlement needs them.

Why it matters (business value): sealed-bid auctions on transparent chains leak every
bid to front-runners and competitors. This design gives MEV-resistant auctions and
private OTC/procurement bidding with mathematically verifiable outcomes.

## Scope

- Replace the hello-world contract with `contracts/sealed-auction.compact`.
- Rewrite `src/cli.ts` as an interactive multi-bidder auction CLI.
- E2E test script exercising the full flow on the local devnet.
- Judge-focused README.
- Explicitly out of scope unless everything is green with hours to spare: web UI,
  testnet deploy, escrow/settlement of funds (auction picks a winner; payment is
  out of band and documented as future work).

## Contract

Ledger (public on-chain state):
- `phase: Phase` — enum `open | reveal | closed`.
- `item: Opaque<"string">` — what's being auctioned (set in constructor).
- `owner: Bytes<32>` — seller id = hash(seller secret key); only owner advances phases.
- `bids: Map<Bytes<32>, Bytes<32>>` — bidderId → `persistentCommit(bid, nonce)`.
- `bidderCount: Counter`.
- `highestBid: Uint<64>` — current highest *revealed* bid (0 until first reveal).
- `winner: Bytes<32>` — bidderId of current highest revealer.

Witnesses (private, live in the bidder's local private state, never on-chain):
- `secretKey(): Bytes<32>` — bidder/seller identity secret.
- `bidAmount(): Uint<64>` and `bidNonce(): Bytes<32>` — the sealed bid.

Circuits:
- `constructor(itemDesc)` — sets item, phase=open, owner=hash(secretKey()).
- `placeBid()` — assert phase==open; assert caller hasn't already bid;
  insert `bids[hash(secretKey())] = persistentCommit(bidAmount(), bidNonce())`;
  increment counter. The commitment is hiding+binding: observers learn nothing
  about the amount, and the bidder can't change it later.
- `closeBidding()` — assert phase==open and caller==owner; phase=reveal.
- `revealBid()` — assert phase==reveal; recompute the commitment from witnesses and
  assert it equals `bids[hash(secretKey())]` (proves the opening in ZK); if
  `bidAmount() > highestBid`, disclose and write `highestBid` and `winner`;
  otherwise write nothing about the amount.
- `finalize()` — assert phase==reveal and caller==owner; phase=closed. Winner is
  whoever leads at finalize; unrevealed bids forfeit (standard commit-reveal rule).

Privacy properties (document in README):
1. During bidding: only opaque commitments on-chain.
2. After reveal: losing bid *values* still never on-chain. A losing reveal leaks one
   bit ("≤ current highest at reveal time") — inherent to on-chain max-tracking.
3. Winner's bid is public by design (settlement price).
4. Bidder identities are pseudonymous hashes of local secrets.

Implementation note: exact Compact stdlib API (Map methods, enum syntax, disclose
rules for witness-derived branches) to be validated against compiler 0.31.x during
implementation; the compiler is the ground truth. Pattern reference: the official
bboard example (same commit/publicKey idiom).

## CLI

Interactive menu (rewrite of `src/cli.ts`, reusing scaffold providers/wallet):
- **Create auction** (as seller) — deploys the contract with an item description.
- **Switch identity** — named identities (seller, alice, bob, …); each gets its own
  private-state instance (own secretKey/bid/nonce) while sharing the funded devnet
  wallet for tx fees.
- **Place bid / Close bidding / Reveal bid / Finalize** — phase actions with clear
  error messages when out of phase.
- **Show on-chain view** — prints the raw public ledger (commitment hex, phase,
  highestBid, winner) so the demo visibly proves bids are opaque. Demo centerpiece.
- **Show my private state** — contrast: your bid/nonce as stored locally.

## Testing

`scripts/e2e-check.ts` against the local devnet (`npm run test:e2e`):
3 bidders with distinct amounts; reveal in an order where the winner reveals first
(worst case for the leak analysis); assert final winner and highestBid are correct;
assert phase guards reject out-of-phase actions; assert losing amounts appear nowhere
in the indexer-visible contract state.

## Error handling

- In-circuit `assert` guards every phase/ownership rule (wrong-phase txs fail to prove).
- CLI validates inputs (positive integer bids), prints actionable messages on proof
  failures, reuses existing proof-server wait logic from the scaffold.

## Unchanged

docker-compose devnet, `src/setup.ts` / `deploy.ts` / wallet code, npm scripts
(compile/setup/cli/test:e2e keep working).
