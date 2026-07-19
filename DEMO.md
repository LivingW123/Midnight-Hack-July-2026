# Demo Video Script (≤ 2 minutes)

Submission rules checklist: state the hackathon name **at the start**, record it
**during the event weekend**, keep repo + video public, ≤ 2 min.

## Prep (before recording)

```bash
cd midnight-app
npm run setup      # fresh auction, phase OPEN (clean slate)
npm run web        # open http://localhost:4600, wait for "ready"
```

Use the web app for the video — the split screen tells the story visually.
Browser at a comfortable zoom, dock hidden. (Terminal-only fallback: `npm run cli`.)

## Script

**0:00 — Intro (required opening line)**
> "Hey, I'm ___ and this is my demo for the **Midnight Hackathon**. This is
> *Sealed* — auctions where nobody sees your bid. Not the seller, not rival
> bidders, not even the blockchain."

**0:10 — The split screen (over the fresh auction page)**
> "The page is split down the privacy line. Left: your desk — stays on your
> machine. Right: the public record — *everything* the chain knows. On a normal
> chain, your bid would be on the right, public, front-runnable. Watch where it
> actually goes."

**0:25 — Bid as alice** — click paddle `alice` (add it), type `1250000`, *Place sealed bid*
> "Alice bids 1.25 million. Her machine is generating a zero-knowledge proof —
> that's real, about 40 seconds." (time-lapse the progress strip)
> "Done: the envelope seals on her desk… and on the public record, one new line —
> an opaque commitment. The amount appears **nowhere** on the right side."

**0:50 — Bob outbids** — paddle `bob`, `2000000`, *Place sealed bid* (time-lapse)
> "Bob bids two million. Same story: two sealed envelopes, two meaningless
> hashes on-chain."

**1:05 — Close & reveal** — paddle `seller` → *Close bidding*; then `alice` → *Reveal my
bid*; then `bob` → *Reveal my bid* (time-lapse each)
> "The seller closes bidding. Now reveals — each one a ZK proof that the bid
> matches the sealed commitment. Bob takes the lead. Alice didn't — and notice:
> her amount *still* isn't on the public record."

**1:30 — The gavel** — paddle `seller` → *Finalize — bring down the gavel*
> "Sold — to Bob, at two million. The winning price is public because settlement
> needs it. But look at Alice's side: 'your amount stays sealed forever.' Losing
> bids never touch the chain — our 21-check e2e test proves it by searching the
> ledger for them."

**1:50 — Close**
> "Sealed: MEV-proof auctions for procurement, OTC trades, and NFT drops —
> private inputs, verifiable outcomes, only possible on Midnight. Thanks!"

## Rivals

Two house bidders, **vesper** and **orpheus**, join every auction on their own a
few seconds after it opens and reveal during the reveal phase — so even a solo
recording has real competition. Wait for their toasts ("Rival paddle vesper
sealed a bid…") and point at the registry filling up. You may win or lose the
lot depending on their random amounts — either ending demos the privacy story.

## Alternate 2-minute cut: the Dutch auction

If you'd rather lead with the strongest cryptographic claim than with the split
screen, record this instead. It needs one deploy and two proofs, so it cuts
tighter.

```bash
npm run web    # → http://localhost:4600/house.html
```

**0:10 — The format rack**
> "Five auction mechanisms, one contract. What separates them isn't the code —
> it's what each circuit can prove about a sealed bid *without opening it*."

**0:25 — Open a Dutch auction** (opening 1000, floor 200, step 100)
> "A Dutch auction descends in public. I seal the highest price I'd pay —
> seven thousand — and that number never leaves this machine."

**0:45 — Step the clock down twice**, pointing at the price tick
> "The clock is public. My demand is not. Nobody can see there's a bidder here
> willing to pay seven thousand."

**1:05 — Claim at 800**
> "Now I claim. The circuit proves my sealed reservation is *at least* eight
> hundred — and that's all it proves. There is no `disclose` on my bid amount
> anywhere in this circuit."

**1:25 — The public record**
> "I won at eight hundred, the public clock price. The chain learned exactly one
> bit: someone would pay this much. It never learned I'd have paid seven
> thousand — so the seller can't price-discriminate against me next time. On a
> transparent chain that number is public forever."

**1:45 — Close on /security.html**
> "Every claim here points at the line of code enforcing it — including the
> limits. `npm run test:house` proves the reservation price is absent from chain
> state, even after winning."

## Timing tips

- Proof generation is 30–60s per action: record everything, then cut the waits.
  The amber progress strip makes clean jump-cut points.
- If short on time, drop bob — alice solo still hits both beats that matter:
  the commitment landing on the public record at 0:25, and "sealed forever."
- Keep the browser window steady; the two-sides framing does the explaining.
