/**
 * Plumbing for the multi-format Auction House contract — sibling of
 * auction-api.ts and game-api.ts, kept separate because each contract has its
 * own compiled assets, zk keys, and private-state store.
 *
 * Five mechanisms share one contract, so they also share one witness set. The
 * witnesses read from the CURRENT identity and the ACTIVE house address, which
 * is what lets the web server prove transactions as background bidders without
 * disturbing the paddle the user is driving.
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

import {
  currentIdentity,
  getBid,
  getSchedule,
  hexToBytes,
  recordSchedule,
  promoteSchedule,
  newPendingKey,
} from './identities';
import type { WalletContext } from './wallet';

export const HOUSE_PRIVATE_STATE_ID = 'auctionHousePrivateState';
export const HOUSE_STATE_FILE = path.resolve(process.cwd(), '.sealed-house.json');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const houseZkConfigPath = path.resolve(__dirname, '..', 'contracts', 'managed', 'auction-house');

// Contract enum order — must match Format in auction-house.compact.
export const FORMATS = ['firstPrice', 'dutch', 'batch', 'candle', 'combinatorial', 'timelock'] as const;
export type FormatName = (typeof FORMATS)[number];

const PHASES = ['open', 'reveal', 'closed'] as const;
export type PhaseName = (typeof PHASES)[number];

export interface FormatMeta {
  name: FormatName;
  title: string;
  blurb: string;
  /** What this mechanism keeps private that a transparent chain would leak. */
  privacy: string;
}

export const FORMAT_META: Record<FormatName, FormatMeta> = {
  firstPrice: {
    name: 'firstPrice',
    title: 'Sealed first-price',
    blurb: 'One lot, highest sealed bid wins and pays their bid.',
    privacy: 'Losing bids are never opened — their values stay sealed forever.',
  },
  dutch: {
    name: 'dutch',
    title: 'Dutch — hidden demand',
    blurb: 'The price descends in public. Bidders seal a reservation price and claim when the clock reaches it.',
    privacy:
      'The winner proves reservation >= current price in zero knowledge. Even on winning, how much more they would have paid never reaches the chain.',
  },
  batch: {
    name: 'batch',
    title: 'Uniform-price batch',
    blurb: 'Several units clear at a single price — the lowest winning bid. Built for token and NFT drops.',
    privacy: 'Only the bids that land in a winning slot are opened; the rest fall off the ladder unrevealed.',
  },
  candle: {
    name: 'candle',
    title: 'Candle — secret close',
    blurb: 'The seller commits a secret end-index before bidding opens. Bids after it never counted.',
    privacy: 'The end-index is binding from the first block, so the seller cannot move the close to suit the bids.',
  },
  combinatorial: {
    name: 'combinatorial',
    title: 'Combinatorial bundles',
    blurb: 'Three lots, seven possible bundles. Bid on the combination you actually want, all at once.',
    privacy: 'Bundle preferences stay sealed until reveal; the optimal allocation is proven, not asserted.',
  },
  timelock: {
    name: 'timelock',
    title: 'Time-locked reveal',
    blurb: 'Commit now, reveal later. Reveals stay shut until a committed unlock tick passes.',
    privacy: 'Nobody — including the seller — can open the field early, because the unlock tick was committed first.',
  },
};

let activeHouse = '';
export function setActiveHouse(addr: string): void {
  activeHouse = addr;
}
export function getActiveHouse(): string {
  return activeHouse;
}

/** Recorded houses, newest last. The web UI lets you walk between them. */
export function recordHouse(address: string, format: FormatName): void {
  const all = listHouses().filter((h) => h.address !== address);
  all.push({ address, format, at: new Date().toISOString() });
  fs.writeFileSync(HOUSE_STATE_FILE, JSON.stringify({ houses: all }, null, 2));
}

export interface HouseRecord {
  address: string;
  format: FormatName;
  at: string;
}

