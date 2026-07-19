# Sealed — private auctions on Midnight

**Auctions where nobody sees your bid. Not the seller, not rival bidders, not even the blockchain.**

Midnight Hackathon, July 2026 · **DeFi track**

---

## For judges — start here

**Run it (3 commands, ~5 min including Docker pulls):**

```bash
./setup.sh                              # Compact compiler + deps + contract compile
cd midnight-app && npm run setup        # boots local devnet (Docker), deploys an auction
npm run web                             # → http://localhost:4600
```

No wallet extension, no faucet, no testnet tokens — the local devnet self-funds.
Windows: run inside WSL ([SETUP.md](SETUP.md)).

**Then look at these four things, in this order:**

| # | Where | What you're looking at | Time |
| --- | --- | --- | --- |
| 1 | **http://localhost:4600** | **Deploy an agent into a prediction market.** Pick an event, deploy a named agent with a strategy prompt, and watch it run a research pipeline and seal a forecast. No live odds exist, so nobody can herd or copy-trade. | 4 min |
| 2 | **/index.html** | The core claim, made visual. Split screen: your desk (dark, local) vs. the public record (paper, on-chain). Seal a bid — watch the amount appear on the left and *never* on the right. | 2 min |
| 3 | **/house.html** | Five auction mechanisms in one contract. Run the **Dutch** one — the winner proves `reservation ≥ price` without ever revealing how much more they'd have paid. | 3 min |
| 4 | **/desk.html** | A market with no human traders at all: a broker agent and three buyer desks research, value, and settle against each other. | 3 min |
| 5 | `npm run test:e2e` | The privacy claim, machine-checked: losing bid amounts are asserted absent from indexer-visible state in three encodings. | 1 min |

**The one thing to judge us on:** `claimAtCurrentPrice` in
[`auction-house.compact`](midnight-app/contracts/auction-house.compact) contains no
`disclose()` on the bid amount anywhere. The chain learns the single bit it needed —
"someone will pay at least this" — and nothing more. Our e2e suite asserts the
reservation price is absent from chain-visible state both before the claim *and after
winning*.

---

## What it does

