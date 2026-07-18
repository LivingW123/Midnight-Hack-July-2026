# Sealed — Private Sealed-Bid Auction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hello-world scaffold with a first-price sealed-bid auction DApp on Midnight where bid amounts are hidden on-chain (commitments), losing bids are never revealed, and only the winner + winning price go public.

**Architecture:** One Compact contract (`sealed-auction.compact`) with commit→reveal phases; a shared TypeScript module (`src/auction-api.ts`) that binds witnesses to locally-stored identities and centralizes providers/ledger parsing; the existing scaffold's wallet/network/devnet plumbing untouched. CLI and e2e both consume `auction-api`.

**Tech Stack:** Compact 0.31.x, Midnight.js 4.1.1, wallet-sdk 1.2.0, tsx/TypeScript, local devnet via docker-compose (node 1.0.0, indexer 4.3.3, proof-server 8.1.0).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-18-sealed-auction-design.md`.
- Node >= 22 required by package.json engines.
- Docker images/tags in `docker-compose.yml` are pinned for known-bug reasons — do not change them.
- The Compact compiler (0.31.x) is ground truth for language syntax; if a snippet below doesn't compile, adapt syntax but preserve the ledger/witness/circuit semantics from the spec.
- `.sealed-identities.json` holds private data — must be gitignored.
- All commits: end message with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Deadline-driven: Tasks 0–6 are required scope; Task 7 (web UI) only if everything else is green.

---

### Task 0: Toolchain + devnet up

**Files:** none created (environment only).

**Interfaces:**
- Produces: working `compact` CLI on PATH, `midnight-app/node_modules`, running Docker daemon.

- [ ] **Step 1: Install Compact compiler**

```bash
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/midnightntwrk/compact/releases/latest/download/compact-installer.sh | sh
export PATH="$HOME/.local/bin:$PATH"
compact update
compact compile --version
```
Expected: prints compiler version 0.31.x.

- [ ] **Step 2: Install npm deps**

```bash
cd midnight-app && npm install
```
Expected: exits 0 (lockfile committed, so versions are pinned).

- [ ] **Step 3: Start Docker daemon (macOS)**

```bash
open -a Docker
until docker ps >/dev/null 2>&1; do sleep 2; done; echo "docker up"
```
Expected: "docker up" within ~60s.

- [ ] **Step 4: Sanity-compile the existing hello-world contract**

```bash
cd midnight-app && npm run compile
```
Expected: creates `contracts/managed/hello-world/` with `contract/index.js` and keys. Confirms toolchain works before we touch anything.

---

### Task 1: The sealed-auction contract

**Files:**
- Create: `midnight-app/contracts/sealed-auction.compact`
- Delete: `midnight-app/contracts/hello-world.compact`
- Modify: `midnight-app/package.json` (compile script, name, description)

**Interfaces:**
- Produces (consumed by Tasks 2–5): compiled module at `contracts/managed/sealed-auction/contract/index.js` exporting `Contract`, `ledger(data)`, `Phase`; circuits `placeBid()`, `closeBidding()`, `revealBid()`, `finalize()`; constructor arg `itemDesc: string`; witnesses `localSecretKey(): Bytes<32>`, `bidAmount(): Uint<64>`, `bidNonce(): Bytes<32>`. Ledger fields: `phase, item, owner, bids (Map<Bytes<32>,Bytes<32>>), bidderCount (Counter), highestBid (Uint<64>), winner (Bytes<32>)`.

- [ ] **Step 1: Write the contract**

```compact
pragma language_version >= 0.23;

import CompactStandardLibrary;

// ── Sealed-bid first-price auction ─────────────────────────────────────────
// Bids go on-chain only as hiding+binding commitments. At reveal, each bidder
// proves in zero knowledge that their witness (amount, nonce) opens their
// commitment; the amount is disclosed to the ledger ONLY if it takes the lead.
// Losing bid values never appear on-chain.

export enum Phase { open, reveal, closed }

export ledger phase: Phase;
export ledger item: Opaque<"string">;
export ledger owner: Bytes<32>;
export ledger bids: Map<Bytes<32>, Bytes<32>>;
export ledger bidderCount: Counter;
export ledger highestBid: Uint<64>;
export ledger winner: Bytes<32>;