export function listHouses(): HouseRecord[] {
  try {
    return JSON.parse(fs.readFileSync(HOUSE_STATE_FILE, 'utf8')).houses ?? [];
  } catch {
    return [];
  }
}

let cachedModule: any;
export async function loadHouseModule(): Promise<any> {
  if (cachedModule) return cachedModule;
  const contractPath = path.join(houseZkConfigPath, 'contract', 'index.js');
  if (!fs.existsSync(contractPath)) {
    throw new Error('Auction House contract not compiled — run: npm run compile');
  }
  cachedModule = await import(pathToFileURL(contractPath).href);
  return cachedModule;
}

function requireBid(action: string) {
  const bid = getBid(currentIdentity().name, activeHouse);
  if (!bid) throw new Error(`no sealed bid recorded for "${currentIdentity().name}" — ${action}`);
  return bid;
}

function requireSchedule(action: string) {
  const schedule = getSchedule(currentIdentity().name, activeHouse);
  if (!schedule) {
    throw new Error(`no schedule secret recorded for "${currentIdentity().name}" — ${action}`);
  }
  return schedule;
}

/**
 * Witnesses are the privacy boundary: Midnight.js calls these locally during
 * proof generation and the values become private circuit inputs. They are read
 * here and never serialised into a transaction.
 *
 * The schedule witnesses only ever resolve for the seller — every other
 * identity's openSchedule proof would fail the commitment check anyway.
 */
function witnesses() {
  return {
    localSecretKey: ({ privateState }: any): [any, Uint8Array] => [
      privateState,
      hexToBytes(currentIdentity().secretKey),
    ],
    bidAmount: ({ privateState }: any): [any, bigint] => [
      privateState,
      BigInt(requireBid('place a bid first').amount),
    ],
    bidNonce: ({ privateState }: any): [any, Uint8Array] => [
      privateState,
      hexToBytes(requireBid('place a bid first').nonce),
    ],
    bidBundle: ({ privateState }: any): [any, bigint] => [
      privateState,
      BigInt(requireBid('place a bid first').bundle ?? '0'),
    ],
    scheduleSecret: ({ privateState }: any): [any, bigint] => [
      privateState,
      BigInt(requireSchedule('only the seller can open the schedule').tick),
    ],
    scheduleNonce: ({ privateState }: any): [any, Uint8Array] => [
      privateState,
      hexToBytes(requireSchedule('only the seller can open the schedule').nonce),
    ],
  };
}

export async function makeCompiledHouse(): Promise<any> {
  const mod = await loadHouseModule();
  return CompiledContract.make('auction-house', mod.Contract).pipe(
    (CompiledContract.withWitnesses as any)(witnesses()),
    (CompiledContract.withCompiledFileAssets as any)(houseZkConfigPath),
  );
}

/** Local mirror of the contract's publicKey circuit. */
export async function housePublicKeyHex(secretKeyHex: string): Promise<string> {
  const mod = await loadHouseModule();
  return Buffer.from(mod.pureCircuits.publicKey(hexToBytes(secretKeyHex))).toString('hex');
}

/** Local mirror of the contract's bidCommitment circuit (used by the e2e check). */
export async function bidCommitmentHex(amount: bigint, bundle: bigint, nonceHex: string): Promise<string> {
  const mod = await loadHouseModule();
  return Buffer.from(mod.pureCircuits.bidCommitment(amount, bundle, hexToBytes(nonceHex))).toString('hex');
}

export async function createHouseProviders(walletCtx: WalletContext, networkConfig: any) {
  const privateStatePassword =
    process.env.PRIVATE_STATE_PASSWORD?.trim() || 'Local-Devnet-Development-Placeholder-1';
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
  const zkConfigProvider = new NodeZkConfigProvider(houseZkConfigPath);
  return {
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName: 'auction-house-state',
      accountId: walletCtx.unshieldedKeystore.getBech32Address().toString(),
      privateStoragePasswordProvider: () => privateStatePassword,
    }),
    publicDataProvider: indexerPublicDataProvider(networkConfig.indexer, networkConfig.indexerWS),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(networkConfig.proofServer, zkConfigProvider),
    walletProvider,
    midnightProvider: walletProvider,
  };
}

