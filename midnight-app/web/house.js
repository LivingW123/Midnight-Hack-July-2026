/* The Auction House — frontend for the five sealed mechanisms.
   Same shape as app.js: poll /api/status-style JSON, update the DOM in place,
   no framework. Format-specific chrome is shown/hidden rather than rebuilt, so
   transitions stay smooth while an auction changes phase. */

const $ = (id) => document.getElementById(id);

const state = {
  status: null,
  intel: null,
  initialized: false,
  lastJobId: null,
  knownBidders: new Set(),
  lastPrice: null,
  chosenFormat: 'dutch',
  pollTimer: null,
};

const short = (hex, n = 8) => (hex ? hex.slice(0, n) + '…' + hex.slice(-4) : '—');
const fmt = (v) => { try { return BigInt(v).toLocaleString('en-US'); } catch { return v; } };

/** Prefer a local paddle name; fall back to the pseudonym an outsider would see. */
const nameOf = (id, names) => (names && names[id]) || short(id);

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
  el.classList.remove('toast-in');
  void el.offsetWidth; // restart the entrance animation
  el.classList.add('toast-in');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 7000 : 5200);
}

async function act(body) {
  const res = await api('/api/action', body);
  if (res.error) toast(res.error, true);
  else poll(true);
  return res;
}

/* ─── Format rack ───────────────────────────────────────────── */

function renderFormats(formats, activeFormat) {
  const rack = $('format-rack');
  if (rack.dataset.built !== 'yes') {
    rack.dataset.built = 'yes';
    rack.innerHTML = '';
    formats.forEach((f, i) => {
      const card = document.createElement('article');
      card.className = 'format-card';
      card.dataset.format = f.name;
      card.style.setProperty('--stagger', `${i * 60}ms`);
      card.innerHTML =
        `<h3>${f.title}</h3><p class="format-blurb">${f.blurb}</p>` +
        `<p class="format-privacy"><span class="shield" aria-hidden="true"></span>${f.privacy}</p>`;
      rack.appendChild(card);
    });
    // Also fill the picker inside the "open a new auction" form.
    const choice = $('format-choice');
    choice.innerHTML = '';
    formats.forEach((f) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'format-pill' + (f.name === state.chosenFormat ? ' is-chosen' : '');
      b.textContent = f.title;
      b.dataset.format = f.name;
      b.addEventListener('click', () => {
        state.chosenFormat = f.name;
        choice.querySelectorAll('.format-pill').forEach((p) =>
          p.classList.toggle('is-chosen', p.dataset.format === f.name));
        syncParamPanels();
      });
      choice.appendChild(b);
    });
    syncParamPanels();
  }
  rack.querySelectorAll('.format-card').forEach((c) =>
    c.classList.toggle('is-live', c.dataset.format === activeFormat));
}

function syncParamPanels() {
  const f = state.chosenFormat;
  $('params-dutch').hidden = f !== 'dutch';
  $('params-batch').hidden = f !== 'batch';
  const needsSchedule = f === 'candle' || f === 'timelock';
  $('params-schedule').hidden = !needsSchedule;
  if (needsSchedule) {
    const candle = f === 'candle';
    $('schedule-label').textContent = candle ? 'Secret end-index' : 'Unlock tick';
    $('schedule-help').textContent = candle
      ? 'Bids arriving after this index never counted. Committed now — you cannot move it once bids land.'
      : 'Reveals stay shut until the public clock passes this tick. Committed now, opened later.';
  }
}

/* ─── Render ────────────────────────────────────────────────── */

