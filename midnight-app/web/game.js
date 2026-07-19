/* The Number Game — frontend. Same pattern as app.js: poll, update in place. */

const $ = (id) => document.getElementById(id);

const state = {
  status: null,
  initialized: false,
  lastJobId: null,
  drawnGuesses: '',   // signature of what the histogram currently shows
  pollTimer: null,
};

function short(hex, n = 8) {
  if (!hex) return '—';
  return hex.slice(0, n) + '…' + hex.slice(-4);
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

function displayName(view, id) {
  return (view.names && view.names[id]) || short(id, 6);
}

function drawHistogram(view) {
  const sig = view.guesses.map((g) => g.id + ':' + g.guess).join(',') +
    '|' + (view.phase !== 'sealing' && view.phase !== 'reveal' ? view.target : '-') +
    '|' + (view.champion || '');
  if (state.drawnGuesses === sig) return;
  state.drawnGuesses = sig;

  const histo = $('histo');
  histo.innerHTML = '';

  // Stack duplicate/near values vertically so dots never overlap.
  const stacks = {};
  let prevGuess = -100;
  let raised = false;
  for (const g of [...view.guesses].sort((a, b) => a.guess - b.guess)) {
    const bucket = Math.round(g.guess / 3);
    stacks[bucket] = (stacks[bucket] || 0) + 1;
    // Alternate label height when guesses sit close together, so names
    // (orpheus at 21, henry at 23) never collide.
    raised = g.guess - prevGuess < 9 ? !raised : false;
    prevGuess = g.guess;
    const dot = document.createElement('div');
    dot.className = 'h-dot' + (view.champion === g.id ? ' champ' : '');
    dot.style.left = g.guess + '%';
    dot.style.bottom = 8 + (stacks[bucket] - 1) * 20 + 'px';
    const name = document.createElement('span');
    name.className = 'h-name' + (raised ? ' up' : '');
    name.textContent = displayName(view, g.id);
    const val = document.createElement('span');
    val.className = 'h-val' + (raised ? ' down' : '');
    val.textContent = g.guess;
    dot.appendChild(name);
    dot.appendChild(val);
    histo.appendChild(dot);
  }

  if (view.phase === 'reckoning' || view.phase === 'closed') {
    const t = document.createElement('div');
    t.className = 'h-target';
    t.style.left = view.target + '%';
    const label = document.createElement('span');
    label.className = 't-label';
    label.textContent = (view.mode === 'oracle' ? 'outcome = ' : '⅔·mean = ') + view.target;
    t.appendChild(label);
    histo.appendChild(t);
  }
}

function render() {
  const s = state.status;
  if (!s) return;

  $('net-dot').className = 'net-dot ' + (s.ready ? 'live' : s.bootError ? 'err' : '');
  $('net-label').textContent = s.ready ? `${s.network} · connected` : s.bootError ? 'error' : 'syncing wallet…';

  const v = s.view;
  const job = s.job;
  const jobActive = job && (job.stage === 'proving' || job.stage === 'queued');

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

  $('job').hidden = !jobActive;
  if (jobActive) {
    $('job-label').textContent = job.label;
    $('job-stage').textContent = job.kind === 'game-new'
      ? 'Deploying the game contract to the devnet…'
      : 'Generating a zero-knowledge proof on this machine — usually 30–60 seconds…';
  }

  $('no-game-panel').hidden = Boolean(s.gameAddress);
  $('play-panel').hidden = !s.gameAddress;

  if (!v) {
    if (s.gameAddress) $('game-contract').textContent = short(s.gameAddress, 10);
    return;
  }

  $('game-question').textContent = '“' + v.question + '”';
  $('game-contract').textContent = short(s.gameAddress, 10);
  $('play-as').textContent = '— playing as ' + s.identity.name;

  document.querySelectorAll('#phase-rail li').forEach((li) => {
    const order = { sealing: 0, reveal: 1, reckoning: 2, closed: 3 };
    const mine = order[li.dataset.phase];
    const cur = order[v.phase];
    li.classList.toggle('is-current', mine === cur);
    li.classList.toggle('is-past', mine < cur);
  });

  // Your number
  const canSeal = v.phase === 'sealing' && !v.hasSealed;
  $('guess-form').hidden = !canSeal;
  $('guess-button').disabled = jobActive;
  const sealedBox = $('sealed-number');
  if (s.identity.guess !== null && v.hasSealed) {
    sealedBox.hidden = false;
    $('sealed-value').textContent = s.identity.guess;
    $('sealed-cap').textContent = v.hasRevealed
      ? 'Revealed — it’s on the record now.'
      : v.phase === 'sealing'
        ? 'Sealed — visible only to you.'
        : 'Sealed. Reveal it before the reckoning or it forfeits.';
  } else {
    sealedBox.hidden = true;
  }

  // Actions
  const revealBtn = $('reveal-guess-button');
  revealBtn.hidden = !(v.phase === 'reveal' && v.hasSealed && !v.hasRevealed);
  $('close-sealing-button').hidden = !(v.phase === 'sealing' && v.isHost && v.entryCount > 0);
  const canReckon = v.phase === 'reveal' && v.isHost && v.revealedCount > 0;
  const manualOracle = v.mode === 'oracle' && !(v.question || '').includes('BTC trade above');
  $('reckon-button').hidden = !canReckon || manualOracle;
  $('resolve-yes-button').hidden = !(canReckon && manualOracle);
  $('resolve-no-button').hidden = !(canReckon && manualOracle);
  $('finalize-game-button').hidden = !(v.phase === 'reckoning' && v.isHost);
  ['reveal-guess-button', 'close-sealing-button', 'reckon-button', 'finalize-game-button', 'resolve-yes-button', 'resolve-no-button']
    .forEach((id) => { $(id).disabled = jobActive; });

  // Seats at the table — visible from the moment a commitment lands.
  const revealedIds = new Set(v.guesses.map((g) => g.id));
  const seatsSig = v.entries.map((e) => e.id).join(',') + '|' + [...revealedIds].join(',');
  const seats = $('seats');
  if (seats.dataset.state !== seatsSig) {
    seats.dataset.state = seatsSig;
    seats.innerHTML = '';
    if (v.entries.length === 0) {
      seats.innerHTML = '<span class="seats-empty">Empty — numbers appear here the moment they are sealed.</span>';
    }
    for (const e of v.entries) {
      const seat = document.createElement('span');
      const revealed = revealedIds.has(e.id);
      const you = e.id === s.identity.onChainId;
      seat.className = 'seat' + (revealed ? ' revealed' : '') + (you ? ' you' : '');
      seat.title = revealed ? 'revealed' : 'sealed — commitment ' + e.commitment;
      seat.innerHTML = '<span class="seat-wax"></span>' + displayName(v, e.id) + (you ? ' (you)' : '') +
        ' <span class="seat-commit">' + (revealed ? 'revealed' : e.commitment.slice(0, 8) + '…') + '</span>';
      seats.appendChild(seat);
    }
  }

  // Public record
  drawHistogram(v);
  $('histo-empty').hidden = v.guesses.length > 0;
  $('sealed-count').textContent = v.entryCount;
  $('g-phase').textContent = { sealing: 'Sealing', reveal: 'Reveals', reckoning: 'Reckoning', closed: 'Gavel down' }[v.phase];
  $('g-counts').textContent = `${v.entryCount} / ${v.revealedCount}`;
  $('g-target').textContent = (v.phase === 'reckoning' || v.phase === 'closed') ? v.target : 'sealed until the reckoning';
  $('g-champion').textContent = v.champion ? displayName(v, v.champion) : '—';

  const note = $('champion-note');
  if (v.champion) {
    note.hidden = false;
    const who = displayName(v, v.champion);
    const yours = v.isChampion ? ' — that’s you.' : '';
    note.innerHTML = `${who} takes it, ${v.bestDistance} away from the target${yours}`;
  } else {
    note.hidden = true;
  }
}

async function poll(immediate = false) {
  try {
    state.status = await api('/api/game-status');
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

setInterval(() => {
  const job = state.status && state.status.job;
  if (job && (job.stage === 'proving' || job.stage === 'queued')) {
    $('job-clock').textContent = Math.max(0, Math.round((Date.now() - job.startedAt) / 1000)) + 's';
  }
}, 500);

$('guess-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('guess-input');
  const guess = input.value.trim();
  if (!guess) return;
  act({ type: 'game-seal', guess }).then((res) => { if (!res.error) input.value = ''; });
});
const CATALOG = [
  { section: 'Trending', events: [
    { q: 'Will BTC trade above its live price at resolution?', sub: 'Threshold fixed from live research · auto-resolved by the oracle agent', auto: true },
    { q: 'Will the Fed cut rates at the September FOMC?', sub: 'Economy · resolves on the FOMC statement' },
    { q: 'Will OpenAI release GPT-6 before 2027?', sub: 'Tech & AI · resolves on official announcement' },
    { q: 'Government shutdown before October?', sub: 'Politics · resolves on appropriations lapse' },
  ]},
  { section: 'Politics', events: [
    { q: 'Will Democrats win the 2028 presidential election?', sub: 'Resolves on certified result' },
    { q: 'Will JD Vance win the 2028 Republican nomination?', sub: 'Resolves at the RNC' },
    { q: 'Will Newsom win the 2028 Democratic nomination?', sub: 'Resolves at the DNC' },
    { q: 'New UK prime minister before 2027?', sub: 'Resolves on a change of PM' },
    { q: 'Will the US strike a new China trade deal this year?', sub: 'Resolves on signed agreement' },
  ]},
  { section: 'Crypto', events: [
    { q: 'Will Bitcoin hit $100k in 2026?', sub: 'Resolves on any venue print' },
    { q: 'Will Solana flip $300 this year?', sub: 'Resolves on daily close' },
    { q: 'Will a US spot-Solana ETF be approved this year?', sub: 'Resolves on SEC approval' },
    { q: 'Will Midnight NIGHT list on a top-5 exchange in 2026?', sub: 'Resolves on listing announcement' },
    { q: 'New all-time high for total crypto market cap this year?', sub: 'Resolves on aggregate cap' },
  ]},
  { section: 'Economy', events: [
    { q: 'US recession declared in 2026?', sub: 'Resolves on NBER dating' },
    { q: 'Will inflation print above 3% in December?', sub: 'Resolves on CPI release' },
    { q: 'Will the S&P 500 close the year above 7,000?', sub: 'Resolves on Dec 31 close' },
    { q: 'Gold above $3,500/oz at year end?', sub: 'Resolves on spot close' },
  ]},
  { section: 'Tech & AI', events: [
    { q: 'Will Apple announce AR glasses in 2026?', sub: 'Resolves on official launch' },
    { q: 'Will an AI system win a gold-medal IMO score this year?', sub: 'Resolves on verified result' },
    { q: 'SpaceX Starship reaches orbit with crew before 2027?', sub: 'Resolves on crewed orbital flight' },
    { q: 'Will Waymo operate in 20+ US cities by year end?', sub: 'Resolves on public service map' },
  ]},
  { section: 'Sports & Culture', events: [
    { q: 'Will the Chiefs win Super Bowl LXI?', sub: 'Resolves on the final' },
    { q: 'Real Madrid to win the 2026-27 Champions League?', sub: 'Resolves on the final' },
    { q: 'Will Taylor Swift announce a 2027 world tour?', sub: 'Resolves on official announcement' },
    { q: 'Will GTA VI ship in 2026?', sub: 'Resolves on retail release' },
  ]},
];
const board = $('events-board');
if (board) {
  for (const sec of CATALOG) {
    const h = document.createElement('p');
    h.className = 'step-label';
    h.style.cssText = 'font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:var(--lamplight);margin:18px 0 10px;grid-column:1/-1';
    h.textContent = sec.section;
    board.appendChild(h);
    for (const ev of sec.events) {
      const node = document.getElementById('event-card-tpl').content.firstElementChild.cloneNode(true);
      node.querySelector('.ev-q').textContent = ev.q;
      node.querySelector('.ev-sub').textContent = ev.sub + (ev.auto ? '' : ' · host resolves YES/NO');
      node.addEventListener('click', () =>
        act(ev.auto ? { type: 'game-new', market: true } : { type: 'game-new', market: true, question: ev.q }));
      board.appendChild(node);
    }
  }
}
const agentForm = $('agent-form');
if (agentForm) {
  agentForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('agent-input').value.trim();
    if (!name) return;
    act({ type: 'game-add-agent', name }).then((r) => {
      if (!r.error) { $('agent-input').value = ''; toast('Your agent joined. It trades on its own from here.'); }
    });
  });
}
$('resolve-yes-button')?.addEventListener('click', () => act({ type: 'game-reckon', outcome: 100 }));
$('resolve-no-button')?.addEventListener('click', () => act({ type: 'game-reckon', outcome: 1 }));
$('reveal-guess-button').addEventListener('click', () => act({ type: 'game-reveal' }));
$('close-sealing-button').addEventListener('click', () => act({ type: 'game-close' }));
$('reckon-button').addEventListener('click', () => act({ type: 'game-reckon' }));
$('finalize-game-button').addEventListener('click', () => act({ type: 'game-finalize' }));

poll();
