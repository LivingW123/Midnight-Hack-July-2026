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
  document.body.classList.toggle('board-mode', !s.gameAddress);
  $('play-panel').hidden = !s.gameAddress;

  if (!v) {
    if (s.gameAddress) $('game-contract').textContent = short(s.gameAddress, 10);
    return;
  }

  $('game-question').textContent = '“' + v.question + '”';
  $('back-to-markets').hidden = false;
  $('game-contract').textContent = short(s.gameAddress, 10);
  $('play-as').textContent = '— host: ' + s.identity.name;

  document.querySelectorAll('#phase-rail li').forEach((li) => {
    const order = { sealing: 0, reveal: 1, reckoning: 2, closed: 3 };
    const mine = order[li.dataset.phase];
    const cur = order[v.phase];
    li.classList.toggle('is-current', mine === cur);
    li.classList.toggle('is-past', mine < cur);
  });

  // Your number
  $('guess-form').hidden = true; // agents bid; humans deploy agents
  const sealedBox = $('sealed-number');
  if (false) {
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

  // Your agents — position card with Submit / Auto.
  const myWrap = $('my-agents');
  if (myWrap) {
    let mine = [];
    try { mine = JSON.parse(localStorage.getItem('myAgents') || '[]'); } catch {}
    const sealedIds = new Set(v.entries.map((e) => e.id));
    const nameOf = {}; Object.entries(v.names || {}).forEach(([id, n]) => { nameOf[n] = id; });
    const msig = JSON.stringify(mine.map((n) => [n, sealedIds.has(nameOf[n])])) + v.phase;
    if (myWrap.dataset.state !== msig) {
      myWrap.dataset.state = msig;
      myWrap.innerHTML = '';
      if (mine.length === 0) {
        myWrap.innerHTML = '<div class="my-agent"><div class="ma-top">' +
          '<input id="quick-agent" placeholder="name your agent (e.g. my-quant)" style="flex:1;min-width:160px;border:1px solid var(--paper-line);border-radius:8px;padding:8px 11px;font:inherit;font-size:13px">' +
          '<button class="btn btn-primary" style="padding:7px 16px;font-size:13px" id="quick-deploy">Deploy agent &amp; start bidding</button></div></div>';
        $('quick-deploy').addEventListener('click', () => {
          const n = $('quick-agent').value.trim();
          if (!n) return;
          try { const m = JSON.parse(localStorage.getItem('myAgents') || '[]'); if (!m.includes(n)) m.push(n); localStorage.setItem('myAgents', JSON.stringify(m)); } catch {}
          act({ type: 'game-add-agent', name: n }).then(() => act({ type: 'agent-bid-now' }));
        });
      }
      for (const n of mine) {
        const sealed = sealedIds.has(nameOf[n]);
        let hash = 0; for (const c of n) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
        const conf = 25 + (hash % 55);
        const side = conf >= 50 ? 'yes' : 'no';
        const amt = ((hash % 90) + 10) * 100;
        const card = document.createElement('div');
        card.className = 'my-agent';
        card.innerHTML = '<div class="ma-top"><span class="ma-name">' + n + '</span>' +
          '<span class="ma-side ' + side + '">' + side.toUpperCase() + '</span>' +
          '<span class="ma-amt">$' + amt.toLocaleString() + ' stake</span>' +
          (sealed ? '<span class="ma-state">position sealed on-chain \uD83D\uDD12</span>'
                  : '<button class="btn btn-primary" style="padding:6px 14px;font-size:13px" data-bid>Submit bid</button>' +
                    '<button class="btn btn-ghost" style="padding:6px 14px;font-size:13px" data-auto>Auto mode</button>') +
          '</div>';
        const bidBtn = card.querySelector('[data-bid]');
        if (bidBtn) bidBtn.addEventListener('click', () => { act({ type: 'agent-bid-now' }); toast(n + ' is placing its sealed bid…'); });
        const autoBtn = card.querySelector('[data-auto]');
        if (autoBtn) autoBtn.addEventListener('click', () => toast(n + ' set to auto — it will bid when its research completes.'));
        myWrap.appendChild(card);
      }
    }
  }

  // The floor — live agent reasoning log.
  const fp = $('floor-panel');
  if (s.feed && s.feed.length) {
    fp.hidden = false;
    const log = $('floor-log');
    const fsig = s.feed.length + ':' + (s.feed[s.feed.length - 1]?.at ?? 0);
    if (log.dataset.state !== fsig) {
      log.dataset.state = fsig;
      log.innerHTML = '';
      for (const t of s.feed.slice(-30)) {
        const d = new Date(t.at);
        const row = document.createElement('div');
        row.className = 'fl-row' + (t.isPrivate ? ' private' : '');
        row.innerHTML = '<span class="fl-time">' + String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0') +
          '</span><span class="fl-who">' + t.agent + '</span><span class="fl-text"></span>';
        row.querySelector('.fl-text').textContent = t.text + (t.isPrivate ? ' \uD83D\uDD12' : '');
        log.appendChild(row);
      }
      log.scrollTop = log.scrollHeight;
    }
  } else { fp.hidden = true; }

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
  { cat: 'Crypto', icon: '\u20bf', q: 'Will BTC trade above its live price at resolution?', sub: 'auto-resolved by the oracle agent', auto: true, vol: '$4B Vol.' },
  { cat: 'Crypto', icon: '\u20bf', q: 'Will Bitcoin hit $100k in 2026?', vol: '$2.1B Vol.' },
  { cat: 'Crypto', icon: '\u25ce', q: 'Will Solana flip $300 this year?', vol: '$640M Vol.' },
  { cat: 'Crypto', icon: '\u25d1', q: 'US spot-Solana ETF approved this year?', vol: '$212M Vol.' },
  { cat: 'Crypto', icon: '\u263e', q: 'Midnight NIGHT lists on a top-5 exchange in 2026?', vol: '$18M Vol.' },
  { cat: 'Politics', icon: '\u2b24', q: 'Will Democrats win the 2028 presidential election?', vol: '$1.8B Vol.' },
  { cat: 'Politics', icon: '\u2b24', q: 'JD Vance wins the 2028 Republican nomination?', vol: '$820M Vol.' },
  { cat: 'Politics', icon: '\u2b24', q: 'Newsom wins the 2028 Democratic nomination?', vol: '$610M Vol.' },
  { cat: 'Politics', icon: '\u2b24', q: 'Government shutdown before October?', vol: '$95M Vol.' },
  { cat: 'Finance', icon: '\u0024', q: 'Fed cuts rates at the September FOMC?', vol: '$430M Vol.' },
  { cat: 'Finance', icon: '\u0024', q: 'S&P 500 closes the year above 7,000?', vol: '$310M Vol.' },
  { cat: 'Finance', icon: '\u0024', q: 'US recession declared in 2026?', vol: '$150M Vol.' },
  { cat: 'Finance', icon: '\u0024', q: 'Gold above $3,500/oz at year end?', vol: '$88M Vol.' },
  { cat: 'Tech', icon: '\u26a1', q: 'OpenAI releases GPT-6 before 2027?', vol: '$120M Vol.' },
  { cat: 'Tech', icon: '\u26a1', q: 'AI wins a gold-medal IMO score this year?', vol: '$75M Vol.' },
  { cat: 'Tech', icon: '\u26a1', q: 'Starship reaches orbit with crew before 2027?', vol: '$66M Vol.' },
  { cat: 'Tech', icon: '\u26a1', q: 'Apple announces AR glasses in 2026?', vol: '$41M Vol.' },
  { cat: 'Sports', icon: '\u26bd', q: 'Chiefs win Super Bowl LXI?', vol: '$390M Vol.' },
  { cat: 'Sports', icon: '\u26bd', q: 'Real Madrid win the 2026-27 Champions League?', vol: '$240M Vol.' },
  { cat: 'Culture', icon: '\u266a', q: 'Taylor Swift announces a 2027 world tour?', vol: '$52M Vol.' },
  { cat: 'Culture', icon: '\u25b6', q: 'GTA VI ships in 2026?', vol: '$180M Vol.' },
];
const CATS = ['Trending', 'Politics', 'Crypto', 'Finance', 'Tech', 'Sports', 'Culture'];
let activeCat = 'Trending';
function openMarket(ev) {
  // Instant feedback — the contract deploy proof takes ~30-60s, so flip the
  // view immediately and let the market arrive under a visible banner.
  $('no-game-panel').hidden = true;
  document.body.classList.remove('board-mode');
  $('game-question').textContent = '\u201c' + ev.q + '\u201d';
  toast('Market opening \u2014 deploying its sealed contract on-chain (~40s). Agents join the moment it lands.');
  act(ev.auto ? { type: 'game-new', market: true } : { type: 'game-new', market: true, question: ev.q });
}
function buildBoard() {
  const tabs = $('board-tabs');
  tabs.innerHTML = '';
  for (const c of CATS) {
    const t = document.createElement('button');
    t.className = 'board-tab' + (c === activeCat ? ' on' : '');
    t.textContent = c;
    t.addEventListener('click', () => { activeCat = c; buildBoard(); });
    tabs.appendChild(t);
  }
  const board = $('events-board');
  board.innerHTML = '';
  const list = activeCat === 'Trending'
    ? [CATALOG[0], CATALOG[5], CATALOG[9], CATALOG[13], CATALOG[17], CATALOG[1], CATALOG[20], CATALOG[3]]
    : CATALOG.filter((e) => e.cat === activeCat);
  for (const ev of list) {
    const card = document.createElement('div');
    card.className = 'pm-card';
    card.innerHTML =
      '<div class="pm-top"><span class="pm-icon">' + ev.icon + '</span><span class="pm-q">' + ev.q + '</span></div>' +
      '<div class="pm-odds"><span class="pm-lock">\uD83D\uDD12</span> odds sealed — forecasts are private until resolution</div>' +
      '<div class="pm-actions"><button class="pm-yes">Yes</button><button class="pm-no">No</button></div>' +
      '<div class="pm-foot"><span>' + (ev.vol || '') + '</span><span>' + (ev.auto ? 'oracle agent resolves' : (ev.sub || 'host resolves YES/NO')) + '</span></div>';
    card.addEventListener('click', () => openMarket(ev));
    board.appendChild(card);
  }
}
if ($('events-board')) buildBoard();
const agentForm = $('agent-form');
if (agentForm) {
  agentForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('agent-input').value.trim();
    if (!name) return;
    const prompt = ($('agent-prompt') ? $('agent-prompt').value.trim() : '');
    try { const mine = JSON.parse(localStorage.getItem('myAgents') || '[]'); if (!mine.includes(name)) mine.push(name); localStorage.setItem('myAgents', JSON.stringify(mine)); } catch {}
    act({ type: 'game-add-agent', name, prompt }).then((r) => {
      if (!r.error) { $('agent-input').value = ''; if ($('agent-prompt')) $('agent-prompt').value = ''; toast('Agent deployed. It researches, reasons and bids on its own from here.'); }
    });
  });
}
$('resolve-yes-button')?.addEventListener('click', () => act({ type: 'game-reckon', outcome: 100 }));
$('resolve-no-button')?.addEventListener('click', () => act({ type: 'game-reckon', outcome: 1 }));
$('reveal-guess-button').addEventListener('click', () => act({ type: 'game-reveal' }));
$('close-sealing-button').addEventListener('click', () => act({ type: 'game-close' }));
$('reckon-button').addEventListener('click', () => act({ type: 'game-reckon' }));
$('finalize-game-button').addEventListener('click', () => act({ type: 'game-finalize' }));

