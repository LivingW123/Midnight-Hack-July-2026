# Midnight Dev Stack — Team Setup

Everything you need to build on Midnight: Compact compiler, proof server (Docker), and the **Sealed** sealed-bid auction DApp in `midnight-app/` (see the [root README](README.md) for what it does).

> **Windows users: Midnight is not supported natively on Windows.** Use WSL (Ubuntu). All commands below run inside WSL, not PowerShell. Docker Desktop must have the WSL 2 backend enabled (it is by default).

## 0. Prerequisites

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

## 4. The app (`midnight-app/`)

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

Docs: [installation](https://docs.midnight.network/getting-started/installation) · [quickstart](https://docs.midnight.network/getting-started/quickstart) · [Compact language](https://docs.midnight.network/compact)