// Private data — lives only in the caller's local state, never on-chain.
witness localSecretKey(): Bytes<32>;
witness bidAmount(): Uint<64>;
witness bidNonce(): Bytes<32>;

constructor(itemDesc: Opaque<"string">) {
  item = itemDesc;
  phase = Phase.open;
  owner = disclose(publicKey(localSecretKey()));
}

// Pseudonymous on-chain identity: hash of a local secret, domain-separated.
export circuit publicKey(sk: Bytes<32>): Bytes<32> {
  return persistentHash<Vector<2, Bytes<32>>>([pad(32, "sealed:pk:"), sk]);
}

export circuit placeBid(): [] {
  assert(phase == Phase.open, "bidding is closed");
  const amount = bidAmount();
  assert(amount > 0, "bid must be positive");
  const id = disclose(publicKey(localSecretKey()));
  assert(!bids.member(id), "this identity already placed a bid");
  const commitment = persistentCommit<Uint<64>>(amount, bidNonce());
  bids.insert(id, disclose(commitment));
  bidderCount.increment(1);
}

export circuit closeBidding(): [] {
  assert(phase == Phase.open, "bidding is not open");
  assert(publicKey(localSecretKey()) == owner, "only the seller can close bidding");
  phase = Phase.reveal;
}

export circuit revealBid(): [] {
  assert(phase == Phase.reveal, "not in reveal phase");
  const id = disclose(publicKey(localSecretKey()));
  assert(bids.member(id), "no sealed bid found for this identity");
  const amount = bidAmount();
  const commitment = persistentCommit<Uint<64>>(amount, bidNonce());
  assert(bids.lookup(id) == commitment, "reveal does not match sealed bid");
  if (disclose(amount > highestBid)) {
    highestBid = disclose(amount);
    winner = id;
  }
}

export circuit finalize(): [] {
  assert(phase == Phase.reveal, "auction is not in reveal phase");
  assert(publicKey(localSecretKey()) == owner, "only the seller can finalize");
  phase = Phase.closed;
}
```

Known syntax risks (fix per compiler errors, keep semantics): `disclose()` placement (compiler tells you exactly where it's required), conditional ledger writes inside `if` (fallback: compute `const lead = disclose(amount > highestBid);` then use ternary-style unconditional writes `highestBid = lead ? disclose(amount) : highestBid; winner = lead ? id : winner;` — leaks nothing extra since `lead` is already disclosed), `Map.lookup` equality on `Bytes<32>`.

- [ ] **Step 2: Update package.json**

Change: `"compile": "compact compile contracts/sealed-auction.compact contracts/managed/sealed-auction"`, `"name": "sealed-auction"`, `"description": "Sealed — private sealed-bid auctions on Midnight"`. Delete `contracts/hello-world.compact`.

- [ ] **Step 3: Compile until green**

```bash
cd midnight-app && npm run compile
```
Expected: `contracts/managed/sealed-auction/` with `contract/index.js`, `keys/`, `zkir/`. Circuits listed: placeBid, closeBidding, revealBid, finalize, publicKey.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: sealed-bid auction contract (commit-reveal, private losing bids)"
```

---

### Task 2: Identity store + auction API module

**Files:**
- Create: `midnight-app/src/identities.ts`
- Create: `midnight-app/src/auction-api.ts`
- Modify: `midnight-app/.gitignore` (add `.sealed-identities.json`)

**Interfaces:**
- Consumes: compiled contract from Task 1; `createWallet`/`WalletContext` from `src/wallet.ts`; `networkConfig` shape from `src/network.ts`.
- Produces (consumed by Tasks 3–5):
  - `identities.ts`: `getOrCreateIdentity(name): Identity`, `setCurrentIdentity(name): Identity`, `currentIdentity(): Identity`, `listIdentities(): string[]`, `recordBid(name, contractAddress, amount: bigint): SealedBid`, `getBid(name, contractAddress): SealedBid | undefined`, `hexToBytes(hex): Uint8Array` where `Identity = { name, secretKey: hex, bids: Record<addr, {amount: string, nonce: hex}> }`.
  - `auction-api.ts`: `PRIVATE_STATE_ID`, `setActiveContract(addr: string)`, `loadAuctionModule()`, `makeCompiledAuction()`, `createProviders(walletCtx, networkConfig)`, `deployAuction(providers, itemDesc: string): Promise<string /*address*/>` (with DUST retry loop), `connectAuction(providers, contractAddress)`, `readAuctionLedger(providers, contractAddress): Promise<AuctionView>` where `AuctionView = { phase: 'open'|'reveal'|'closed', item: string, owner: hex, bids: Array<{bidderId: hex, commitment: hex}>, bidderCount: number, highestBid: bigint, winner: hex|null }`.