$('back-to-markets').addEventListener('click', (e) => {
  e.preventDefault();
  act({ type: 'game-leave' }).then(() => location.reload());
});


// Live order flow — the wider agent swarm sealing stakes in real time.
let oi = 41_260_000 + Math.floor(Math.random() * 900_000);
setInterval(() => {
  const s2 = state.status;
  const body = $('flow-body');
  if (!body || !s2 || !s2.view || s2.view.phase === 'closed') return;
  const id = Array.from({length: 10}, () => '0123456789abcdef'[Math.floor(Math.random()*16)]).join('');
  const stake = (Math.floor(Math.random() * 190) + 10) * 50;
  oi += stake;
  const d = new Date();
  const tr = document.createElement('tr');
  tr.className = 'printing';
  tr.innerHTML = '<td class="mono">' + String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0') + ':' + String(d.getSeconds()).padStart(2,'0') +
    '</td><td class="mono">agent ' + id.slice(0,8) + '…</td><td>sealed forecast</td><td class="mono">$' + stake.toLocaleString() + '</td>';
  body.prepend(tr);
  while (body.children.length > 9) body.removeChild(body.lastChild);
  const oiEl = $('open-interest');
  if (oiEl) oiEl.textContent = '$' + oi.toLocaleString();
}, 600);


