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
    label.textContent = '⅔·mean = ' + view.target;
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
  $('new-game-button').disabled = jobActive || !s.ready;

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
  $('reckon-button').hidden = !(v.phase === 'reveal' && v.isHost && v.revealedCount > 0);
  $('finalize-game-button').hidden = !(v.phase === 'reckoning' && v.isHost);
  ['reveal-guess-button', 'close-sealing-button', 'reckon-button', 'finalize-game-button']
    .forEach((id) => { $(id).disabled = jobActive; });

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
$('new-game-button').addEventListener('click', () => act({ type: 'game-new' }));
$('reveal-guess-button').addEventListener('click', () => act({ type: 'game-reveal' }));
$('close-sealing-button').addEventListener('click', () => act({ type: 'game-close' }));
$('reckon-button').addEventListener('click', () => act({ type: 'game-reckon' }));
$('finalize-game-button').addEventListener('click', () => act({ type: 'game-finalize' }));

poll();