- [ ] **Step 1: Write `src/identities.ts`**

```typescript
/**
 * Local identity store for the sealed-bid auction demo.
 *
 * Each named identity (seller, alice, bob, ...) owns a random 32-byte secret
 * key; its on-chain id is hash(secretKey). Per contract address we also store
 * the sealed bid (amount + nonce). Everything here is PRIVATE and stays on
 * this machine — only commitments derived from it ever go on-chain.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Buffer } from 'node:buffer';

export interface SealedBid {
  amount: string; // decimal string (bigint-safe)
  nonce: string;  // 32-byte hex
}

export interface Identity {
  name: string;
  secretKey: string; // 32-byte hex
  bids: Record<string, SealedBid>; // contractAddress -> sealed bid
}

interface Store {
  identities: Record<string, Identity>;
  current: string;
}

const FILE = path.resolve(process.cwd(), '.sealed-identities.json');

function load(): Store {
  if (!fs.existsSync(FILE)) return { identities: {}, current: 'seller' };
  return JSON.parse(fs.readFileSync(FILE, 'utf8')) as Store;
}

function save(store: Store): void {
  fs.writeFileSync(FILE, JSON.stringify(store, null, 2));
}

export function getOrCreateIdentity(name: string): Identity {
  const store = load();
  if (!store.identities[name]) {
    store.identities[name] = { name, secretKey: randomBytes(32).toString('hex'), bids: {} };
    save(store);
  }
  return store.identities[name];
}

export function setCurrentIdentity(name: string): Identity {
  const identity = getOrCreateIdentity(name);
  const store = load();
  store.current = name;
  save(store);
  return identity;
}

export function currentIdentity(): Identity {
  const store = load();
  return getOrCreateIdentity(store.current || 'seller');
}

export function listIdentities(): string[] {
  return Object.keys(load().identities);
}

/** Choose a fresh nonce and persist the sealed bid BEFORE the tx is sent, so
 * a crash between commit and reveal can never lose the opening. */
export function recordBid(name: string, contractAddress: string, amount: bigint): SealedBid {
  const store = load();
  const identity = store.identities[name];
  if (!identity) throw new Error(`unknown identity: ${name}`);
  const bid: SealedBid = { amount: amount.toString(), nonce: randomBytes(32).toString('hex') };
  identity.bids[contractAddress] = bid;
  save(store);
  return bid;
}

export function getBid(name: string, contractAddress: string): SealedBid | undefined {
  return load().identities[name]?.bids[contractAddress];
}

export function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}
```

- [ ] **Step 2: Write `src/auction-api.ts`**

