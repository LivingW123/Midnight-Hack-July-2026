/* Sealed — frontend. Polls /api/status, updates the DOM in place.
   No framework: the HTML is the skeleton; this file only fills it in. */

const $ = (id) => document.getElementById(id);

const state = {
  status: null,
  initialized: false,  // first /api/status adopted (suppresses stale toasts)
  lastJobId: null,     // last job id whose completion we have toasted
  lastPhase: null,
  knownBidders: new Set(), // commitments already in the registry (for print-in animation)
  pollTimer: null,
  clockTimer: null,
};

function short(hex, n = 8) {
  if (!hex) return '—';
  return hex.slice(0, n) + '…' + hex.slice(-4);
}

function fmtAmount(str) {
  try { return BigInt(str).toLocaleString('en-US'); } catch { return str; }
}

async function api(path, body) {
  const res = await fetch(path, body ? {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  } : undefined);
  return res.json();
}

let toastTimer = null;
function toast(message, isError = false) {
  const el = $('toast');
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 7000 : 5200);
}

async function act(body) {
  const res = await api('/api/action', body);
  if (res.error) toast(res.error, true);
  else poll(true);
  return res;
}

/* ─── Render ───────────────────────────────────────────────── */

function render() {
  const s = state.status;
  if (!s) return;

  // Boot veil
  const veil = $('veil');
  if (s.ready) {
    veil.classList.add('gone');
  } else if (s.bootError) {
    $('veil-title').textContent = 'Could not open the auction house';
    $('veil-text').textContent = s.bootError;
  }

  // Network chip
  $('net-dot').className = 'net-dot ' + (s.ready ? 'live' : s.bootError ? 'err' : '');
  $('net-label').textContent = s.ready ? `${s.network} · connected` : s.bootError ? 'error' : 'syncing wallet…';

  const v = s.view;
  const job = s.job;
  const jobActive = job && (job.stage === 'proving' || job.stage === 'queued');

  // Toast on job completion — but not for jobs that already finished before
  // this page load (the first poll adopts those silently).
  if (!state.initialized) {
    state.initialized = true;
    state.lastJobId = job && !jobActive ? job.id : 0;
  } else if (job && !jobActive && job.id !== state.lastJobId) {
    state.lastJobId = job.id;
    if (job.message) {
      const failed = job.ok === false;
      toast(failed ? `${job.label} — ${job.message}` : job.message, failed);
    }
  }

  // Job progress strip
  $('job').hidden = !jobActive;
  if (jobActive) {
    $('job-label').textContent = job.label;
    $('job-stage').textContent = job.kind === 'new-auction'
      ? 'Deploying the auction contract to the devnet…'
      : 'Generating a zero-knowledge proof on this machine — usually 30–60 seconds…';
  }

  // Paddles
  const row = $('paddle-row');
  const names = s.identities.length ? s.identities : [s.identity.name];
  const wanted = names.join('|') + '::' + s.identity.name + '::' + (jobActive ? 'busy' : 'idle');
  if (row.dataset.state !== wanted) {
    row.dataset.state = wanted;
    row.innerHTML = '';
    for (const name of names) {
      const b = document.createElement('button');
      b.className = 'paddle' + (name === s.identity.name ? ' is-active' : '');
      b.textContent = name;
      b.disabled = jobActive;
      b.addEventListener('click', () => act({ type: 'switch', name }));
      row.appendChild(b);
    }
  }

  if (!v) return;

  // Lot + phase
  $('lot-title').textContent = '“' + v.item + '”';
  document.querySelectorAll('#phase-rail li').forEach((li) => {
    const order = { open: 0, reveal: 1, closed: 2 };
    const mine = order[li.dataset.phase];
    const cur = order[v.phase];
    li.classList.toggle('is-current', mine === cur);
    li.classList.toggle('is-past', mine < cur);
  });
  $('fact-phase').textContent = { open: 'Bidding open', reveal: 'Reveals', closed: 'Gavel down' }[v.phase];

  // Registry
  $('contract-short').textContent = short(s.contractAddress, 10);
  $('fact-seller').textContent = short(v.owner);
  $('fact-highest').textContent = v.highestBid !== '0' ? fmtAmount(v.highestBid) : '—';
  $('fact-winner').textContent = v.winner ? short(v.winner) : '—';

  const body = $('registry-body');
  const sig = v.bids.map((b) => b.commitment).join(',') + '::' + s.contractAddress;
  if (body.dataset.state !== sig) {
    const isNewContract = body.dataset.contract !== s.contractAddress;
    if (isNewContract) state.knownBidders = new Set();
    body.dataset.state = sig;
    body.dataset.contract = s.contractAddress;
    body.innerHTML = '';
    v.bids.forEach((b, i) => {
      const tr = document.createElement('tr');
      if (!state.knownBidders.has(b.commitment) && !isNewContract) tr.className = 'printing';
      state.knownBidders.add(b.commitment);
      tr.innerHTML = `<td class="num">${i + 1}</td>` +
        `<td class="mono">${short(b.bidderId)}</td>` +
        `<td class="mono">${short(b.commitment, 12)}</td>`;
      body.appendChild(tr);
    });
  }
  $('registry-empty').hidden = v.bids.length > 0;

  // Sold stamp
  const sold = v.phase === 'closed' && v.winner;
  $('sold-stamp').hidden = !sold;
  if (sold) $('sold-price').textContent = fmtAmount(v.highestBid) + ' to ' + short(v.winner, 6);

  // Envelope vs bid form
  const myBid = s.identity.bid;
  const bidFormVisible = !myBid && v.phase === 'open';
  $('envelope-panel').hidden = !bidFormVisible && !myBid && !(v.phase === 'closed' && v.isWinner);
  $('bid-form').hidden = !bidFormVisible;
  $('bid-button').disabled = jobActive || !s.ready;
  const env = $('envelope');
  if (myBid) {
    $('envelope-amount').textContent = fmtAmount(myBid.amount);
    if (env.hidden) {
      env.hidden = false;
      requestAnimationFrame(() => env.classList.add('sealed'));
    }
  } else {
    env.hidden = true;
    env.classList.remove('sealed');
  }

  // Outcome card (closed phase)
  const outcome = $('outcome');
  if (v.phase === 'closed') {
    outcome.hidden = false;
    if (v.isWinner) {
      outcome.className = 'outcome won';
      outcome.textContent = `Your paddle won at ${fmtAmount(v.highestBid)}. The price is public — settlement needs it.`;
    } else if (myBid) {
      outcome.className = 'outcome sealed-forever';
      outcome.textContent = 'You did not win — and your amount stays sealed forever. Nobody, including the seller, will ever learn it from the chain.';
    } else {
      outcome.hidden = true;
    }
  } else {
    outcome.hidden = true;
  }

  // Action buttons
  const revealBtn = $('reveal-button');
  const closeBtn = $('close-button');
  const finalBtn = $('finalize-button');
  const revealable = v.phase === 'reveal' && myBid && v.hasMyBid;
  revealBtn.hidden = !revealable;
  closeBtn.hidden = !(v.phase === 'open' && v.isSeller);
  finalBtn.hidden = !(v.phase === 'reveal' && v.isSeller);
  [revealBtn, closeBtn, finalBtn].forEach((b) => { b.disabled = jobActive; });

  const emptyMsg = $('actions-empty');
  if (jobActive) {
    emptyMsg.hidden = true;
  } else if (revealBtn.hidden && closeBtn.hidden && finalBtn.hidden) {
    emptyMsg.hidden = false;
    if (v.phase === 'open') {
      emptyMsg.textContent = bidFormVisible
        ? 'Place a bid above, or switch paddles. The seller closes bidding when ready.'
        : 'Your bid is sealed. Waiting for the seller to close bidding.';
    } else if (v.phase === 'reveal') {
      emptyMsg.textContent = myBid
        ? (v.hasMyBid ? '' : 'This paddle’s bid is on a different auction.')
        : 'Nothing to reveal from this paddle. Switch paddles to reveal their bids.';
      if (!emptyMsg.textContent) emptyMsg.hidden = true;
    } else {
      emptyMsg.textContent = 'This auction has ended. Open a new one below.';
    }
  } else {
    emptyMsg.hidden = true;
  }
}