Sealed runs sealed-bid auctions as a confidential smart contract on
[Midnight](https://midnight.network). Bids exist on-chain only as cryptographic
commitments — hiding the amount, binding the bidder to it. After bidding closes, each
bidder reveals *in zero knowledge*: the contract verifies their bid opens their
commitment and tracks the highest, but **losing bid amounts never touch the public
ledger, ever**. Only the winner's pseudonymous id and the winning price become public,
because settlement needs them.

### Why privacy is the product, not a feature

On a transparent chain every auction leaks everything: bots front-run your bid the
moment it hits the mempool, competitors read your exact valuation off the ledger, and
your bidding history is public forever. That kills the use cases that matter —
procurement tenders, OTC block trades, NFT drops, ad slots — where the bid *is* the
strategy. Sealed gives you the outcome transparency an auction needs (verifiable
winner, provable rules) with the input privacy it deserves, enforced by zero-knowledge
proofs rather than by trusting an auctioneer.

---

## Five mechanisms, one privacy guarantee

First-price is the baseline. [`auction-house.compact`](midnight-app/contracts/auction-house.compact)
adds four more in a single contract — because what separates auction formats is not the
codebase, it's **what each circuit proves about a commitment without opening it**.

| Format | The mechanism | What stays private that a transparent chain would leak |
| --- | --- | --- |
| **Dutch** | Price descends publicly; bidders seal a reservation and claim when the clock reaches it | Winner proves `reservation ≥ currentPrice` in ZK. **Even on winning**, how much more they'd have paid never reaches the chain — so the seller can't price-discriminate next time |
| **Uniform-price batch** | Up to 3 units clear at a single price: the lowest winning bid | Only bids landing in a winning slot are opened; the rest fall off the ladder unrevealed. Uniform pricing also kills the gas war — sniping buys you nothing |
| **Candle** | Seller commits a secret end-index *before* bidding opens; later bids never counted | The end-index is binding from block one, so the seller physically cannot move the close to exclude a bid they dislike |
| **Combinatorial** | Bids on bundles of 3 lots (bitmask 1–7) | `lockAllocation` enumerates all five partitions of {A,B,C} **in-circuit** and takes the max — the allocation is *proven* revenue-optimal, not asserted by the seller |
| **Time-locked** | Commit now, reveal later; reveals shut until a committed unlock tick passes | Nobody, including the seller, can open the field early |

```bash
npm run test:house              # all five; or: npm run test:house -- dutch
```

---

## How the core contract works

```
 COMMIT (phase: OPEN)              REVEAL (phase: REVEAL)          CLOSED
 ┌─────────────────────┐           ┌──────────────────────┐        ┌──────────────┐
 │ bidder: amount+nonce│──commit──▶│ prove commitment opens│──────▶│ winner id    │
 │  (stays on machine) │  C(a,n)   │ to (amount, nonce)    │       │ winning price│
 └─────────────────────┘           │ amount disclosed ONLY │       │ (public)     │
   on-chain: opaque                │ if it takes the lead  │       └──────────────┘
   32-byte commitment              └──────────────────────┘   losing amounts: sealed forever
```

Four circuits in [`sealed-auction.compact`](midnight-app/contracts/sealed-auction.compact):

| Circuit | Who | What it proves in zero knowledge |
| --- | --- | --- |
| `placeBid()` | anyone, once | phase is OPEN, bid > 0; writes `persistentCommit(amount, nonce)` under `hash(secretKey)` |
| `closeBidding()` | seller only | caller's secret hashes to the owner id; advances to REVEAL |
| `revealBid()` | each bidder | witness `(amount, nonce)` opens the stored commitment; discloses the amount **only if** it beats the current highest |
| `finalize()` | seller only | closes the auction; highest revealed bid wins |

The bid amount, nonce, and identity secret are Compact *witnesses* — private inputs that
live in `.sealed-identities.json` on the bidder's machine and feed proofs generated by a
local proof server. The chain sees proofs, never inputs.

---

## Verify the privacy claim yourself

Don't take our word for it:

```bash
npm run test:e2e
```

Deploys a fresh auction, runs the full lifecycle with three bidders (reveals in
worst-case order — winner first), then asserts:

- the highest revealed bid wins, and phase guards reject every out-of-phase action
  (late bids, double bids, non-seller close, reveal-after-finalize);
- losing bid amounts — chosen as distinctive 8-byte values that can't appear by
  coincidence — occur **nowhere** in indexer-visible contract state, searched as
  big-endian hex, little-endian hex, and decimal, at commit time, after all reveals,
  and in the final state.

---

## Auction intelligence — fraud detection that can't become a back door

Two engines run over the house under a hard constraint: **bid values are private, so
the usual inputs don't exist for anyone, including us.**

- **Shill radar** scores arrival timing, reveal behaviour and cross-auction overlap —
  never amounts. The strongest available signal survives privacy intact: an account
  that repeatedly seals bids and *never opens them* is driving activity without
  intending to buy. Signals are named and evidenced; weights are set so no single
  signal can reach the `suspect` band alone.
- **Dynamic reserve** recommends hold / lower / raise from demand *velocity* plus
  comparable settlements. Arrival rate is a better demand proxy than bid size anyway —
  one bidder typing a large number can't move it.

A fraud system that needs plaintext bids becomes a surveillance tool the moment it's
compromised. This one has nothing extra to leak: its input is public by construction,
and the `BidEvent` type carries no amount field at all. These are explainable
statistical detectors, **not** learned models — every score decomposes into named
signals you can argue with. `npm run test:intel` covers the false-positive cases as
heavily as the true ones.

---

## Prediction markets you deploy agents into

At **http://localhost:4600** — the front door — you don't take a position yourself.
You **deploy an agent**: give it a name and a strategy prompt, and it runs a research
pipeline (price feeds, headlines, social momentum, on-chain commitment counts), forms a
posterior, and seals an independent forecast from 1 (certain no) to 100 (certain yes).
An oracle agent resolves the event from public data and the closest forecast wins.

The privacy property is what makes this a different market structure, not a reskin:

- **There are no live odds.** On a transparent prediction market the running price *is*
  the aggregate — so late traders copy it instead of forecasting, and the market
  measures herding as much as belief. Sealed commitments mean every forecast is formed
  from evidence alone. The aggregate only exists after everyone has committed.
- **Nobody can copy-trade your agent.** Your agent's number, and the reasoning that
  produced it, never leave your machine. Rival agents can see *that* you committed,
  never *what*.
- **Losing forecasts stay sealed forever.** Only the resolved outcome and the winning
  agent become public.

The reasoning feed shows every step each agent took, with private numbers marked
**LOCAL ONLY** — beside a public tape showing nothing but locked envelopes.

## Sealed Desk — the market run entirely by AI

> Every trader is an AI. None of them can spy on each other.

At **/desk.html**, nobody clicks "bid." A broker agent (**maren**) researches the live
market, prices a block sale, and opens a Dutch exit; three buyer desks — **castor**
(value), **wren** (momentum), **ibis** (index) — research, form private valuations,
seal them as zero-knowledge reservations, and decide when to claim as the clock walks
down. You put one block on the tape and watch the market trade itself.

What makes it more than theatre:

- **Local brains, provably private.** Agent reasoning runs on a local LLM via ollama
  when installed (heuristic personas otherwise) — prompts go to `localhost`, never the
  internet. The agent's budget, valuation, keys, and the ZK prover share one machine
  boundary.
- **Guardrailed autonomy.** The model adjusts valuations within ±8% and can never
  exceed a hard budget cap or break auction rules — the circuits wouldn't prove it
  anyway.
- **Web research, honestly labelled.** Agents pull a live public benchmark to anchor
  prices and *say in their reasoning* whether they used live or cached data.
- **Memory.** Desks carry lessons across auctions ("rode the clock too long — claim
  earlier when contested") and settlement history doubles as the broker's comparables.
- **The floor-chatter feed** shows every thought — private numbers marked **LOCAL
  ONLY** — beside a public tape showing only a descending clock and locked envelopes.

Why it matters: AI agents that trade on your behalf are only safe if the market
structurally cannot extract what they know. Visible-order markets leak an agent's
strategy to every rival bot. This is the missing settlement layer for agentic trading:
give your agent your true number, because nothing and nobody can pry it loose.

---

## Architecture

| Piece | File | Role |
| --- | --- | --- |
| Contract | `midnight-app/contracts/sealed-auction.compact` | phases, commitments, ZK reveal logic |
| Auction house | `midnight-app/contracts/auction-house.compact` | five mechanisms, 11 circuits, one commitment scheme |
| Markets | `midnight-app/contracts/number-game.compact` | sealed forecasts, oracle resolution from public data |
| Auction API | `midnight-app/src/auction-api.ts` | witness binding, providers, deploy/connect, typed ledger reader |
| House API | `midnight-app/src/house-api.ts` | same, for the multi-format contract |
| Intelligence | `midnight-app/src/intel.ts` | shill detection + reserve advice, metadata only |
| Identities | `midnight-app/src/identities.ts` | local secrets: per-identity keys, sealed bids, schedule secrets |
| Web UI | `midnight-app/src/web-server.ts`, `web/` | split-screen privacy view, five formats, intel sheet |
| CLI | `midnight-app/src/cli.ts` | multi-role interactive demo |
| E2E | `midnight-app/scripts/` | `e2e-check` · `house-e2e` · `intel-check` |
| Devnet | `midnight-app/docker-compose.yml` | Midnight node + indexer + proof server, pinned versions |

Stack: Compact 0.31, Midnight.js 4.1, local proof server 8.1.
Public testnet deploy: `npm run setup -- --network preview`.

Full protocol writeup, verification method, and an explicit limits section:
**http://localhost:4600/security.html**.

---

## Limits — what this does *not* claim

Stated up front, because a demo that oversells its threat model is worse than one that
admits its edges.

- **A losing reveal leaks one bit** ("≤ current highest at reveal time") — inherent to
  on-chain max-tracking. The winning price is public by design.
- **Bidders who never reveal forfeit** (standard commit-reveal rule).
- **Bidder ids are pseudonymous hashes**, so cross-auction correlation is possible if
  you reuse an identity.
- **The time-lock is not cryptographic timelock encryption.** No VDF, no threshold
  committee — it's commit-reveal gated on a committed tick, so a seller who never opens
  the schedule stalls the auction.
- **The tick counter is not a clock.** It advances when someone calls `tick()`; it is
  not block height or wall time.
- **Combinatorial is fixed at three lots**, and **batch supply at three units** —
  exhaustive winner determination and the clearing ladder are tractable in-circuit
  precisely at that size. General combinatorial winner determination is NP-hard.
- **Bid metadata is public by design** (who bid, in what order, when). That's what
  makes shill detection possible without deanonymisation — and it's also a real
  fingerprinting surface.
- **No settlement layer.** This proves who won at what price; it doesn't move funds.
- **The intelligence scores are heuristics** tuned on synthetic fixtures — prompts for
  a human, never verdicts.

## Future work

Escrowed settlement (lock funds with the bid, atomic winner payment), real timelock
encryption to remove the seller-liveness dependency, a Vickrey second-price variant
(needs all reveals before price disclosure), reveal deadlines with slashing, larger
combinatorial lots via a proof-of-optimality challenge game rather than exhaustive
in-circuit search, and a browser UI on Lace.

---

*Setup details and troubleshooting: [SETUP.md](SETUP.md) · demo script: [DEMO.md](DEMO.md) · developer docs: [midnight-app/README.md](midnight-app/README.md)*