```typescript
/**
 * Shared plumbing for the sealed-auction DApp: compiled-contract loading with
 * witnesses bound to the local identity store, provider construction, deploy
 * with DUST retries, and a typed reader for the public ledger state.
 *
 * Witness model: circuits pull private data via three witnesses. They read
 * from the CURRENT identity (identities.ts) and the ACTIVE contract address
 * (setActiveContract), so the CLI can switch personas without rebuilding
 * providers.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Buffer } from 'node:buffer';

import { deployContract, findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/compact-js';

import { currentIdentity, getBid, hexToBytes } from './identities';
import type { WalletContext } from './wallet';

export const PRIVATE_STATE_ID = 'sealedAuctionPrivateState';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const zkConfigPath = path.resolve(__dirname, '..', 'contracts', 'managed', 'sealed-auction');

let activeContract = '';
export function setActiveContract(addr: string): void {
  activeContract = addr;
}

export async function loadAuctionModule(): Promise<any> {
  const contractPath = path.join(zkConfigPath, 'contract', 'index.js');
  if (!fs.existsSync(contractPath)) {
    console.error('\n❌ Contract not compiled! Run: npm run compile\n');
    process.exit(1);
  }
  return import(pathToFileURL(contractPath).href);
}

/**
 * Witnesses: Midnight.js calls these locally during proof generation; the
 * returned values are private inputs to the circuit and never leave this
 * machine. Signature: (ctx) => [newPrivateState, value].
 */
function witnesses() {
  return {
    localSecretKey: ({ privateState }: any) => [privateState, hexToBytes(currentIdentity().secretKey)],
    bidAmount: ({ privateState }: any) => {
      const bid = getBid(currentIdentity().name, activeContract);
      if (!bid) throw new Error(`no sealed bid recorded for ${currentIdentity().name} on ${activeContract || '(no active contract)'}`);
      return [privateState, BigInt(bid.amount)];
    },
    bidNonce: ({ privateState }: any) => {
      const bid = getBid(currentIdentity().name, activeContract);
      if (!bid) throw new Error(`no sealed bid recorded for ${currentIdentity().name} on ${activeContract || '(no active contract)'}`);
      return [privateState, hexToBytes(bid.nonce)];
    },
  };
}

export async function makeCompiledAuction(): Promise<any> {
  const mod = await loadAuctionModule();
  return CompiledContract.make('sealed-auction', mod.Contract).pipe(
    CompiledContract.withWitnesses(witnesses()),
    CompiledContract.withCompiledFileAssets(zkConfigPath),
  );
}

export async function createProviders(walletCtx: WalletContext, networkConfig: any) {
  const privateStatePassword = process.env.PRIVATE_STATE_PASSWORD?.trim() || 'Local-Devnet-Development-Placeholder-1';

  const walletProvider = {
    getCoinPublicKey: () => walletCtx.shieldedSecretKeys.coinPublicKey,
    getEncryptionPublicKey: () => walletCtx.shieldedSecretKeys.encryptionPublicKey,
    async balanceTx(tx: any, ttl?: Date) {
      const recipe = await walletCtx.wallet.balanceUnboundTransaction(
        tx,
        { shieldedSecretKeys: walletCtx.shieldedSecretKeys, dustSecretKey: walletCtx.dustSecretKey },
        { ttl: ttl ?? new Date(Date.now() + 30 * 60 * 1000) },
      );
      return walletCtx.wallet.finalizeRecipe(recipe);
    },
    submitTx: (tx: any) => walletCtx.wallet.submitTransaction(tx) as any,
  };

  const zkConfigProvider = new NodeZkConfigProvider(zkConfigPath);
  const accountId = walletCtx.unshieldedKeystore.getBech32Address().toString();

  return {
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName: 'sealed-auction-state',
      accountId,
      privateStoragePasswordProvider: () => privateStatePassword,
    }),
    publicDataProvider: indexerPublicDataProvider(networkConfig.indexer, networkConfig.indexerWS),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(networkConfig.proofServer, zkConfigProvider),
    walletProvider,
    midnightProvider: walletProvider,
  };
}

/** Deploy a new auction. DUST-projection retry loop preserved from the
 * scaffold: the wallet's DUST balance is a wall-clock projection that lags
 * block timestamps by ~1 block on a fresh devnet. */
export async function deployAuction(providers: any, itemDesc: string): Promise<string> {
  const compiled = await makeCompiledAuction();
  const MAX_RETRIES = 20;
  const RETRY_DELAY_MS = 5000;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const deployed = await deployContract(providers, {
        compiledContract: compiled as any,
        args: [itemDesc],
        privateStateId: PRIVATE_STATE_ID,
        initialPrivateState: {},
      });
      return deployed.deployTxData.public.contractAddress;
    } catch (err: any) {
      const full = `${err?.message ?? ''} ${err?.cause?.message ?? ''}`;
      const isDustShortage =
        full.includes('Not enough Dust') || full.includes('Insufficient Funds') || full.includes('could not balance dust');
      if (!isDustShortage || attempt === MAX_RETRIES) throw err;
      console.log(`  ⏳ DUST still generating (attempt ${attempt}/${MAX_RETRIES}); retrying in ${RETRY_DELAY_MS / 1000}s...`);
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
  }
  throw new Error('unreachable');
}

export async function connectAuction(providers: any, contractAddress: string): Promise<any> {
  const compiled = await makeCompiledAuction();
  return findDeployedContract(providers, {
    compiledContract: compiled as any,
    contractAddress,
    privateStateId: PRIVATE_STATE_ID,
    initialPrivateState: {},
  });
}

export interface AuctionView {
  phase: 'open' | 'reveal' | 'closed';
  item: string;
  owner: string;
  bids: Array<{ bidderId: string; commitment: string }>;
  bidderCount: number;
  highestBid: bigint;
  winner: string | null;
}

const PHASES = ['open', 'reveal', 'closed'] as const;
const ZERO32 = '0'.repeat(64);

function toHex(v: any): string {
  return Buffer.from(v).toString('hex');
}

export async function readAuctionLedger(providers: any, contractAddress: string): Promise<AuctionView> {
  const mod = await loadAuctionModule();
  const contractState = await providers.publicDataProvider.queryContractState(contractAddress);
  if (!contractState) throw new Error(`no on-chain state for ${contractAddress}`);
  const raw = mod.ledger(contractState.data);
  const bids: AuctionView['bids'] = [];
  for (const [bidderId, commitment] of raw.bids) {
    bids.push({ bidderId: toHex(bidderId), commitment: toHex(commitment) });
  }
  const winnerHex = toHex(raw.winner);
  return {
    phase: PHASES[Number(raw.phase)] ?? 'closed',
    item: Buffer.from(raw.item).toString('utf8'),
    owner: toHex(raw.owner),
    bids,
    bidderCount: Number(raw.bidderCount),
    highestBid: BigInt(raw.highestBid),
    winner: winnerHex === ZERO32 ? null : winnerHex,
  };
}
```

