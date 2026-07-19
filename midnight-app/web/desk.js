/* Sealed Desk — frontend. Polls /api/desk-status; the agents do everything. */

const $ = (id) => document.getElementById(id);

const state = { status: null, initialized: false, lastJobId: null, pollTimer: null };

function short(hex, n = 8) {
  if (!hex) return '—';
  return hex.slice(0, n) + '…' + hex.slice(-4);
}
function fmt(x) {
  try { return BigInt(x).toLocaleString('en-US'); } catch { return String(x); }
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
  $('start-panel').hidden = s.desk.active || (v && v.phase === 'open');
  $('desk-button').disabled = jobActive || !s.ready;

  $('desk-item').textContent = s.desk.item ? '“' + s.desk.item + '”' : 'The trading floor is quiet';

  // Agent cards
  const winnerName = v && v.winnerName;
  const grid = $('agent-grid');
  const sig = JSON.stringify(s.agents.map((a) => [a.name, a.sealed, winnerName === a.name, a.memory.episodes]));
  if (grid.dataset.state !== sig) {
    grid.dataset.state = sig;
    grid.innerHTML = '';
    for (const a of s.agents) {
      const card = document.createElement('div');
      card.className = 'agent-card' + (a.sealed ? ' sealed' : '') + (winnerName === a.name ? ' won' : '');
      const stateLine = winnerName === a.name
        ? '🏆 took the block'
        : a.role === 'broker'
          ? (s.desk.active ? 'running the clock' : 'waiting for a mandate')
          : a.sealed ? 'quote sealed · watching the clock' : 'researching';
      card.innerHTML =
        `<span class="a-name">${a.name}</span><span class="a-role ${a.role}">${a.role}</span>` +
        `<p class="a-persona">${a.persona}</p>` +
        `<p class="a-state">${stateLine}${a.memory.episodes ? ` · ${a.memory.episodes} past auction(s) remembered` : ''}</p>`;
      grid.appendChild(card);
    }
  }

  // Floor chatter
  const feedEl = $('chatter-feed');
  const fsig = String(s.feed.length) + ':' + (s.feed[s.feed.length - 1]?.at ?? 0);
  if (feedEl.dataset.state !== fsig) {
    feedEl.dataset.state = fsig;
    feedEl.innerHTML = '';
    for (const t of s.feed.slice(-30)) {
      const row = document.createElement('div');
      row.className = 'thought' + (t.isPrivate ? ' private' : '');
      row.innerHTML = `<span class="t-who">${t.agent}</span><span class="t-text"></span>` +
        (t.isPrivate ? '<span class="t-lock">LOCAL ONLY</span>' : '');
      row.querySelector('.t-text').textContent = t.text;
      feedEl.appendChild(row);
    }
    feedEl.scrollTop = feedEl.scrollHeight;
  }

  // The public tape
  if (v) {
    $('desk-contract').textContent = short(s.desk.address || '', 10);
    $('clock-price').textContent = fmt(v.currentPrice);
    $('clock-floor').textContent = 'floor ' + fmt(v.floorPrice) + ' · ' + v.bidderCount + ' sealed quote(s)';
    const body = $('quotes-body');
    const qsig = (v.bids || []).map((b) => b.commitment).join(',');
    if (body.dataset.state !== qsig) {
      body.dataset.state = qsig;
      body.innerHTML = '';
      (v.bids || []).forEach((b, i) => {
        const tr = document.createElement('tr');
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

async function poll() {
  try {
    state.status = await api('/api/desk-status');
    render();
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

$('desk-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const item = $('desk-input').value.trim();
  api('/api/action', { type: 'desk-start', item }).then((res) => {
    if (res.error) toast(res.error, true);
  });
});

poll();