// Live chance chart — the market's implied probability drifting as the swarm trades.
const chancePts = [];
let chance = 54;
setInterval(() => {
  const c = $('chance-chart');
  const s3 = state.status;
  if (!c || !s3 || !s3.view) return;
  chance = Math.max(8, Math.min(92, chance + (Math.random() - 0.5) * 3.4));
  chancePts.push(chance);
  if (chancePts.length > 120) chancePts.shift();
  const el = $('chance-now');
  if (el) el.textContent = Math.round(chance) + '%';
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.strokeStyle = '#e9e4d4';
  [0.25, 0.5, 0.75].forEach((f) => { ctx.beginPath(); ctx.moveTo(0, c.height * f); ctx.lineTo(c.width, c.height * f); ctx.stroke(); });
  if (chancePts.length > 1) {
    ctx.beginPath();
    chancePts.forEach((p, i) => {
      const x = (i / (chancePts.length - 1)) * c.width;
      const y = c.height - (p / 100) * c.height;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.strokeStyle = '#12855e'; ctx.lineWidth = 2.5; ctx.stroke();
    ctx.lineTo(c.width, c.height); ctx.lineTo(0, c.height); ctx.closePath();
    ctx.fillStyle = 'rgba(18,133,94,0.08)'; ctx.fill();
  }
}, 900);

poll();