- [ ] **Step 3: Verify the compact-js witness API name**

```bash
grep -o "with[A-Za-z]*" midnight-app/node_modules/@midnight-ntwrk/midnight-js-protocol/dist/compact-js/*.d.ts | sort -u
```
Expected: a `withWitnesses`-like combinator. If it's named differently (e.g. takes witnesses in `make` options), adapt `makeCompiledAuction` accordingly. Also check the witness callback signature in the same .d.ts (context arg + `[state, value]` return).

- [ ] **Step 4: Typecheck**

```bash
cd midnight-app && npx tsc --noEmit
```
Expected: no errors in the new files (pre-existing scaffold files still reference hello-world paths until Task 3 — if tsc fails only there, proceed; Task 3 fixes them).

- [ ] **Step 5: Add `.sealed-identities.json` to `.gitignore`, commit**

```bash
cd midnight-app && echo ".sealed-identities.json" >> .gitignore
git add -A && git commit -m "feat: identity store + shared auction API with witness binding"
```

---

### Task 3: Deploy path (setup deploys an auction)

**Files:**
- Modify: `midnight-app/src/deploy.ts`
- Modify: `midnight-app/scripts/e2e-check.ts` (only enough to keep tsc green; full rewrite is Task 5)

**Interfaces:**
- Consumes: `makeCompiledAuction`, `createProviders`, `deployAuction`, `setActiveContract` from Task 2; `getOrCreateIdentity`, `setCurrentIdentity`.
- Produces: `npm run setup` boots devnet, compiles, deploys an auction as identity `seller` with item from `AUCTION_ITEM` env (default `"Vintage Moog synthesizer — hackathon edition"`), records address via `recordDeployment`.

- [ ] **Step 1: Rewrite deploy.ts contract-specific parts**

Keep wallet creation, sync, faucet, DUST registration, and proof-server wait exactly as-is. Replace: the hello-world constants/loading (lines 26–82), `createProviders` (use auction-api), and the deploy call block (use `deployAuction` which owns the retry loop). Concretely:
- Replace the `PRIVATE_STATE_ID`/zkConfig/contract-loading block with:

