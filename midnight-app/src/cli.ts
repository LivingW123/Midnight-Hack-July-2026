/**
 * Interactive CLI for the sealed-bid auction.
 *
 * Lets you play every role in the auction from one terminal: switch between
 * named identities (seller, alice, bob, ...), place sealed bids, close the
 * auction, reveal, and finalize — and, crucially for the demo, inspect the
 * raw on-chain public state side by side with your local private state.
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { WebSocket } from 'ws';

import { resolveNetwork, getOrCreateSeed, getDeployment, recordDeployment } from './network';
import { createWallet, persistWalletState, unshieldedToken } from './wallet';
import {
  createProviders,
  connectAuction,
  deployAuction,
  readAuctionLedger,
  setActiveContract,
  publicKeyHex,
  type AuctionView,
} from './auction-api';
import {
  currentIdentity,
  setCurrentIdentity,
  listIdentities,
  recordBid,
  getBid,
} from './identities';

// Enable WebSocket for GraphQL subscriptions
// @ts-expect-error Required for wallet sync
globalThis.WebSocket = WebSocket;

const { network, config: networkConfig } = resolveNetwork();
const SEED = getOrCreateSeed(network);

function short(hex: string): string {
  return hex.length <= 18 ? hex : `${hex.slice(0, 10)}…${hex.slice(-6)}`;
}

function printStatus(view: AuctionView, contractAddress: string): void {
  console.log('\n─── On-chain public state (what everyone sees) ─────────────────');
  console.log(`  Contract:  ${short(contractAddress)}`);
  console.log(`  Item:      ${view.item}`);
  console.log(`  Phase:     ${view.phase.toUpperCase()}`);
  console.log(`  Seller id: ${short(view.owner)}`);
  console.log(`  Sealed bids (${view.bidderCount}):`);
  for (const b of view.bids) {
    console.log(`    bidder ${short(b.bidderId)} → commitment ${short(b.commitment)}`);
  }
  if (view.bids.length === 0) console.log('    (none yet)');
  console.log(`  Highest revealed bid: ${view.highestBid > 0n ? view.highestBid.toLocaleString() : '—'}`);
  console.log(`  Winner: ${view.winner ? short(view.winner) : '—'}`);
  console.log('  ℹ Commitments are hiding + binding: bid amounts are NOT derivable');
  console.log('    from anything above. Losing amounts never touch the chain.\n');
}

/** Map common circuit assert messages to friendly hints. */
function explainFailure(message: string): string | null {
  const hints: Array<[string, string]> = [
    ['bidding is closed', 'The auction is past its bidding phase.'],
    ['already placed a bid', 'This identity already has a sealed bid — switch identity to bid again.'],
    ['only the seller can', 'Only the seller identity that created this auction can do that.'],
    ['auction is not in reveal phase', 'Finalizing needs the REVEAL phase — the seller must close bidding first.'],
    ['not in reveal phase', 'Reveals only work after the seller closes bidding.'],
    ['no sealed bid found', 'This identity never placed a bid on this auction.'],
    ['does not match sealed bid', 'Local bid record does not open the on-chain commitment.'],
    ['bidding is not open', 'Bidding is already closed.'],
    ['not in reveal', 'Wrong phase for that action.'],
  ];
  for (const [needle, hint] of hints) {
    if (message.includes(needle)) return hint;
  }
  return null;
}

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║         Sealed — private sealed-bid auctions on Midnight     ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  const rl = createInterface({ input: stdin, output: stdout });

  // Piped/scripted input support: lines that arrive while no question is
  // pending (e.g. during wallet sync) would be dropped by readline and EOF
  // would reject the next question. Queue them instead, and report EOF as
  // null so the menu loop can exit cleanly.
  const bufferedLines: string[] = [];
  const lineWaiters: Array<(line: string | null) => void> = [];
  let inputClosed = false;
  rl.on('line', (line) => {
    const waiter = lineWaiters.shift();
    if (waiter) waiter(line);
    else bufferedLines.push(line);
  });
  rl.on('close', () => {
    inputClosed = true;
    for (const waiter of lineWaiters.splice(0)) waiter(null);
  });
  async function ask(prompt: string): Promise<string | null> {
    stdout.write(prompt);
    if (bufferedLines.length > 0) {
      const line = bufferedLines.shift()!;
      stdout.write(`${line}\n`);
      return line;
    }
    if (inputClosed) return null;
    return new Promise((resolve) => lineWaiters.push(resolve));
  }

  const deployment = getDeployment(network);
  if (!deployment) {
    console.error(`No deploy on file for network ${network}. Run \`npm run setup -- --network ${network}\` first.`);
    process.exit(1);
  }
  let contractAddress: string = deployment.address;
  console.log(`  Contract: ${contractAddress}`);
  console.log(`  Network: ${network}\n`);

  let walletCtx: Awaited<ReturnType<typeof createWallet>> | undefined;
  try {
    console.log('  Connecting to wallet...');
    walletCtx = await createWallet({ network, networkConfig, seed: SEED });
    const restoredCount = Object.values(walletCtx.restored).filter(Boolean).length;
    if (restoredCount > 0) {
      console.log(`  Restored ${restoredCount}/3 child wallets from .midnight-wallet-state — sync will resume from saved point.`);
    }

    console.log('  Syncing with network...');
    const syncStart = Date.now();
    const syncInterval = setInterval(() => {
      const elapsed = Math.round((Date.now() - syncStart) / 1000);
      process.stdout.write(`\r  ⏳ Still syncing... (${elapsed}s elapsed)   `);
    }, 5000);
    const state = await walletCtx.wallet.waitForSyncedState();
    clearInterval(syncInterval);
    process.stdout.write('\r  ✓ Synced with network.                                      \n');

    await persistWalletState(network, walletCtx);
    const balance = state.unshielded.balances[unshieldedToken().raw] ?? 0n;
    console.log(`  Balance: ${balance.toLocaleString()} tNight\n`);

    console.log('  Connecting to auction contract...');
    const providers = await createProviders(walletCtx, networkConfig);
    setActiveContract(contractAddress);
    let deployed: any = await connectAuction(providers, contractAddress);
    console.log('  ✅ Connected!\n');

    let running = true;
    while (running) {
      const me = currentIdentity();
      console.log('─── Menu ───────────────────────────────────────────────────────');
      console.log(`  Acting as: ${me.name}`);
      console.log('  1. Show auction status (on-chain public view)');
      console.log('  2. Switch identity');
      console.log('  3. Place sealed bid');
      console.log('  4. Close bidding        (seller only)');
      console.log('  5. Reveal my bid');
      console.log('  6. Finalize auction     (seller only)');
      console.log('  7. Show my private state (local only)');
      console.log('  8. Create new auction   (you become the seller)');
      console.log('  9. Exit\n');

      const rawChoice = await ask('  Your choice: ');
      if (rawChoice === null) {
        console.log('\n  Input ended — exiting.\n');
        break;
      }
      const choice = rawChoice.trim();

      try {
        switch (choice) {
          case '1': {
            const view = await readAuctionLedger(providers, contractAddress);
            printStatus(view, contractAddress);
            break;
          }

          case '2': {
            const names = listIdentities();
            console.log(`\n  Known identities: ${names.length ? names.join(', ') : '(none yet)'}`);
            const name = ((await ask('  Identity name (new names are created): ')) ?? '').trim();
            if (!name) {
              console.log('\n  ❌ Name cannot be empty.\n');
              break;
            }
            setCurrentIdentity(name);
            console.log(`\n  ✅ Now acting as "${name}".\n`);
            break;
          }

          case '3': {
            const amountStr = ((await ask('  Bid amount (positive integer): ')) ?? '').trim();
            if (!/^[0-9]+$/.test(amountStr) || BigInt(amountStr) <= 0n) {
              console.log('\n  ❌ Enter a positive integer amount.\n');
              break;
            }
            recordBid(me.name, contractAddress, BigInt(amountStr));
            console.log('\n  Sealing bid and proving (30-60s)...');
            const tx = await deployed.callTx.placeBid();
            console.log(`\n  ✅ Sealed bid placed as "${me.name}".`);
            console.log(`  Transaction: ${tx.public.txId}`);
            console.log('  Your amount and nonce stayed on this machine — only the');
            console.log('  commitment went on-chain.\n');
            break;
          }

          case '4': {
            console.log('\n  Closing bidding (30-60s)...');
            const tx = await deployed.callTx.closeBidding();
            console.log(`\n  ✅ Bidding closed. Reveal phase begins. (tx ${short(tx.public.txId)})\n`);
            break;
          }

          case '5': {
            if (!getBid(me.name, contractAddress)) {
              console.log(`\n  ❌ "${me.name}" has no sealed bid on this auction.\n`);
              break;
            }
            console.log('\n  Proving your reveal in zero knowledge (30-60s)...');
            const tx = await deployed.callTx.revealBid();
            const view = await readAuctionLedger(providers, contractAddress);
            const myId = await publicKeyHex(me.secretKey);
            console.log(`\n  ✅ Reveal accepted. (tx ${short(tx.public.txId)})`);
            if (view.winner === myId) {
              console.log(`  🏆 You currently lead at ${view.highestBid.toLocaleString()}.\n`);
            } else {
              console.log('  You did not take the lead — and your amount stays private forever.\n');
            }
            break;
          }

          case '6': {
            console.log('\n  Finalizing auction (30-60s)...');
            await deployed.callTx.finalize();
            const view = await readAuctionLedger(providers, contractAddress);
            console.log('\n  ✅ Auction finalized.');
            if (view.winner) {
              console.log(`  🏆 Winner: bidder ${short(view.winner)} at ${view.highestBid.toLocaleString()}.`);
              console.log('  All losing bid amounts remain sealed forever.\n');
            } else {
              console.log('  No bids were revealed — no winner.\n');
            }
            break;
          }

          case '7': {
            const bid = getBid(me.name, contractAddress);
            console.log('\n─── Your private state (LOCAL ONLY — never sent to chain) ──────');
            console.log(`  Identity:   ${me.name}`);
            console.log(`  Secret key: ${short(me.secretKey)} (full key in .sealed-identities.json)`);
            console.log(`  On-chain id: ${short(await publicKeyHex(me.secretKey))} (= hash(secret key))`);
            if (bid) {
              console.log(`  Sealed bid on this auction:`);
              console.log(`    amount: ${BigInt(bid.amount).toLocaleString()}`);
              console.log(`    nonce:  ${short(bid.nonce)}`);
            } else {
              console.log('  No sealed bid on this auction yet.');
            }
            console.log('');
            break;
          }

          case '8': {
            const item = ((await ask('  What are you auctioning? ')) ?? '').trim();
            if (!item) {
              console.log('\n  ❌ Item description cannot be empty.\n');
              break;
            }
            console.log(`\n  Deploying new auction as seller "${me.name}" (30-60s)...`);
            const newAddr = await deployAuction(providers, item);
            recordDeployment(network, newAddr, walletCtx.unshieldedKeystore.getBech32Address().toString());
            contractAddress = newAddr;
            setActiveContract(newAddr);
            deployed = await connectAuction(providers, newAddr);
            console.log(`\n  ✅ New auction live at ${short(newAddr)} — "${item}".`);
            console.log(`  Seller identity: "${me.name}".\n`);
            break;
          }

          case '9':
            running = false;
            console.log('\n  👋 Goodbye!\n');
            break;

          default:
            console.log('\n  ❌ Invalid choice. Please enter 1-9.\n');
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`\n  ❌ Failed: ${message}`);
        const hint = explainFailure(message);
        if (hint) console.error(`  💡 ${hint}`);
        console.log('');
      }
    }

    await persistWalletState(network, walletCtx);
  } catch (error) {
    console.error('\n❌ Error:', error instanceof Error ? error.message : error);
  } finally {
    rl.close();
    // Always stop the wallet: open indexer/node websockets otherwise keep the
    // process alive forever, including on the error path.
    if (walletCtx) await walletCtx.wallet.stop().catch(() => {});
    process.exit(0);
  }
}

main().catch(console.error);