export interface DeployHouseOptions {
  item: string;
  format: FormatName;
  /** Dutch: opening price. Ignored elsewhere. */
  startPrice?: bigint;
  /** Dutch: the descent stops here. */
  floorPrice?: bigint;
  /** Dutch: how far each tick walks the price down. */
  priceStep?: bigint;
  /** Batch: units for sale, 1..3. */
  supply?: bigint;
  /** Candle: secret end-index. Timelock: unlock tick. Chosen locally. */
  scheduleTick?: bigint;
}

const ZERO_SCHEDULE = new Uint8Array(32);

/**
 * Deploy a house as the CURRENT identity (the constructor derives `owner` from
 * localSecretKey()). Candle and timelock auctions commit their schedule secret
 * here — before the address exists — so it is written to disk under a pending
 * key and promoted once the deploy returns.
 */
export async function deployHouse(providers: any, opts: DeployHouseOptions): Promise<string> {
  const mod = await loadHouseModule();
  const compiled = await makeCompiledHouse();
  const formatIndex = FORMATS.indexOf(opts.format);
  if (formatIndex < 0) throw new Error(`unknown auction format: ${opts.format}`);

  const needsSchedule = opts.format === 'candle' || opts.format === 'timelock';
  const seller = currentIdentity().name;
  let pendingKey = '';
  let scheduleCommitment: Uint8Array = ZERO_SCHEDULE;

  if (needsSchedule) {
    const tick = opts.scheduleTick ?? 0n;
    pendingKey = newPendingKey();
    const schedule = recordSchedule(seller, pendingKey, tick);
    // Same circuit openSchedule verifies against, so the two can never drift.
    scheduleCommitment = mod.pureCircuits.scheduleCommitment(tick, hexToBytes(schedule.nonce));
  }

  const args = [
    opts.item,
    formatIndex,
    opts.startPrice ?? 0n,
    opts.floorPrice ?? 0n,
    opts.priceStep ?? 0n,
    opts.supply ?? 1n,
    scheduleCommitment,
  ];

  const MAX_RETRIES = 20;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const deployed = await deployContract(providers, {
        compiledContract: compiled as any,
        args,
        privateStateId: HOUSE_PRIVATE_STATE_ID,
        initialPrivateState: {},
      });
      const address = deployed.deployTxData.public.contractAddress;
      if (needsSchedule) promoteSchedule(seller, pendingKey, address);
      return address;
    } catch (err: any) {
      const full = `${err?.message ?? ''} ${err?.cause?.message ?? ''}`;
      const dust =
        full.includes('Not enough Dust') ||
        full.includes('Insufficient Funds') ||
        full.includes('could not balance dust');
      if (!dust || attempt === MAX_RETRIES) throw err;
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  throw new Error('unreachable');
}

export async function connectHouse(providers: any, contractAddress: string): Promise<any> {
  const compiled = await makeCompiledHouse();
  return findDeployedContract(providers, {
    compiledContract: compiled as any,
    contractAddress,
    privateStateId: HOUSE_PRIVATE_STATE_ID,
    initialPrivateState: {},
  });
}

export interface HouseView {
  format: FormatName;
  phase: PhaseName;
  item: string;
  owner: string;
  bids: Array<{ bidderId: string; commitment: string; index: number }>;
  bidderCount: number;
  revealedCount: number;
  highestBid: bigint;
  winner: string | null;
  // Dutch
  currentPrice: bigint;
  floorPrice: bigint;
  priceStep: bigint;
  tickCount: number;
  // Batch
  supply: number;
  slots: Array<{ rank: number; price: bigint; winner: string | null }>;
  filledSlots: number;
  clearingPrice: bigint;
  clearingLocked: boolean;
  // Candle / timelock
  scheduleOpen: boolean;
  scheduleTick: number;
  // Combinatorial
  bundles: Array<{ mask: number; best: bigint; winner: string | null }>;
  allocation: number[];
  allocationValue: bigint;
  allocationLocked: boolean;
}

