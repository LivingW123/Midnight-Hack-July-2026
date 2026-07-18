/**
 * Plumbing for the Number Game contract — sibling of auction-api.ts, kept
 * separate because each contract has its own compiled assets, zk keys, and
 * private-state store. Sealed guesses reuse the identity store's per-contract
 * bid records (amount = the guess, nonce = the opening).
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

export const GAME_PRIVATE_STATE_ID = 'numberGamePrivateState';
export const GAME_STATE_FILE = path.resolve(process.cwd(), '.sealed-game.json');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const gameZkConfigPath = path.resolve(__dirname, '..', 'contracts', 'managed', 'number-game');

let activeGame = '';
export function setActiveGame(addr: string): void {
  activeGame = addr;
}

export function recordGame(address: string): void {
  fs.writeFileSync(GAME_STATE_FILE, JSON.stringify({ address }, null, 2));
}
export function getRecordedGame(): string | null {
  try {
    return JSON.parse(fs.readFileSync(GAME_STATE_FILE, 'utf8')).address ?? null;
  } catch {
    return null;
  }
}

let cachedModule: any;
export async function loadGameModule(): Promise<any> {
  if (cachedModule) return cachedModule;
  const contractPath = path.join(gameZkConfigPath, 'contract', 'index.js');
  if (!fs.existsSync(contractPath)) {
    throw new Error('Number Game contract not compiled — run: npm run compile');
  }
  cachedModule = await import(pathToFileURL(contractPath).href);
  return cachedModule;
}

function requireGuess(action: string) {
  const bid = getBid(currentIdentity().name, activeGame);
  if (!bid) throw new Error(`no sealed guess recorded for "${currentIdentity().name}" — ${action}`);
  return bid;
}

function witnesses() {
  return {
    localSecretKey: ({ privateState }: any): [any, Uint8Array] => [
      privateState,
      hexToBytes(currentIdentity().secretKey),
    ],
    guessValue: ({ privateState }: any): [any, bigint] => [
      privateState,
      BigInt(requireGuess('seal a guess first').amount),
    ],
    guessNonce: ({ privateState }: any): [any, Uint8Array] => [
      privateState,
      hexToBytes(requireGuess('seal a guess first').nonce),
    ],
  };
}

export async function makeCompiledGame(): Promise<any> {
  const mod = await loadGameModule();
  return CompiledContract.make('number-game', mod.Contract).pipe(
    (CompiledContract.withWitnesses as any)(witnesses()),
    (CompiledContract.withCompiledFileAssets as any)(gameZkConfigPath),
  );
}

export async function createGameProviders(walletCtx: WalletContext, networkConfig: any) {
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
  const zkConfigProvider = new NodeZkConfigProvider(gameZkConfigPath);
  return {
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName: 'number-game-state',
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

export async function deployGame(providers: any, question: string): Promise<string> {
  const compiled = await makeCompiledGame();
  const MAX_RETRIES = 20;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const deployed = await deployContract(providers, {
        compiledContract: compiled as any,
        args: [question],
        privateStateId: GAME_PRIVATE_STATE_ID,
        initialPrivateState: {},
      });
      return deployed.deployTxData.public.contractAddress;
    } catch (err: any) {
      const full = `${err?.message ?? ''} ${err?.cause?.message ?? ''}`;
      const dust = full.includes('Not enough Dust') || full.includes('Insufficient Funds') || full.includes('could not balance dust');
      if (!dust || attempt === MAX_RETRIES) throw err;
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  throw new Error('unreachable');
}

export async function connectGame(providers: any, contractAddress: string): Promise<any> {
  const compiled = await makeCompiledGame();
  return findDeployedContract(providers, {
    compiledContract: compiled as any,
    contractAddress,
    privateStateId: GAME_PRIVATE_STATE_ID,
    initialPrivateState: {},
  });
}

export interface GameView {
  phase: 'sealing' | 'reveal' | 'reckoning' | 'closed';
  question: string;
  owner: string;
  entries: Array<{ id: string; commitment: string }>;
  entryCount: number;
  guesses: Array<{ id: string; guess: number }>;
  revealedSum: number;
  revealedCount: number;
  target: number;
  bestDistance: number;
  champion: string | null;
}

const PHASES = ['sealing', 'reveal', 'reckoning', 'closed'] as const;

function toHex(v: Uint8Array): string {
  return Buffer.from(v).toString('hex');
}

export async function readGameLedger(providers: any, contractAddress: string): Promise<GameView> {
  const mod = await loadGameModule();
  const contractState = await providers.publicDataProvider.queryContractState(contractAddress);
  if (!contractState) throw new Error(`no on-chain state found for game ${contractAddress}`);
  const raw = mod.ledger(contractState.data);
  const entries: GameView['entries'] = [];
  for (const [id, commitment] of raw.entries) entries.push({ id: toHex(id), commitment: toHex(commitment) });
  const guesses: GameView['guesses'] = [];
  for (const [id, guess] of raw.guesses) guesses.push({ id: toHex(id), guess: Number(guess) });
  return {
    phase: PHASES[Number(raw.phase)] ?? 'closed',
    question: String(raw.question),
    owner: toHex(raw.owner),
    entries,
    entryCount: Number(raw.entryCount),
    guesses,
    revealedSum: Number(raw.revealedSum),
    revealedCount: Number(raw.revealedCount),
    target: Number(raw.target),
    bestDistance: Number(raw.bestDistance),
    champion: raw.hasChampion ? toHex(raw.champion) : null,
  };
}

/** floor((2*sum) / (3*count)) — the quotient the lockTarget circuit verifies. */
export function twoThirdsMean(sum: number, count: number): number {
  if (count === 0) return 0;
  return Math.floor((2 * sum) / (3 * count));
}