function render() {
  const s = state.status;
  if (!s) return;

  const veil = $('veil');
  if (s.ready) veil.classList.add('gone');
  else if (s.bootError) {
    $('veil-title').textContent = 'Could not open the auction house';
    $('veil-text').textContent = s.bootError;
  }

  $('net-dot').className = 'net-dot ' + (s.ready ? 'live' : s.bootError ? 'err' : '');
  $('net-label').textContent = s.ready ? `${s.network} · connected` : s.bootError ? 'error' : 'syncing wallet…';

  const v = s.view;
  const job = s.job;
  const busy = job && (job.stage === 'proving' || job.stage === 'queued');

  renderFormats(s.formats, v ? v.format : null);

  if (!state.initialized) {
    state.initialized = true;
    state.lastJobId = job && !busy ? job.id : 0;
  } else if (job && !busy && job.id !== state.lastJobId) {
    state.lastJobId = job.id;
    if (job.message) toast(job.ok === false ? `${job.label} — ${job.message}` : job.message, job.ok === false);
  }

  $('job').hidden = !busy;
  if (busy) {
    $('job-label').textContent = job.label;
    $('job-stage').textContent = job.kind === 'house-new'
      ? 'Deploying the auction contract to the devnet…'
      : 'Generating a zero-knowledge proof on this machine — usually 30–60 seconds…';
  }

  // Paddles
  const row = $('paddle-row');
  const names = s.identities.length ? s.identities : [s.identity.name];
  const wanted = names.join('|') + '::' + s.identity.name + '::' + (busy ? 'busy' : 'idle');
  if (row.dataset.state !== wanted) {
    row.dataset.state = wanted;
    row.innerHTML = '';
    for (const name of names) {
      const b = document.createElement('button');
      b.className = 'paddle' + (name === s.identity.name ? ' is-active' : '');
      b.textContent = name;
      b.disabled = busy;
      b.addEventListener('click', () => act({ type: 'switch', name }));
      row.appendChild(b);
    }
  }

  if (!v) {
    $('lot-title').textContent = 'No auction open';
    $('format-eyebrow').textContent = 'Pick a mechanism below and open one';
    $('new-auction').open = true;
    return;
  }

  const meta = s.formats.find((f) => f.name === v.format) || {};
  $('format-eyebrow').textContent = meta.title || v.format;
  $('lot-title').textContent = '“' + v.item + '”';
  $('lot-privacy').textContent = meta.privacy || '';

  const order = { open: 0, reveal: 1, closed: 2 };
  document.querySelectorAll('#phase-rail li').forEach((li) => {
    li.classList.toggle('is-current', order[li.dataset.phase] === order[v.phase]);
    li.classList.toggle('is-past', order[li.dataset.phase] < order[v.phase]);
  });
  $('fact-phase').textContent = { open: 'Bidding open', reveal: 'Reveals', closed: 'Gavel down' }[v.phase];

  renderDutch(v);
  renderRegistry(s, v);
  renderLadder(v);
  renderBundles(v);
  renderBidPanel(s, v);
  renderActions(s, v, busy);

  $('contract-short').textContent = short(s.houseAddress, 10);
  $('fact-seller').textContent = nameOf(v.owner, v.names);
  $('fact-winner').textContent = v.winner ? nameOf(v.winner, v.names) : '—';

  const priceLabel = { dutch: 'Cleared at', batch: 'Clearing price', combinatorial: 'Allocation value' }[v.format]
    || 'Highest revealed';
  $('fact-price-label').textContent = priceLabel;
  const priceValue = v.format === 'combinatorial' ? v.allocationValue
    : v.format === 'batch' && v.clearingLocked ? v.clearingPrice
    : v.highestBid;
  $('fact-highest').textContent = priceValue !== '0' ? fmt(priceValue) : '—';

  const sold = v.phase === 'closed' && v.winner;
  $('sold-stamp').hidden = !sold;
  if (sold) $('sold-price').textContent = fmt(priceValue) + ' to ' + nameOf(v.winner, v.names);

  $('record-footnote').textContent = meta.privacy
    ? `Commitments are hiding and binding. ${meta.privacy}`
    : 'Commitments are hiding and binding.';
}

function renderDutch(v) {
  const isDutch = v.format === 'dutch';
  $('dutch-panel').hidden = !isDutch;
  if (!isDutch) return;

  const price = $('clock-price');
  price.textContent = fmt(v.currentPrice);
  $('clock-floor').textContent = fmt(v.floorPrice);

  // Pulse the clock only when the price actually moved.
  if (state.lastPrice !== null && state.lastPrice !== v.currentPrice) {
    price.classList.remove('ticked');
    void price.offsetWidth;
    price.classList.add('ticked');
  }
  state.lastPrice = v.currentPrice;

  // Fill bar: how far the clock has descended toward the floor.
  const start = Number(v.currentPrice) + Number(v.tickCount) * Number(v.priceStep);
  const floor = Number(v.floorPrice);
  const span = Math.max(start - floor, 1);
  const done = Math.max(0, Math.min(1, (start - Number(v.currentPrice)) / span));
  $('clock-fill').style.width = `${done * 100}%`;
}