```typescript
import {
  createProviders, deployAuction, setActiveContract, zkConfigPath,
} from './auction-api';
import { setCurrentIdentity } from './identities';

const ITEM_DESC = process.env.AUCTION_ITEM || 'Vintage Moog synthesizer — hackathon edition';

// The deployer is the seller: the constructor derives `owner` from
// localSecretKey(), so the seller identity must be current at deploy time.
setCurrentIdentity('seller');
```
- Delete the local `createProviders` function; call `await createProviders(walletCtx, networkConfig)` instead.
- Replace the whole MAX_RETRIES deploy loop with:

```typescript
  console.log('  Deploying sealed-bid auction...');
  console.log(`  Item: ${ITEM_DESC}\n`);
  process.stdout.write('  Generating DUST...');
  await new Promise((r) => setTimeout(r, 6000));
  process.stdout.write(' done.\n');
  const contractAddress = await deployAuction(providers, ITEM_DESC);
  setActiveContract(contractAddress);
```
- Keep `recordDeployment(network, contractAddress, address.toString())` and the wallet persist/stop tail. Update banner text to "Deploy sealed-bid auction".

- [ ] **Step 2: Patch e2e-check.ts minimally for tsc**

Point its zkConfigPath at `sealed-auction`, PRIVATE_STATE_ID at `sealedAuctionPrivateState`, and swap `CompiledContract.withVacantWitnesses` for the Task 2 `makeCompiledAuction()`. (Full flow-test rewrite comes in Task 5.)

- [ ] **Step 3: Typecheck**

```bash
cd midnight-app && npx tsc --noEmit
```
Expected: clean.

- [ ] **Step 4: Full setup run (deploys for real)**

```bash
cd midnight-app && npm run setup
```
Expected: devnet boots (`docker compose up -d --wait`), contract compiles, wallet syncs, auction deploys, address saved to `.midnight-state.json`. This is the first end-to-end proof that constructor witnesses work.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: deploy sealed auction via setup (seller identity, item via AUCTION_ITEM)"
```

---

### Task 4: Interactive CLI

**Files:**
- Rewrite: `midnight-app/src/cli.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–3; `getDeployment`/`recordDeployment` from `src/network.ts`.
- Produces: `npm run cli` menu: status / switch identity / place bid / close / reveal / finalize / my private state / new auction / exit.

- [ ] **Step 1: Rewrite cli.ts**

Keep the wallet-connection preamble (banner, `getDeployment` check, `createWallet`, sync spinner, `persistWalletState`, balance print) from the current file verbatim, then replace contract wiring and the menu loop:

```typescript
import {
  createProviders, connectAuction, deployAuction, readAuctionLedger,
  setActiveContract, type AuctionView,
} from './auction-api';
import {
  currentIdentity, setCurrentIdentity, listIdentities, recordBid, getBid,
} from './identities';
// ... existing scaffold imports for wallet/network/readline stay.

function short(hex: string): string {
  return `${hex.slice(0, 10)}…${hex.slice(-6)}`;
}

function printStatus(view: AuctionView, contractAddress: string): void {
  console.log('\n─── On-chain public state (what everyone sees) ────────────────');
  console.log(`  Contract:  ${short(contractAddress)}`);
  console.log(`  Item:      ${view.item}`);
  console.log(`  Phase:     ${view.phase.toUpperCase()}`);
  console.log(`  Seller id: ${short(view.owner)}`);
  console.log(`  Sealed bids (${view.bidderCount}):`);
  for (const b of view.bids) {
    console.log(`    bidder ${short(b.bidderId)} → commitment ${short(b.commitment)}`);
  }
  if (view.bids.length === 0) console.log('    (none yet)');
  console.log(`  Highest revealed bid: ${view.highestBid > 0n ? view.highestBid : '—'}`);
  console.log(`  Winner: ${view.winner ? short(view.winner) : '—'}`);
  console.log('  ℹ Commitments are hiding+binding: bid amounts are NOT derivable');
  console.log('    from anything above. Losing amounts never touch the chain.\n');
}
```

