# Midnight Dev Stack — Team Setup

Everything you need to build on Midnight: Compact compiler, proof server (Docker), Lace wallet, and the **Sealed** sealed-bid auction DApp in `midnight-app/` (see the [root README](README.md) for what it does).

> **Windows users: Midnight is not supported natively on Windows.** Use WSL (Ubuntu). All commands below run inside WSL, not PowerShell. Docker Desktop must have the WSL 2 backend enabled (it is by default).

## 0. Prerequisites

- Google Chrome
- VS Code
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (with Docker Compose v2)
- Node.js 22+ (in WSL: `curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash && nvm install 22`)
- Windows only: WSL — in an **admin** PowerShell: `wsl --install -d Ubuntu`, then reboot

## 1. One-shot script (WSL / Linux / macOS)

From the repo root:

```bash
./setup.sh
```

This installs the Compact toolchain, compiles the contract, installs npm deps, and starts the proof server. Or do it manually:

## 2. Compact compiler

```bash
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/midnightntwrk/compact/releases/latest/download/compact-installer.sh | sh
# restart shell or: export PATH="$HOME/.local/bin:$PATH"
compact update            # installs latest compiler (0.31.x)
compact compile --version # verify
```

## 3. Proof server (Docker)

```bash
docker run -p 6300:6300 midnightntwrk/proof-server:latest midnight-proof-server -v
```

Verify: logs show it listening at http://localhost:6300.

> **Apple Silicon (M1/M2/M3) Macs:** the official arm64 image has a known bug. Use the Bricktower image instead:
> ```bash
> docker run -p 6300:6300 bricktowers/proof-server:latest midnight-proof-server -v
> ```

Note: for the local hello-world devnet you don't need to run this manually — `npm run setup` in `midnight-app/` boots node + indexer + proof server via docker-compose.

## 4. Lace wallet (browser)

1. In Chrome, install the **Lace Beta** extension from the Chrome Web Store (see [Lace wallet guide](https://docs.midnight.network/guides/lace-wallet)). Chrome only.
2. Create a wallet, save the seed phrase.
3. Get tDUST: click **Receive**, copy your unshielded address, paste it at the [preprod faucet](https://faucet.preprod.midnight.network/), then click **Generate tDUST** once tokens arrive.
4. Point Lace at your local proof server: **Settings » Midnight » Local (http://localhost:6300)**.

Not needed for local devnet development — only for testnet deploys and browser DApps.

## 5. VS Code extension

Download the [Compact VSIX](https://raw.githubusercontent.com/midnight-ntwrk/releases/gh-pages/artifacts/vscode-extension/compact-0.2.13/compact-0.2.13.vsix), then in VS Code: **Extensions » ⋯ » Install from VSIX**.

## 6. The app (`midnight-app/`)

The Sealed auction DApp (originally scaffolded with `create-mn-app`). To run:

```bash
cd midnight-app
npm install        # node_modules is gitignored
npm run setup      # boots local devnet (Docker) + compiles + deploys — no wallet/faucet needed
npm run cli        # interact with the deployed contract
```

Deploy to public testnet instead: `npm run setup -- --network preview` (CLI prints a faucet URL for the generated wallet).

| Piece | Status |
| --- | --- |
| Compact compiler 0.31.1 | verified — contract compiles, prover/verifier keys generate |
| DApp scaffold + deps (lockfile committed) | verified — `tsc` passes |
| Proof server / devnet | needs Docker on your machine: `npm run setup` |
| Lace wallet + VS Code ext | manual browser/VS Code steps above |

Docs: [installation](https://docs.midnight.network/getting-started/installation) · [quickstart](https://docs.midnight.network/getting-started/quickstart) · [Compact language](https://docs.midnight.network/compact)