function renderRegistry(s, v) {
  const body = $('registry-body');
  const sig = v.bids.map((b) => b.commitment).join(',') + '::' + s.houseAddress;
  if (body.dataset.state !== sig) {
    const isNew = body.dataset.contract !== s.houseAddress;
    if (isNew) state.knownBidders = new Set();
    body.dataset.state = sig;
    body.dataset.contract = s.houseAddress;
    body.innerHTML = '';
    v.bids.forEach((b, i) => {
      const tr = document.createElement('tr');
      if (!state.knownBidders.has(b.commitment) && !isNew) tr.className = 'printing';
      state.knownBidders.add(b.commitment);
      tr.innerHTML = `<td class="num">${i + 1}</td>` +
        `<td class="mono">${nameOf(b.bidderId, v.names)}</td>` +
        `<td class="mono">${short(b.commitment, 12)}</td>`;
      body.appendChild(tr);
    });
  }
  $('registry-empty').hidden = v.bids.length > 0;
  $('record-kicker').textContent = v.format === 'dutch'
    ? 'Registry of sealed reservations' : 'Registry of sealed tenders';
}

function renderLadder(v) {
  const wrap = $('ladder');
  wrap.hidden = v.format !== 'batch' || v.slots.length === 0;
  if (wrap.hidden) return;
  const rows = $('ladder-rows');
  const sig = v.slots.map((s) => `${s.rank}:${s.price}:${s.winner}`).join('|') + v.clearingPrice;
  if (rows.dataset.state === sig) return;
  rows.dataset.state = sig;
  rows.innerHTML = '';
  v.slots.forEach((slot, i) => {
    const li = document.createElement('li');
    const winning = i < v.supply;
    li.className = 'ladder-row' + (winning ? ' is-winning' : '');
    li.style.setProperty('--stagger', `${i * 80}ms`);
    li.innerHTML = `<span class="mono">${nameOf(slot.winner, v.names)}</span>` +
      `<span class="ladder-price">${fmt(slot.price)}</span>`;
    rows.appendChild(li);
  });
  const cl = $('clearing');
  cl.hidden = !v.clearingLocked;
  if (v.clearingLocked) {
    cl.textContent = `All ${Math.min(v.filledSlots, v.supply)} winners pay ${fmt(v.clearingPrice)} — the lowest winning bid. Nothing to gain by sniping.`;
  }
}

function renderBundles(v) {
  const wrap = $('bundles');
  wrap.hidden = v.format !== 'combinatorial' || v.bundles.length === 0;
  if (wrap.hidden) return;
  const rows = $('bundle-rows');
  const sig = v.bundles.map((b) => `${b.mask}:${b.best}`).join('|') + v.allocation.join(',');
  if (rows.dataset.state === sig) return;
  rows.dataset.state = sig;
  rows.innerHTML = '';
  v.bundles.forEach((b, i) => {
    const won = v.allocation.includes(b.mask);
    const el = document.createElement('div');
    el.className = 'bundle-row' + (won ? ' is-allocated' : '');
    el.style.setProperty('--stagger', `${i * 70}ms`);
    el.innerHTML = `<span class="bundle-mask">${b.label}</span>` +
      `<span class="bundle-best">${fmt(b.best)}</span>` +
      `<span class="mono bundle-who">${nameOf(b.winner, v.names)}</span>`;
    rows.appendChild(el);
  });
  const al = $('allocation');
  al.hidden = !v.allocationLocked;
  if (v.allocationLocked) {
    al.textContent = `Optimal allocation: ${v.allocationLabels.join(' + ')} at ${fmt(v.allocationValue)} — proven against all five partitions of the three lots, in-circuit.`;
  }
}

