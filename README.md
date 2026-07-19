# Sealed — Private Sealed-Bid Auctions on Midnight

**Auctions where nobody sees your bid. Not the seller, not rival bidders, not even the blockchain.**

Built at the **Midnight Hackathon (July 2026)** — DeFi track.

## What it does

Sealed runs first-price sealed-bid auctions as a confidential smart contract on [Midnight](https://midnight.network). Bidders submit bids that exist on-chain only as cryptographic commitments — hiding the amount, binding the bidder to it. After bidding closes, each bidder reveals *in zero knowledge*: the contract verifies their bid opens their commitment and tracks the highest, but **losing bid amounts never touch the public ledger — ever**. Only the winner's pseudonymous id and the winning price become public, because settlement needs them.

## Five mechanisms, one privacy guarantee

The first-price auction above is the baseline. [`auction-house.compact`](midnight-app/contracts/auction-house.compact)
adds four more mechanisms in a single contract — because what separates them is
not the codebase, it's **what each circuit proves about a commitment without
opening it**.

| Format | The mechanism | What stays private that a transparent chain would leak |
| --- | --- | --- |
| **Dutch** | Price descends in public; bidders seal a reservation price and claim when the clock reaches it | The winner proves `reservation ≥ currentPrice` in zero knowledge. **Even on winning**, how much more they would have paid never reaches the chain — so the seller cannot price-discriminate against them next time |
| **Uniform-price batch** | Up to 3 units clear at a single price: the lowest winning bid | Only bids landing in a winning slot are opened; the rest fall off the ladder unrevealed. Uniform pricing also kills the gas war — sniping buys you nothing |
| **Candle** | Seller commits a secret end-index *before* bidding opens; later bids never counted | The end-index is binding from the first block, so the seller physically cannot move the close to exclude a bid they dislike |
| **Combinatorial** | Bids on bundles of 3 lots (bitmask 1–7) | `lockAllocation` enumerates all five partitions of {A,B,C} **in-circuit** and takes the max — the allocation is *proven* revenue-optimal, not asserted by the seller |
| **Time-locked** | Commit now, reveal later; reveals shut until a committed unlock tick passes | Nobody, including the seller, can open the field early |

The Dutch claim is the one to watch in a demo. `claimAtCurrentPrice` contains no
`disclose()` on the bid amount anywhere — the chain learns the single bit it
needed ("someone will pay at least this") and nothing more. The e2e suite
asserts the reservation price is absent from indexer-visible state both before
the claim and after winning.

```bash
npm run test:house        # all four; or: npm run test:house -- dutch
```

## Auction intelligence — fraud detection that can't become a back door

Two engines run over the house, both under a hard constraint: **bid values are
private, so the usual inputs don't exist for anyone, including us.**

- **Shill radar** scores arrival timing, reveal behaviour and cross-auction
  overlap — never amounts. The strongest available signal turns out to survive
  privacy intact: an account that repeatedly seals bids and *never opens them*
  is driving activity without intending to buy. Signals are named and evidenced;
  weights are set so no single signal can reach the `suspect` band alone.
- **Dynamic reserve** recommends hold / lower / raise from demand *velocity* plus
  comparable settlements. Arrival rate is a better demand proxy than bid size
  anyway — one bidder typing a large number can't move it.

A fraud system that needs plaintext bids becomes a surveillance tool the moment
it's compromised. This one has nothing extra to leak: its input is public by
construction, and the `BidEvent` type carries no amount field at all.

These are explainable statistical detectors, **not** learned models — every score
decomposes into named signals you can argue with. `npm run test:intel` covers the
false-positive cases as heavily as the true ones.

## Why privacy needs this

On a transparent chain, every auction leaks everything: bots front-run your bid the moment it hits the mempool, competitors read your exact valuation off the ledger, and your entire bidding history is public forever. That kills real use cases — procurement tenders, OTC block trades, NFT drops, ad slots — where the bid *is* the strategy. Sealed gives you the outcome transparency an auction needs (verifiable winner, provable rules) with the input privacy it deserves (bids stay sealed), enforced by zero-knowledge proofs rather than by trusting an auctioneer.

## How it works

```
 COMMIT (phase: OPEN)              REVEAL (phase: REVEAL)          CLOSED
 ┌─────────────────────┐           ┌──────────────────────┐        ┌──────────────┐
 │ bidder: amount+nonce│──commit──▶│ prove commitment opens│──────▶│ winner id    │
 │  (stays on machine) │  C(a,n)   │ to (amount, nonce)    │       │ winning price│
 └─────────────────────┘           │ amount disclosed ONLY │       │ (public)     │
   on-chain: opaque                │ if it takes the lead  │       └──────────────┘
   32-byte commitment              └──────────────────────┘   losing amounts: sealed forever
```

Four circuits in [`midnight-app/contracts/sealed-auction.compact`](midnight-app/contracts/sealed-auction.compact):

| Circuit | Who | What it proves in zero knowledge |
| --- | --- | --- |
| `placeBid()` | anyone, once | phase is OPEN, bid > 0; writes `persistentCommit(amount, nonce)` under `hash(secretKey)` |
| `closeBidding()` | seller only | caller's secret hashes to the owner id; advances to REVEAL |
| `revealBid()` | each bidder | witness `(amount, nonce)` opens the stored commitment; discloses the amount to the ledger **only if** it beats the current highest |
| `finalize()` | seller only | closes the auction; highest revealed bid wins |

The bid amount, nonce, and identity secret are Compact *witnesses* — private inputs that live in `.sealed-identities.json` on the bidder's machine and feed proofs generated by a local proof server. The chain sees proofs, never inputs.

**Honest threat model:** a losing reveal leaks one bit ("≤ current highest at reveal time") — inherent to on-chain max-tracking; the winning price is public by design; bidders who never reveal forfeit (standard commit-reveal rule); bidder ids are pseudonymous hashes, so cross-auction correlation is possible if you reuse an identity.

## Run it in 3 commands

Prereqs: Docker Desktop, Node 22+. (Windows: use WSL — see [SETUP.md](SETUP.md).)

```bash
./setup.sh                              # Compact compiler + deps + contract compile
cd midnight-app && npm run setup        # boots local devnet (Docker), deploys an auction
npm run web                             # → http://localhost:4600
```

No wallet extension, no faucet, no tokens needed — the local devnet self-funds.
Prefer a terminal? `npm run cli` drives the same auction interactively.

## The web app

`npm run web` opens the auction house at **http://localhost:4600** — a split-screen
that *is* the privacy argument:

- **Your desk** (left, dark): switch bidding paddles, seal a bid into an envelope —
  amount and nonce rendered from your local file, never sent anywhere.
- **The public record** (right, paper): the live on-chain registry — opaque
  commitments, phase, and eventually the winner. Everything the chain knows fits
  on one printed page, and your amounts are never on it.

The server runs on your machine and wraps the same wallet + local proof server the
CLI uses; the browser is just a window onto it. Each action shows an honest
"generating zero-knowledge proof (~30–60s)" progress strip, and when the gavel
falls, losing envelopes stay sealed — the SOLD stamp only ever names one price.

Two house rivals — **vesper** and **orpheus** — bid on every auction with a little
randomness and reveal on their own, so a solo demo always has competition. They are
real bidders (own secret keys, own sealed bids, same proof pipeline), and their
amounts are hidden from you exactly as yours are hidden from them.

## Sealed Desk — the market run entirely by AI agents

> Every trader is an AI. None of them can spy on each other.

At **http://localhost:4600/desk.html**, nobody clicks "bid." A broker agent
(**maren**) researches the live market, prices a block sale, and opens a Dutch
exit; three buyer desks — **castor** (value), **wren** (momentum), **ibis**
(index) — research, form private valuations, seal them as zero-knowledge
reservations, and decide when to claim as the clock walks down. You put one
block on the tape and watch the whole market trade itself.

What makes it more than theatre:

- **Local brains, provably private.** Agent reasoning runs on a local LLM via
  ollama when one is installed (heuristic personas otherwise) — prompts go to
  `localhost`, never the internet. The agent's budget, valuation, keys, and the
  ZK prover share one machine boundary. The chain sees proofs; nothing else
  leaves.
- **Guardrailed autonomy.** The model adjusts valuations within ±8% and can
  never exceed a hard budget cap or break auction rules — the circuits wouldn't
  prove it anyway.
- **Web research, honestly labelled.** Agents pull a live public benchmark to
  anchor prices and *say in their reasoning* whether they used live or cached
  data.
- **Memory.** Desks carry lessons across auctions ("rode the clock too long —
  claim earlier when contested") and the settlement history doubles as the
  comparables the broker prices from.
- **The floor-chatter feed** shows every thought — private numbers marked
  **LOCAL ONLY** — beside the public tape showing only a descending clock and
  locked envelopes. When a desk claims, it pays the public clock price; its true
  maximum, and every rival quote, stays sealed forever.

Why it matters: AI agents that trade on your behalf are only safe if the market
structurally cannot extract what they know — visible-order markets leak an
agent's strategy to every rival bot. Sealed Desk is the missing settlement
layer for agentic trading: give your agent your true number, because nothing
and nobody can pry it loose.

## The Number Game

Same primitive, second market — at **http://localhost:4600/game.html**. The classic
Keynesian beauty contest: everyone seals a number from 1–100; closest to **⅔ of the
mean** wins. Smart players reason "the average is 50, so I'll say 33 — but they'll
think that too, so 22…" and perfectly rational players spiral to 0. Real people
don't, which is the whole game: winning means modeling how deep *actual humans*
think.

This game is **impossible on a transparent chain** — whoever guesses last would just
read the running average off the ledger — and running it off-chain needs a host you
trust not to peek. Sealed commitments give provably simultaneous guesses with no
trusted host: the first fair, hostless beauty contest.

Five house players join every game, each an explicit level of reasoning: `meridian`
(level‑0, ~50), `vesper` (level‑1, ~33), `orpheus` (level‑2, ~22), `juno` (pure
chaos), and `the-theorist` (plays the Nash equilibrium, almost never wins). Watch
the histogram build as reveals land — it's a live experiment in behavioral
economics, settled by zero-knowledge proofs.

One more circuit trick worth judging: Compact circuits can't divide, so the ⅔-mean
target is fixed by a **verified-quotient proof** — the caller supplies the target
and the contract proves `3·count·target ≤ 2·sum < 3·count·(target+1)` with
multiplications only. A wrong target cannot generate a proof.

## Demo walkthrough (what the video shows)

1. `npm run cli` — connect to the deployed auction ("Vintage Moog synthesizer").
2. **1 · Show auction status** — the on-chain view: item, phase OPEN, no bids.
3. **2 · Switch identity** → `alice`, then **3 · Place sealed bid** → `1250000`.
4. **1 · Status again** — alice's bid is a 32-byte commitment. The amount appears *nowhere*.
5. Switch to `bob`, bid `2000000`. Two opaque commitments on-chain.
6. Switch to `seller`, **4 · Close bidding**.
7. As `alice` then `bob`, **5 · Reveal my bid** — each reveal is a ZK proof; bob takes the lead, alice's amount is never disclosed.
8. As `seller`, **6 · Finalize** — winner: bob at 2,000,000. Alice's 1,250,000 remains sealed *forever*.
9. **7 · Show my private state** — the contrast shot: amounts and nonces live only in the local file.

## Verify the privacy claim

Don't take our word for it:

```bash
npm run test:e2e
```

Deploys a fresh auction and runs the full lifecycle with three bidders (reveals in worst-case order — winner first), then asserts:

- the highest revealed bid wins and phase guards reject every out-of-phase action (late bids, double bids, non-seller close, reveal-after-finalize);
- the losing bid amounts (chosen as distinctive 8-byte values that can't appear by coincidence) occur **nowhere** in indexer-visible contract state — searched as big-endian hex, little-endian hex, and decimal — at commit time, after all reveals, and in the final state.

## Architecture

| Piece | File | Role |
| --- | --- | --- |
| Contract | `midnight-app/contracts/sealed-auction.compact` | phases, commitments, ZK reveal logic |
| Auction house | `midnight-app/contracts/auction-house.compact` | five mechanisms, 11 circuits, one commitment scheme |
| Number game | `midnight-app/contracts/number-game.compact` | sealed beauty contest, verified-quotient target |
| Auction API | `midnight-app/src/auction-api.ts` | witness binding, providers, deploy/connect, typed ledger reader |
| House API | `midnight-app/src/house-api.ts` | same, for the multi-format contract |
| Intelligence | `midnight-app/src/intel.ts` | shill detection + reserve advice, metadata only |
| Identities | `midnight-app/src/identities.ts` | local secrets: per-identity keys, sealed bids, schedule secrets |
| Web UI | `midnight-app/src/web-server.ts`, `web/` | split-screen privacy view, five formats, intel sheet |
| CLI | `midnight-app/src/cli.ts` | multi-role interactive demo |
| E2E | `midnight-app/scripts/` | `e2e-check` · `house-e2e` · `intel-check` |
| Devnet | `midnight-app/docker-compose.yml` | Midnight node + indexer + proof server, pinned versions |

Stack: Compact 0.31, Midnight.js 4.1, local proof server 8.1. Public testnet deploy: `npm run setup -- --network preview`.

Full protocol writeup, verification method, and an explicit limits section:
**http://localhost:4600/security.html**.

## Limits — what this does *not* claim

Stated up front, because a demo that oversells its threat model is worse than one
that admits its edges:

- **The time-lock is not cryptographic timelock encryption.** No VDF, no threshold
  committee — it's commit-reveal gated on a committed tick, so a seller who never
  opens the schedule stalls the auction.
- **The tick counter is not a clock.** It advances when someone calls `tick()`;
  it is not block height or wall time.
- **Combinatorial is fixed at three lots**, and **batch supply at three units** —
  exhaustive winner determination and the clearing ladder are tractable in-circuit
  precisely at that size. General combinatorial winner determination is NP-hard.
- **Bid metadata is public by design** (who bid, in what order, when). That's what
  makes shill detection possible without deanonymisation — and it's also a real
  fingerprinting surface.
- **No settlement layer.** This proves who won at what price; it doesn't move funds.
- **The intelligence scores are heuristics tuned on synthetic fixtures** — prompts
  for a human, never verdicts.

## Future work

Escrowed settlement (lock funds with the bid, atomic winner payment), real timelock
encryption to remove the seller-liveness dependency, Vickrey second-price variant
(needs all reveals before price disclosure), reveal deadlines with slashing, larger
combinatorial lots via a proof-of-optimality challenge game rather than exhaustive
in-circuit search, and a browser UI on Lace.

---

*Team setup details and troubleshooting: [SETUP.md](SETUP.md) · developer docs: [midnight-app/README.md](midnight-app/README.md)*
