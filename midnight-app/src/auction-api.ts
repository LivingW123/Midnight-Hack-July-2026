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

let cachedModule: any;
export async function loadAuctionModule(): Promise<any> {
  if (cachedModule) return cachedModule;
  const contractPath = path.join(zkConfigPath, 'contract', 'index.js');
  if (!fs.existsSync(contractPath)) {
    console.error('\n❌ Contract not compiled! Run: npm run compile\n');
    process.exit(1);
  }
  cachedModule = await import(pathToFileURL(contractPath).href);
  return cachedModule;
}

function requireBid(context: string) {
  const bid = getBid(currentIdentity().name, activeContract);
  if (!bid) {
    throw new Error(
      `no sealed bid recorded for identity "${currentIdentity().name}" on contract ${activeContract || '(none active)'} — ${context}`,
    );
  }
  return bid;
}

/**
 * Witnesses: Midnight.js calls these locally during proof generation; the
 * returned values are private inputs to the circuit and never leave this
 * machine. Signature per generated types: (ctx) => [newPrivateState, value].
 */
function witnesses() {
  return {
    localSecretKey: ({ privateState }: any): [any, Uint8Array] => [
      privateState,
      hexToBytes(currentIdentity().secretKey),
    ],
    bidAmount: ({ privateState }: any): [any, bigint] => [
      privateState,
      BigInt(requireBid('place or reveal a bid first').amount),
    ],
    bidNonce: ({ privateState }: any): [any, Uint8Array] => [
      privateState,
      hexToBytes(requireBid('place or reveal a bid first').nonce),
    ],
  };
}

export async function makeCompiledAuction(): Promise<any> {
  const mod = await loadAuctionModule();
  // The contract module is imported dynamically (typed `any`), so the
  // combinators' generic inference collapses — cast like the scaffold did.
  return CompiledContract.make('sealed-auction', mod.Contract).pipe(
    (CompiledContract.withWitnesses as any)(witnesses()),
    (CompiledContract.withCompiledFileAssets as any)(zkConfigPath),
  );
}

/** Local on-chain id for an identity: mirrors the contract's publicKey circuit. */
export async function publicKeyHex(secretKeyHex: string): Promise<string> {
  const mod = await loadAuctionModule();
  return Buffer.from(mod.pureCircuits.publicKey(hexToBytes(secretKeyHex))).toString('hex');
}

export async function createProviders(walletCtx: WalletContext, networkConfig: any) {
  // The SDK requires the private-state password to be at least 16 characters.
  // The default below is a placeholder for local devnet only — set a strong
  // password via PRIVATE_STATE_PASSWORD when you move to a non-local target.
  const privateStatePassword = process.env.PRIVATE_STATE_PASSWORD?.trim() || 'Local-Devnet-Development-Placeholder-1';

  const walletProvider = {
    // In Midnight.js 4.1.x the WalletProvider interface returns the key objects
    // (CoinPublicKey / EncPublicKey) directly — no longer hex strings.
    getCoinPublicKey: () => walletCtx.shieldedSecretKeys.coinPublicKey,
    getEncryptionPublicKey: () => walletCtx.shieldedSecretKeys.encryptionPublicKey,
    async balanceTx(tx: any, ttl?: Date) {
      // balanceUnboundTransaction -> finalizeRecipe is the complete balancing
      // path in wallet-sdk 1.x; the earlier explicit signRecipe step is gone.
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

/**
 * Deploy a new auction as the CURRENT identity (the constructor derives
 * `owner` from localSecretKey()). DUST-projection retry loop preserved from
 * the scaffold: the wallet's DUST balance is a wall-clock projection that
 * lags block timestamps by ~1 block on a fresh devnet.
 */
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

function toHex(v: Uint8Array): string {
  return Buffer.from(v).toString('hex');
}

export async function readAuctionLedger(providers: any, contractAddress: string): Promise<AuctionView> {
  const mod = await loadAuctionModule();
  const contractState = await providers.publicDataProvider.queryContractState(contractAddress);
  if (!contractState) throw new Error(`no on-chain state found for contract ${contractAddress}`);
  const raw = mod.ledger(contractState.data);
  const bids: AuctionView['bids'] = [];
  for (const [bidderId, commitment] of raw.bids) {
    bids.push({ bidderId: toHex(bidderId), commitment: toHex(commitment) });
  }
  const winnerHex = toHex(raw.winner);
  return {
    phase: PHASES[Number(raw.phase)] ?? 'closed',
    item: String(raw.item),
    owner: toHex(raw.owner),
    bids,
    bidderCount: Number(raw.bidderCount),
    highestBid: BigInt(raw.highestBid),
    winner: winnerHex === ZERO32 ? null : winnerHex,
  };
}
