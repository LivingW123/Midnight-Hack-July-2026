/* Sealed Desk — setup (mandate + desks) then a fully agent-run auction. */

const $ = (id) => document.getElementById(id);

const MANDATES = [
  {
    mono: 'MI',
    item: '1,000,000 shares — Meridian Industries',
    sub: 'Pre-IPO secondary. Announcing a block this size publicly would crater the round.',
  },
  {
    mono: 'AU',
    item: '4,200 oz refined gold — good delivery bars',
    sub: 'Estate liquidation. The family wants out quietly, before the vault story leaks.',
  },
  {
    mono: 'BN',
    item: 'Signed master tapes — Blue Note session, 1962',
    sub: 'One lot, no reserve history, no comparables. Whoever wants it most should win it.',
  },
  {
    mono: 'HV',
    item: '51% stake — Harbourview office tower',
    sub: 'Distressed sale. Rival funds would front-run the refinancing if word got out.',
  },
];

const state = {
  status: null,
  initialized: false,
  lastJobId: null,
  pollTimer: null,
  selectedMandate: 0,
  invited: new Set(),
  rosterBuilt: false,
  lastPrice: null,
};

function short(hex, n = 8) {
  if (!hex) return '—';
  return hex.slice(0, n) + '…' + hex.slice(-4);
}
function fmt(x) {
  try { return BigInt(x).toLocaleString('en-US'); } catch { return String(x); }
}
function hhmm(ms) {
  const d = new Date(ms);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
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

/* ── Setup rendering ─────────────────────────────────────────── */

function buildMandates() {
  const wrap = $('mandates');
  wrap.innerHTML = '';
  MANDATES.forEach((m, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mandate' + (i === state.selectedMandate ? ' on' : '');
    b.innerHTML = `<span class="monogram">${m.mono}</span><span><h3>${m.item}</h3><p class="m-sub">${m.sub}</p></span>`;
    b.addEventListener('click', () => { state.selectedMandate = i; buildMandates(); });
    wrap.appendChild(b);
  });
}

function buildRoster(agents) {
  const wrap = $('roster');
  wrap.innerHTML = '';
  for (const a of agents.filter((x) => x.role === 'buyer')) {
    if (!state.rosterBuilt) state.invited.add(a.name);
    const b = document.createElement('button');
    b.type = 'button';
    const on = state.invited.has(a.name);
    b.className = 'desk-pick' + (on ? ' on' : ' off');
    const record = a.memory.episodes
      ? `${a.memory.episodes} auction(s) · ${a.memory.lastOutcome ?? ''}`
      : 'no auctions yet — a clean book';
    b.innerHTML = `<span class="d-check">${on ? '✓' : ''}</span>` +
      `<p class="a-name">${a.name}</p><p class="a-persona">${a.persona}</p>` +
      `<p class="a-record">${record}</p>`;
    b.addEventListener('click', () => {
      if (state.invited.has(a.name)) {
        if (state.invited.size > 1) state.invited.delete(a.name);
      } else {
        state.invited.add(a.name);
      }
      buildRoster(agents);
    });
    wrap.appendChild(b);
  }
  state.rosterBuilt = true;
}

/* ── Run rendering ───────────────────────────────────────────── */

function agentStage(a, s) {
  const job = s.job;
  const jobActive = job && (job.stage === 'proving' || job.stage === 'queued');
  const busyMine = jobActive && job.label.includes(a.name);
  const v = s.view;
  const won = v && v.winnerName === a.name;
  if (won) return { text: 'took the block', cls: 'done' };
  if (busyMine && job.kind === 'desk-seal') return { text: 'sealing · proving', cls: 'live' };
  if (busyMine && job.kind === 'desk-claim') return { text: 'claiming · proving', cls: 'live' };
  if (busyMine) return { text: 'proving', cls: 'live' };
  if (a.role === 'broker') {
    if (!s.desk.active && !s.desk.settled) return { text: 'awaiting mandate', cls: '' };
    if (s.desk.settled) return { text: 'gavel down', cls: 'done' };
    return { text: 'running the clock', cls: 'live' };
  }
  if (!s.desk.invited.includes(a.name)) return { text: 'benched', cls: '' };
  if (v && v.phase === 'closed') return { text: 'stood down · quote sealed', cls: '' };
  if (a.sealed) return { text: 'watching the clock', cls: 'live' };
  if (s.desk.active) return { text: 'researching', cls: 'live' };
  return { text: 'ready', cls: '' };
}

function render() {
  const s = state.status;
  if (!s) return;

  $('net-dot').className = 'net-dot ' + (s.ready ? 'live' : s.bootError ? 'err' : '');
  $('net-label').textContent = s.ready ? `${s.network} · connected` : s.bootError ? 'error' : 'syncing wallet…';

  if (s.brain) {
    $('brain-badge').hidden = false;
    $('brain-label').textContent = s.brain.kind === 'ollama'
      ? `local LLM: ${s.brain.model} — nothing leaves this machine`
      : 'transparent heuristic brains — no cloud calls';
  }

  const job = s.job;
  const jobActive = job && (job.stage === 'proving' || job.stage === 'queued');
  if (!state.initialized) {
    state.initialized = true;
    state.lastJobId = job && !jobActive ? job.id : 0;
  } else if (job && !jobActive && job.id !== state.lastJobId) {
    state.lastJobId = job.id;
    if (job.message) toast(job.ok === false ? `${job.label} — ${job.message}` : job.message, job.ok === false);
  }
  $('job').hidden = !jobActive;
  if (jobActive) $('job-label').textContent = job.label;

  const v = s.view;
  const running = s.desk.active || (v && !s.desk.settled && v.phase === 'open') || jobActive;
  const showRun = running || s.desk.settled;
  $('setup').hidden = showRun || !s.ready;
  $('run').hidden = !showRun;
  $('again-panel').hidden = !s.desk.settled;

  if (!showRun) {
    $('desk-item').textContent = 'Give the desks a mandate';
    $('eyebrow').textContent = 'A block sale, run end to end by local AI agents';
    if (!$('mandates').childElementCount) buildMandates();
    buildRoster(s.agents);
    return;
  }

  $('desk-item').textContent = s.desk.item ? '“' + s.desk.item + '”' : '…';
  $('eyebrow').textContent = s.desk.settled ? 'Gavel down — the desks are done' : 'The desks are trading — you are just watching';

  // Agent rail
  const rail = $('agent-rail');
  const visible = s.agents.filter((a) => a.role === 'broker' || s.desk.invited.includes(a.name));
  const lastThoughtBy = {};
  for (const t of s.feed) lastThoughtBy[t.agent] = t;
  const sig = JSON.stringify(visible.map((a) => {
    const st = agentStage(a, s);
    const t = lastThoughtBy[a.name];
    return [a.name, st.text, t && t.at, t && t.text];
  }));
  if (rail.dataset.state !== sig) {
    rail.dataset.state = sig;
    rail.innerHTML = '';
    for (const a of visible) {
      const st = agentStage(a, s);
      const t = lastThoughtBy[a.name];
      const card = document.createElement('div');
      card.className = 'acard' + (st.cls === 'live' ? ' busy' : '') + (v && v.winnerName === a.name ? ' won' : '');
      card.innerHTML =
        `<div class="a-top"><span class="a-name">${a.name}</span>` +
        `<span class="a-role ${a.role}">${a.role}</span>` +
        `<span class="state-chip ${st.cls}"><span class="s-dot"></span>${st.text}</span></div>` +
        `<p class="a-thought${t && t.isPrivate ? ' private' : ''}">${t ? '' : '…'}` +
        `${t && t.isPrivate ? '<span class="lock">LOCAL ONLY</span>' : ''}</p>`;
      if (t) card.querySelector('.a-thought').insertAdjacentText('afterbegin', t.text);
      rail.appendChild(card);
    }
  }

  // Timeline
  const tl = $('timeline-feed');
  const fsig = String(s.feed.length) + ':' + (s.feed[s.feed.length - 1]?.at ?? 0);
  if (tl.dataset.state !== fsig) {
    tl.dataset.state = fsig;
    tl.innerHTML = '';
    for (const t of s.feed.slice(-40)) {
      const row = document.createElement('div');
      row.className = 'ev' + (t.isPrivate ? ' private' : '');
      row.innerHTML = `<span class="e-time">${hhmm(t.at)}</span><span class="e-who">${t.agent}</span><span class="e-text"></span>`;
      row.querySelector('.e-text').textContent = t.text + (t.isPrivate ? '  🔒' : '');
      tl.appendChild(row);
    }
    tl.scrollTop = tl.scrollHeight;
  }

  // The tape
  if (v) {
    $('desk-contract').textContent = short(s.desk.address || '', 10);
    const priceEl = $('clock-price');
    const cur = String(v.currentPrice);
    priceEl.textContent = fmt(cur);
    if (state.lastPrice !== null && state.lastPrice !== cur) {
      priceEl.classList.remove('dropped');
      void priceEl.offsetWidth; // restart the animation
      priceEl.classList.add('dropped');
      setTimeout(() => priceEl.classList.remove('dropped'), 400);
    }
    state.lastPrice = cur;

    const ladder = $('price-ladder');
    const hist = (s.desk.priceHistory || []).slice(0, -1).slice(-5);
    const lsig = hist.join(',');
    if (ladder.dataset.state !== lsig) {
      ladder.dataset.state = lsig;
      ladder.innerHTML = hist.map((p) => `<span class="old">${fmt(p)}</span>`).join('');
    }

    $('clock-floor').textContent = 'floor ' + fmt(v.floorPrice) + ' · ' + v.bidderCount + ' sealed quote(s)';
    $('phase-banner').textContent = v.phase === 'closed'
      ? 'Gavel down. Losing quotes remain sealed forever.'
      : v.bidderCount === 0
        ? 'Sealing is open — desks are researching their numbers.'
        : 'Quotes are sealed. The clock descends until one desk claims.';

    const body = $('quotes-body');
    const qsig = (v.bids || []).map((b) => b.commitment).join(',');
    if (body.dataset.state !== qsig) {
      body.dataset.state = qsig;
      body.innerHTML = '';
      (v.bids || []).forEach((b, i) => {
        const tr = document.createElement('tr');
        tr.className = 'printing';
        tr.innerHTML = `<td class="num">${i + 1}</td><td class="mono">${short(b.bidderId)}</td><td class="mono">${short(b.commitment, 12)}</td>`;
        body.appendChild(tr);
      });
    }
    $('quotes-empty').hidden = (v.bids || []).length > 0;
    const sold = v.phase === 'closed' && v.winner;
    $('desk-sold').hidden = !sold;
    if (sold) $('desk-sold-price').textContent = fmt(v.highestBid) + (v.winnerName ? ' to ' + v.winnerName : '');
  }
}

/* ── Poll loop ───────────────────────────────────────────────── */

async function poll() {
  try {
    state.status = await api('/api/desk-status');
    render();
    // First successful render — drop the skeleton shimmer.
    document.body.classList.remove('is-loading');
  } catch {
    $('net-dot').className = 'net-dot err';
    $('net-label').textContent = 'server unreachable';
  }
  clearTimeout(state.pollTimer);
  const job = state.status && state.status.job;
  const busy = (job && (job.stage === 'proving' || job.stage === 'queued')) || (state.status && state.status.desk.active);
  state.pollTimer = setTimeout(poll, busy ? 1500 : 3500);
}

setInterval(() => {
  const job = state.status && state.status.job;
  if (job && (job.stage === 'proving' || job.stage === 'queued')) {
    $('job-clock').textContent = Math.max(0, Math.round((Date.now() - job.startedAt) / 1000)) + 's';
  }
}, 500);

$('handover-button').addEventListener('click', () => {
  const m = MANDATES[state.selectedMandate];
  api('/api/action', { type: 'desk-start', item: m.item, buyers: [...state.invited] }).then((res) => {
    if (res.error) toast(res.error, true);
    else poll();
  });
});

$('again-button').addEventListener('click', () => {
  api('/api/action', { type: 'desk-stop' }).then(() => {
    state.status.desk.settled = false;
    state.status.desk.active = false;
    state.status.view = null;
    state.lastPrice = null;
    $('run').hidden = true;
    $('setup').hidden = false;
    $('desk-item').textContent = 'Give the desks a mandate';
    buildMandates();
    buildRoster(state.status.agents);
  });
});

poll();