function renderBidPanel(s, v) {
  const myBid = s.identity.bid;
  const canBid = !myBid && v.phase === 'open';
  $('envelope-panel').hidden = !canBid && !myBid;
  $('bid-form').hidden = !canBid;
  $('bid-button').disabled = !s.ready;
  $('bundle-picker').hidden = v.format !== 'combinatorial';

  const dutch = v.format === 'dutch';
  $('bid-panel-title').textContent = dutch ? 'Your sealed reservation' : 'Your sealed bid';
  $('bid-label').textContent = dutch ? 'Highest price you would pay' : 'Amount';
  $('bid-help').textContent = dutch
    ? 'Sealed. When the clock reaches a price you accept, you prove it clears — without revealing this number.'
    : 'Sealed with a one-time nonce. Only the commitment leaves this machine.';

  const env = $('envelope');
  if (myBid) {
    $('envelope-amount').textContent = fmt(myBid.amount);
    $('envelope-note').textContent = dutch
      ? 'Your reservation — visible only to you, even if you win'
      : 'Amount & nonce — visible only to you';
    if (env.hidden) {
      env.hidden = false;
      requestAnimationFrame(() => env.classList.add('sealed'));
    }
  } else {
    env.hidden = true;
    env.classList.remove('sealed');
  }

  const outcome = $('outcome');
  outcome.hidden = true;
  if (v.phase === 'closed' && v.isWinner) {
    outcome.hidden = false;
    outcome.className = 'outcome won';
    outcome.textContent = dutch
      ? `You took the lot at ${fmt(v.highestBid)} — the public clock price. What you were actually willing to pay never reached the chain.`
      : `Your paddle won at ${fmt(v.format === 'batch' ? v.clearingPrice : v.highestBid)}.`;
  } else if (v.phase === 'closed' && myBid) {
    outcome.hidden = false;
    outcome.className = 'outcome sealed-forever';
    outcome.textContent = 'You did not win — and your amount stays sealed forever.';
  }
}

function renderActions(s, v, busy) {
  const mine = s.identity.bid;
  const dutch = v.format === 'dutch';
  const needsSchedule = v.format === 'candle' || v.format === 'timelock';
  const settles = v.format === 'batch' || v.format === 'combinatorial';

  const claim = $('claim-button');
  const tick = $('tick-button');
  const reveal = $('reveal-button');
  const close = $('close-button');
  const schedule = $('schedule-button');
  const settle = $('settle-button');
  const finalize = $('finalize-button');

  claim.hidden = !(dutch && v.phase === 'open' && mine && v.hasMyBid);
  tick.hidden = !(v.phase === 'open' && (dutch || v.format === 'timelock'));
  close.hidden = !(v.phase === 'open' && v.isSeller && !dutch);
  schedule.hidden = !(needsSchedule && v.phase === 'reveal' && v.isSeller && !v.scheduleOpen);

  const revealBlocked = needsSchedule && !v.scheduleOpen;
  reveal.hidden = !(v.phase === 'reveal' && mine && v.hasMyBid && !revealBlocked && !settlesLocked(v));
  settle.hidden = !(settles && v.phase === 'reveal' && v.revealedCount > 0 && !settlesLocked(v));
  settle.textContent = v.format === 'batch' ? 'Lock the clearing price' : 'Prove the optimal allocation';
  finalize.hidden = !(v.phase === 'reveal' && v.isSeller);

  [claim, tick, reveal, close, schedule, settle, finalize].forEach((b) => { b.disabled = busy; });

  const empty = $('actions-empty');
  const anyVisible = [claim, tick, reveal, close, schedule, settle, finalize].some((b) => !b.hidden);
  empty.hidden = busy || anyVisible;
  if (!empty.hidden) {
    empty.textContent = v.phase === 'open'
      ? (mine ? 'Your bid is sealed. Waiting on the seller.' : 'Seal a bid above, or switch paddles.')
      : v.phase === 'reveal'
        ? (revealBlocked ? 'Reveals are shut until the seller opens the committed schedule.' : 'Nothing to reveal from this paddle.')
        : 'This auction has ended. Open a new one below.';
  }
}

const settlesLocked = (v) => (v.format === 'batch' && v.clearingLocked) || (v.format === 'combinatorial' && v.allocationLocked);

/* ─── Intelligence ──────────────────────────────────────────── */