Menu loop (replacing the switch): current identity shown in the prompt; actions wrapped in try/catch printing `error.message` (circuit asserts surface as failed proof generation with the assert message — print a hint mapping common ones: wrong phase, double bid, non-seller close). Handlers:
- **1 Show auction status** → `printStatus(await readAuctionLedger(providers, addr), addr)`.
- **2 Switch identity** → list `listIdentities()`, prompt for name (new names auto-create), `setCurrentIdentity(name)`.
- **3 Place sealed bid** → prompt amount; validate `/^[0-9]+$/` and `> 0`; `recordBid(currentIdentity().name, addr, BigInt(amount))` BEFORE the call (nonce persisted first); then `await deployed.callTx.placeBid()`; print txId + "your amount and nonce stayed local".
- **4 Close bidding** → `await deployed.callTx.closeBidding()`.
- **5 Reveal my bid** → guard `getBid(...)` exists with a friendly message; `await deployed.callTx.revealBid()`; then re-read ledger and report "you lead" / "you did not take the lead (your amount stays private)" by comparing `view.winner` to the identity's public key — compute it locally: `const pk = toHexPublicKey(...)` via the compiled module's exported pure circuit if present (`mod.pureCircuits.publicKey(hexToBytes(sk))`) else compare before/after `highestBid`.
- **6 Finalize** → `await deployed.callTx.finalize()`; then print final status + declare winner.
- **7 My private state** → print identity name, secret key (truncated), and the sealed bid for this contract from `.sealed-identities.json`, labeled "LOCAL ONLY — never sent to chain".
- **8 New auction** → prompt item; `const newAddr = await deployAuction(providers, item)` as current identity (they become seller); `recordDeployment(network, newAddr, address.toString())`; `setActiveContract(newAddr)`; reconnect `deployed = await connectAuction(providers, newAddr)`.
- **9 Exit**.

After connecting initially: `setActiveContract(deployment.address)` before any callTx (witnesses need it).

- [ ] **Step 2: Typecheck**

```bash
cd midnight-app && npx tsc --noEmit
```
Expected: clean.

- [ ] **Step 3: Scripted smoke test (non-interactive)**

```bash
cd midnight-app && printf '1\n7\n9\n' | npm run cli
```
Expected: status renders with 0 bids, private state shows seller identity, clean exit.

- [ ] **Step 4: Full manual flow (one tx per phase)**

```bash
printf '2\nalice\n3\n1250000\n1\n9\n' | npm run cli
```
Expected: alice's commitment appears in status; amount nowhere in output of status view.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: interactive multi-identity auction CLI with on-chain/private views"
```

---

### Task 5: End-to-end flow test

**Files:**
- Rewrite: `midnight-app/scripts/e2e-check.ts`

**Interfaces:**
- Consumes: Task 2 API. Deploys its OWN auction instance (doesn't disturb the CLI's).

- [ ] **Step 1: Rewrite e2e-check.ts**

Structure (full wallet preamble copied from deploy.ts pattern — sync, DUST wait — then):

```typescript
// Distinctive amounts: their 8-byte encodings cannot appear in ledger bytes
// by coincidence, making the "losing bids never on-chain" assertion real.
const AMOUNTS = { alice: 1_311_768_467_463_790_320n, bob: 9_007_199_254_740_991n, carol: 3_735_928_559_000n };
// bob < carol < alice… pick clearly: alice highest. Reveal order: alice
// (eventual winner) FIRST, then bob, carol — worst case for privacy since
// later reveals are all losers.

function assertOk(cond: boolean, msg: string): asserts cond {
  if (!cond) { console.error(`❌ e2e: ${msg}`); process.exit(1); }
}

async function rawStateHex(providers: any, addr: string): Promise<string> {
  const cs = await providers.publicDataProvider.queryContractState(addr);
  return Buffer.from(cs.data.serialize ? cs.data.serialize() : cs.data).toString('hex');
}

