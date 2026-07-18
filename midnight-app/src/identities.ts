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

/**
 * Choose a fresh nonce and persist the sealed bid BEFORE the tx is sent, so
 * a crash between commit and reveal can never lose the opening.
 */
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