function renderIntel() {
  const intel = state.intel;
  const names = state.status && state.status.view ? state.status.view.names : {};
  if (!intel) return;

  const rows = $('shill-rows');
  const findings = intel.findings || [];
  $('shill-empty').hidden = findings.length > 0;
  const sig = findings.map((f) => `${f.bidderId}:${f.risk}`).join('|');
  if (rows.dataset.state !== sig) {
    rows.dataset.state = sig;
    rows.innerHTML = '';
    findings.forEach((f, i) => {
      const el = document.createElement('div');
      el.className = `shill-row is-${f.band}`;
      el.style.setProperty('--stagger', `${i * 70}ms`);
      const signals = f.signals.length
        ? f.signals.map((sg) => `<li><span class="sig-name">${sg.name}</span> ${sg.evidence}</li>`).join('')
        : '<li class="sig-none">no signals fired</li>';
      el.innerHTML =
        `<div class="shill-head">
           <span class="mono shill-who">${f.paddle || nameOf(f.bidderId, names)}</span>
           <span class="shill-band">${f.band}</span>
           <span class="shill-risk"><span class="risk-fill" style="--risk:${f.risk}%"></span><em>${f.risk}</em></span>
         </div>
         <ul class="shill-signals">${signals}</ul>`;
      rows.appendChild(el);
    });
  }

  const a = intel.advice;
  $('advice').hidden = !a;
  $('advice-empty').hidden = !!a;
  if (a) {
    $('advice-action').textContent = a.action;
    $('advice-action').className = 'advice-action is-' + a.action;
    $('advice-conf').textContent = `confidence ${(a.confidence * 100).toFixed(0)}%`;
    $('advice-headline').textContent = a.headline;
    $('advice-suggest').hidden = !a.suggested;
    if (a.suggested) $('advice-suggest').textContent = `Suggested reserve: ${fmt(a.suggested)}`;
    $('advice-why').innerHTML = a.rationale.map((r) => `<li>${r}</li>`).join('');
  }
}

/* ─── Polling ───────────────────────────────────────────────── */

async function poll(immediate = false) {
  try {
    state.status = await api('/api/house-status');
    render();
    // First successful render — drop the skeleton shimmer.
    document.body.classList.remove('is-loading');
    if (state.status.ready && state.status.houseAddress) {
      state.intel = await api('/api/intel');
      renderIntel();
    }
  } catch {
    $('net-dot').className = 'net-dot err';
    $('net-label').textContent = 'server unreachable';
  }
  clearTimeout(state.pollTimer);
  const job = state.status && state.status.job;
  const busy = job && (job.stage === 'proving' || job.stage === 'queued');
  state.pollTimer = setTimeout(poll, busy || !(state.status && state.status.ready) ? 1200 : (immediate ? 1200 : 3500));
}

setInterval(() => {
  const job = state.status && state.status.job;
  if (job && (job.stage === 'proving' || job.stage === 'queued')) {
    $('job-clock').textContent = Math.max(0, Math.round((Date.now() - job.startedAt) / 1000)) + 's';
  }
}, 500);

/* ─── Forms ─────────────────────────────────────────────────── */

$('bid-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('bid-input');
  const amount = input.value.trim();
  if (!amount) return;
  let bundle = 0;
  if (!$('bundle-picker').hidden) {
    bundle = [...document.querySelectorAll('.lot-chip input:checked')]
      .reduce((acc, c) => acc + Number(c.value), 0);
    if (!bundle) return toast('Pick at least one lot for your bundle.', true);
  }
  act({ type: 'house-bid', amount, bundle: String(bundle) })
    .then((res) => { if (!res.error) input.value = ''; });
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
  const item = $('auction-input').value.trim();
  if (!item) return;
  act({
    type: 'house-new',
    item,
    format: state.chosenFormat,
    startPrice: $('p-start').value,
    floorPrice: $('p-floor').value,
    priceStep: $('p-step').value,
    supply: $('p-supply').value,
    scheduleTick: $('p-schedule').value,
  }).then((res) => { if (!res.error) $('auction-input').value = ''; });
});

$('claim-button').addEventListener('click', () => act({ type: 'house-claim' }));
$('tick-button').addEventListener('click', () => act({ type: 'house-tick' }));
$('reveal-button').addEventListener('click', () => act({ type: 'house-reveal' }));
$('close-button').addEventListener('click', () => act({ type: 'house-close' }));
$('schedule-button').addEventListener('click', () => act({ type: 'house-open-schedule' }));
$('settle-button').addEventListener('click', () => act({ type: 'house-settle' }));
$('finalize-button').addEventListener('click', () => act({ type: 'house-finalize' }));

poll();