function amountHexPatterns(n: bigint): string[] {
  const be = n.toString(16).padStart(16, '0');
  const le = Buffer.from(be, 'hex').reverse().toString('hex');
  return [be, le];
}
```

Flow:
1. `setCurrentIdentity('e2e-seller')`; deploy auction "e2e test lot"; `setActiveContract(addr)`; connect.
2. Read ledger: phase 'open', bidderCount 0.
3. For each of alice/bob/carol: `setCurrentIdentity`, `recordBid`, `callTx.placeBid()`. Re-read: bidderCount 3, three distinct commitments.
4. Assert NO amount pattern (BE or LE hex of each amount) occurs in `rawStateHex` — bids are sealed.
5. Negative: as 'e2e-mallory' with a recorded bid, after seller `closeBidding()`, expect `placeBid()` to reject (try/catch; assert error thrown, message mentions the assert or proof failure).
6. Reveal alice (winner) → ledger highestBid == alice amount, winner != null. Reveal bob, carol → highestBid unchanged, winner unchanged.
7. Assert bob's and carol's amount patterns STILL absent from raw state; alice's IS present-or-equal via `highestBid` field (winning price public by design).
8. Seller `finalize()` → phase 'closed'. Negative: `revealBid()` as carol again → rejects.
9. Print summary, exit 0.

(`cs.data` serialization: adapt to whatever `queryContractState` returns — if no serialize method, JSON.stringify the parsed ledger's bids+fields and search there; the point is "the indexer-visible contract state contains no losing amounts".)

- [ ] **Step 2: Run it**

```bash
cd midnight-app && npm run test:e2e
```
Expected: all assertions pass, exit 0. Budget ~10 min (≈9 proving txs at 30-60s).

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "test: full commit-reveal e2e — winner correct, losing bids never on-chain"
```

---

### Task 6: Documentation for judges

**Files:**
- Rewrite: `README.md` (repo root)
- Rewrite: `midnight-app/README.md`
- Modify: `SETUP.md` (title/references from hello-world to sealed auction, keep team setup content)

**Interfaces:** consumes final command surface from Tasks 3–5.

- [ ] **Step 1: Root README**

Sections (judge-first ordering, mirror judging criteria): project name + one-line pitch; **What it does** (3 sentences); **Why privacy needs this** (sealed bids on transparent chains leak to front-runners → MEV-free auctions, private OTC/procurement); **How it works** — ASCII diagram of commit→reveal with what's public vs private at each step, the four circuits, the honest threat model (1-bit leak on losing reveal, winning price public, unrevealed forfeits); **Run it in 3 commands** (`./setup.sh` → `cd midnight-app && npm run setup` → `npm run cli`); **Demo walkthrough** (the exact CLI steps the video shows); **Verify the privacy claim** (`npm run test:e2e` — states the assertion that losing amounts never appear in indexer state); **Architecture** (contract / auction-api / identities / CLI table); **Built at Midnight Hackathon July 2026 — DeFi track**; future work (escrow settlement, Vickrey second-price, web UI).

- [ ] **Step 2: midnight-app README**

Developer-facing: commands table (compile/setup/cli/test:e2e/proof-server), contract interface listing (ledger fields + circuits + witnesses), private-state files explained (`.sealed-identities.json`, `.midnight-state.json`), network switching (`--network preview`).

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "docs: judge-focused README — privacy model, run-in-3-commands, demo script"
```

---

### Task 7 (STRETCH — only if 0-6 green with ≥4h to deadline): Minimal web UI

Vite + vanilla TS page served locally that polls `readAuctionLedger` via a tiny express bridge and renders the on-chain view (phase timeline, commitment cards, winner banner). NO wallet integration — read-only visualizer beside the CLI. If attempted: `midnight-app/web/` + `npm run web`. Skip without hesitation if time is tight; the CLI demo is complete without it.

---

## Self-review notes

- Spec coverage: contract (Task 1), CLI incl. on-chain/private views + identities (Task 4), e2e with worst-case reveal order + absence assertion (Task 5), README privacy properties (Task 6), out-of-scope guarded (Task 7 stretch). Phase guards/error handling: circuit asserts (Task 1) + CLI catch/hints (Task 4) + negative tests (Task 5). ✓
- Type consistency: `AuctionView`, `SealedBid`, `Identity`, witness names `localSecretKey/bidAmount/bidNonce`, circuits `placeBid/closeBidding/revealBid/finalize` used identically across tasks. ✓
- Known-unknowns are explicit verify steps: compact-js witness combinator name (Task 2 Step 3), Compact conditional-write syntax (Task 1 fallback), contract-state serialization for the absence check (Task 5 note).