const ZERO32 = '0'.repeat(64);

function toHex(v: Uint8Array): string {
  return Buffer.from(v).toString('hex');
}

function orNull(hex: string): string | null {
  return hex === ZERO32 ? null : hex;
}

export async function readHouseLedger(providers: any, contractAddress: string): Promise<HouseView> {
  const mod = await loadHouseModule();
  const contractState = await providers.publicDataProvider.queryContractState(contractAddress);
  if (!contractState) throw new Error(`no on-chain state found for house ${contractAddress}`);
  const raw = mod.ledger(contractState.data);

  const indexById = new Map<string, number>();
  for (const [id, idx] of raw.bidIndex) indexById.set(toHex(id), Number(idx));

  const bids: HouseView['bids'] = [];
  for (const [bidderId, commitment] of raw.bids) {
    const hex = toHex(bidderId);
    bids.push({ bidderId: hex, commitment: toHex(commitment), index: indexById.get(hex) ?? 0 });
  }
  bids.sort((a, b) => a.index - b.index);

  const slots = [
    { rank: 0, price: BigInt(raw.slot0Price), winner: orNull(toHex(raw.slot0Winner)) },
    { rank: 1, price: BigInt(raw.slot1Price), winner: orNull(toHex(raw.slot1Winner)) },
    { rank: 2, price: BigInt(raw.slot2Price), winner: orNull(toHex(raw.slot2Winner)) },
  ].filter((s) => s.winner !== null);

  const bundleWinners = new Map<number, string>();
  for (const [mask, id] of raw.bundleWinner) bundleWinners.set(Number(mask), toHex(id));
  const bundles: HouseView['bundles'] = [];
  for (const [mask, best] of raw.bundleBest) {
    const m = Number(mask);
    bundles.push({ mask: m, best: BigInt(best), winner: bundleWinners.get(m) ?? null });
  }
  bundles.sort((a, b) => a.mask - b.mask);

  const allocation = [Number(raw.allocationA), Number(raw.allocationB), Number(raw.allocationC)].filter((m) => m > 0);

  return {
    format: FORMATS[Number(raw.format)] ?? 'firstPrice',
    phase: PHASES[Number(raw.phase)] ?? 'closed',
    item: String(raw.item),
    owner: toHex(raw.owner),
    bids,
    bidderCount: Number(raw.bidderCount),
    revealedCount: Number(raw.revealedCount),
    highestBid: BigInt(raw.highestBid),
    winner: raw.hasWinner ? orNull(toHex(raw.winner)) : null,
    currentPrice: BigInt(raw.currentPrice),
    floorPrice: BigInt(raw.floorPrice),
    priceStep: BigInt(raw.priceStep),
    tickCount: Number(raw.tickCount),
    supply: Number(raw.supply),
    slots,
    filledSlots: Number(raw.filledSlots),
    clearingPrice: BigInt(raw.clearingPrice),
    clearingLocked: Boolean(raw.clearingLocked),
    scheduleOpen: Boolean(raw.scheduleOpen),
    scheduleTick: Number(raw.scheduleTick),
    bundles,
    allocation,
    allocationValue: BigInt(raw.allocationValue),
    allocationLocked: Boolean(raw.allocationLocked),
  };
}

/** Human-readable lot names for the combinatorial bundle masks. */
export function bundleLabel(mask: number): string {
  const lots = ['A', 'B', 'C'].filter((_, i) => (mask >> i) & 1);
  return lots.join('+') || '—';
}