/* ─── Polling ──────────────────────────────────────────────── */

async function poll(immediate = false) {
  try {
    state.status = await api('/api/status');
    render();
  } catch {
    $('net-dot').className = 'net-dot err';
    $('net-label').textContent = 'server unreachable';
  }
  clearTimeout(state.pollTimer);
  const job = state.status && state.status.job;
  const busy = job && (job.stage === 'proving' || job.stage === 'queued');
  const readyYet = state.status && state.status.ready;
  state.pollTimer = setTimeout(poll, busy || !readyYet ? 1200 : (immediate ? 1200 : 3000));
}

// Elapsed clock for the active job
setInterval(() => {
  const job = state.status && state.status.job;
  if (job && (job.stage === 'proving' || job.stage === 'queued')) {
    $('job-clock').textContent = Math.max(0, Math.round((Date.now() - job.startedAt) / 1000)) + 's';
  }
}, 500);

/* ─── Forms ────────────────────────────────────────────────── */

$('bid-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('bid-input');
  const amount = input.value.trim();
  if (!amount) return;
  act({ type: 'bid', amount }).then((res) => { if (!res.error) input.value = ''; });
});

$('paddle-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('paddle-input');
  const name = input.value.trim();
  if (!name) return;
  act({ type: 'switch', name }).then((res) => { if (!res.error) input.value = ''; });
});

$('auction-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('auction-input');
  const item = input.value.trim();
  if (!item) return;
  act({ type: 'new-auction', item }).then((res) => { if (!res.error) input.value = ''; });
});

$('reveal-button').addEventListener('click', () => act({ type: 'reveal' }));
$('close-button').addEventListener('click', () => act({ type: 'close' }));
$('finalize-button').addEventListener('click', () => act({ type: 'finalize' }));

poll();
