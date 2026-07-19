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
  bundle?: string; // combinatorial lot bitmask 1..7; absent/"0" for every other format
}

/**
 * A seller's committed schedule for the candle and time-locked formats: the
 * secret end-index / unlock tick plus its opening nonce. Committed at deploy,
 * opened once bidding closes — so it is binding before the first bid lands.
 */
export interface SealedSchedule {
  tick: string;  // decimal string
  nonce: string; // 32-byte hex
}

export interface Identity {
  name: string;
  secretKey: string; // 32-byte hex
  bids: Record<string, SealedBid>; // contractAddress -> sealed bid
  schedules?: Record<string, SealedSchedule>; // contractAddress -> schedule secret
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

// Temporary identity override: lets background actors (rival bidders in the
// web app) prove transactions AS themselves without touching the persisted
// "current" identity the user is driving. Safe because transactions are
// serialized — there is never more than one prover running.
let identityOverride: string | null = null;

export function currentIdentity(): Identity {
  if (identityOverride) return getOrCreateIdentity(identityOverride);
  const store = load();
  return getOrCreateIdentity(store.current || 'seller');
}

export async function runAsIdentity<T>(name: string, fn: () => Promise<T>): Promise<T> {
  getOrCreateIdentity(name);
  identityOverride = name;
  try {
    return await fn();
  } finally {
    identityOverride = null;
  }
}

export function listIdentities(): string[] {
  return Object.keys(load().identities);
}

/**
 * Choose a fresh nonce and persist the sealed bid BEFORE the tx is sent, so
 * a crash between commit and reveal can never lose the opening.
 */
export function recordBid(
  name: string,
  contractAddress: string,
  amount: bigint,
  bundle: bigint = 0n,
): SealedBid {
  const store = load();
  const identity = store.identities[name];
  if (!identity) throw new Error(`unknown identity: ${name}`);
  const bid: SealedBid = {
    amount: amount.toString(),
    nonce: randomBytes(32).toString('hex'),
    bundle: bundle.toString(),
  };
  identity.bids[contractAddress] = bid;
  save(store);
  return bid;
}

export function getBid(name: string, contractAddress: string): SealedBid | undefined {
  return load().identities[name]?.bids[contractAddress];
}

/**
 * Persist a schedule secret, same reasoning as recordBid: a crash must never
 * strand an auction that can no longer open its own end-index.
 *
 * The commitment is a CONSTRUCTOR argument, so it has to exist before the
 * contract address does. We therefore write it under a pending key first and
 * promote it to the real address once the deploy returns — never the other
 * way round, so the secret is on disk before it is provable on-chain.
 */
export function recordSchedule(name: string, key: string, tick: bigint): SealedSchedule {
  const store = load();
  const identity = store.identities[name];
  if (!identity) throw new Error(`unknown identity: ${name}`);
  const schedule: SealedSchedule = { tick: tick.toString(), nonce: randomBytes(32).toString('hex') };
  identity.schedules = { ...(identity.schedules ?? {}), [key]: schedule };
  save(store);
  return schedule;
}

export function newPendingKey(): string {
  return `pending:${randomBytes(8).toString('hex')}`;
}

export function promoteSchedule(name: string, fromKey: string, contractAddress: string): void {
  const store = load();
  const identity = store.identities[name];
  const schedule = identity?.schedules?.[fromKey];
  if (!identity || !schedule) return;
  identity.schedules![contractAddress] = schedule;
  delete identity.schedules![fromKey];
  save(store);
}

export function getSchedule(name: string, contractAddress: string): SealedSchedule | undefined {
  return load().identities[name]?.schedules?.[contractAddress];
}

export function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}
