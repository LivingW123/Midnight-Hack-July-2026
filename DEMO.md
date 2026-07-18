# Demo Video Script (≤ 2 minutes)

Submission rules checklist: state the hackathon name **at the start**, record it
**during the event weekend**, keep repo + video public, ≤ 2 min.

## Prep (before recording)

```bash
cd midnight-app
npm run setup      # fresh auction, phase OPEN (only if you want a clean slate)
npm run cli        # leave it connected, terminal font large
```

Have a second terminal ready with this file open, or the README's demo section.

## Script

**0:00 — Intro (required opening line)**
> "Hey, I'm ___ and this is my demo for the **Midnight Hackathon**. This is
> *Sealed* — auctions where nobody sees your bid. Not the seller, not rival
> bidders, not even the blockchain."

**0:10 — The problem (over the CLI title screen)**
> "On a transparent chain, every bid is public: bots front-run you, competitors
> read your exact valuation. Sealed fixes that with zero-knowledge proofs on
> Midnight."

**0:20 — Show the empty auction** — press `1`
> "Here's a live auction on a local Midnight devnet. Phase: OPEN. The item is
> public — nothing else is."

**0:30 — Bid as alice** — `2` → `alice`, then `3` → `1250000`
> "Alice bids 1.25 million. Her machine generates a ZK proof; only a
> *commitment* goes on-chain." (While the proof generates ~30s, cut or
> time-lapse.)

**0:50 — The money shot** — press `1`
> "Look at the chain: one sealed bid — an opaque 32-byte commitment. The amount
> appears **nowhere**. Press `7`: the amount and nonce live only in a local
> file." (press `7`)

**1:05 — Bob outbids** — `2` → `bob`, `3` → `2000000` (time-lapse the proof)

**1:15 — Close and reveal** — `2` → `seller`, `4`; then `2` → `alice`, `5`; `2` → `bob`, `5`
> "The seller closes bidding. Now each bidder reveals *in zero knowledge* — the
> contract verifies the reveal matches the commitment. Bob takes the lead;
> Alice's amount is never disclosed."

**1:35 — Finalize** — `2` → `seller`, `6`
> "Finalized: Bob wins at 2 million — that's public, settlement needs it. But
> Alice lost, and her 1.25 million stays sealed **forever**. Losing bids never
> touch the chain — our e2e test proves it by searching the ledger for them."

**1:50 — Close**
> "Sealed: MEV-proof auctions for procurement, OTC trades, and NFT drops —
> private inputs, verifiable outcomes, only possible on Midnight. Thanks!"

## Timing tips

- Proof generation is 30–60s per action: record everything, then cut the waits
  (or pre-record bids and demo from phase REVEAL onward).
- If short on time, drop bob's bid and run alice solo — the commitment shot at
  0:50 and the "sealed forever" line are the two beats that must survive.
