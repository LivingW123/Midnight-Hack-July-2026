# sealed-auction (developer docs)

The Sealed DApp: a first-price sealed-bid auction as a Compact contract plus a TypeScript CLI. Project pitch, privacy model, and demo script live in the [root README](../README.md); this file is the developer surface.

## Commands

| Command | What it does |
| --- | --- |
| `npm install` | install deps (lockfile pinned) |
| `npm run setup` | `docker compose up -d --wait` (node, indexer, proof-server) → `npm run compile` → deploy an auction as identity `seller` |
| `npm run compile` | `compact compile contracts/sealed-auction.compact contracts/managed/sealed-auction` |
| `npm run web` | auction web app at http://localhost:4600 (same local wallet + prover) |
| `npm run cli` | interactive multi-role auction CLI |
| `npm run test:e2e` | full lifecycle test: 3 bidders, worst-case reveal order, privacy assertions |
| `npm run proof-server:start` / `:stop` | proof server alone (public-network use) |
| `npm run network <name>` | switch active network (`undeployed` · `preview` · `preprod`) |
| `npm run clean` | remove compiled artifacts + local chain/private state |

`AUCTION_ITEM="Rare vinyl pressing" npm run setup` customizes the deployed auction's item.

## Contract interface

`contracts/sealed-auction.compact` — public ledger:

| Field | Type | Meaning |
| --- | --- | --- |
| `phase` | `Phase` enum | `open` → `reveal` → `closed` |
| `item` | `Opaque<"string">` | what's being auctioned |
| `owner` | `Bytes<32>` | seller id = `publicKey(secretKey)` |
| `bids` | `Map<Bytes<32>, Bytes<32>>` | bidder id → `persistentCommit(amount, nonce)` |
| `bidderCount` | `Counter` | number of sealed bids |
| `highestBid` | `Uint<64>` | highest *revealed* amount (0 until first reveal) |
| `winner` | `Bytes<32>` | current leading bidder id (zero = none) |

Circuits: `placeBid()`, `closeBidding()` (seller), `revealBid()`, `finalize()` (seller), plus pure `publicKey(sk)`.

Witnesses (private inputs, supplied locally at proof time): `localSecretKey(): Bytes<32>`, `bidAmount(): Uint<64>`, `bidNonce(): Bytes<32>`.

## Source layout

| File | Responsibility |
| --- | --- |
| `src/auction-api.ts` | compiled-contract loading + witness binding, providers, `deployAuction`/`connectAuction` (DUST retries), `readAuctionLedger` typed view |
| `src/identities.ts` | named local identities: secret keys + sealed bids, persisted to `.sealed-identities.json` |
| `src/cli.ts` | interactive menu (status / switch identity / bid / close / reveal / finalize / private view / new auction) |
| `src/web-server.ts` + `web/` | local web app: JSON API + static frontend, one-slot job queue serializing proofs |
| `src/deploy.ts` | non-interactive deploy used by `npm run setup` |
| `src/wallet.ts`, `src/network.ts` | scaffold plumbing: wallet-sdk wiring, network configs, state file |
| `scripts/e2e-check.ts` | lifecycle + privacy e2e (see root README) |

## Local state files (all gitignored)

| File | Contents | Sensitivity |
| --- | --- | --- |
| `.sealed-identities.json` | identity secret keys, bid amounts, nonces | **private** — leaking it reveals your bids |
| `.midnight-state.json` | active network, wallet seed (devnet), deployed contract address | private (contains seed) |
| `.midnight-wallet-state/` | wallet sync cache | regenerable |

## Local devnet

`docker-compose.yml` pins: `midnight-node:1.0.0`, `indexer-standalone:4.3.3`, `proof-server:8.1.0`. The version pins and healthcheck ordering encode known bugs — read the comments in that file before bumping anything.

## Public testnet

```bash
npm run setup -- --network preview
```

Deploys via a generated wallet; the script prints a faucet URL and waits for funding. The proof server always runs locally (your witnesses must never leave your machine).
