// Global state
window.current = {
  sessionId: null,
  country: null,
  player: null,
  difficulty: 'normal',
  baseURL: 'http://localhost:3000'
};

// Overlay helpers
function openOverlay(id) { document.getElementById(id).style.display = 'block'; }
function closeOverlay(id) { document.getElementById(id).style.display = 'none'; }

// Dialogue
function showDialogue(msg) {
  const el = document.getElementById('dialogueBar');
  el.textContent = msg;
}

// Log to timeline UI
function addLogEntry(type, msg) {
  const list = document.getElementById('timelineList');
  const item = document.createElement('div');
  item.className = 'timeline-item';
  item.innerHTML = `<span class="type">[${type}]</span> ${msg}`;
  list.prepend(item);
}

// HUD updates
function updateHUD(a, s, e, j, p, c) {
  if (typeof a === 'number') document.getElementById('hudApproval').textContent = a + '%';
  if (typeof s === 'number') document.getElementById('hudStability').textContent = s + '%';
  if (typeof e === 'number') document.getElementById('hudEconomy').textContent = e + '%';
  if (typeof j === 'number') document.getElementById('hudJustice').textContent = j + '%';
  if (typeof p === 'number') document.getElementById('hudPower').textContent = p + '%';
  if (typeof c === 'number') document.getElementById('hudChaos').textContent = c + '%';
}

// Backend calls
async function api(path, method = 'GET', body) {
  const res = await fetch(`${window.current.baseURL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  return res.json();
}

// Session start
async function startSession() {
  const player = document.getElementById('playerName').value || 'Player';
  const difficulty = document.getElementById('difficulty').value;
  const country = window.current.country || 'India';

  const data = await api('/session/start', 'POST', { playerName: player, country, difficulty });
  window.current.sessionId = data.sessionId;
  window.current.player = player;
  window.current.difficulty = difficulty;

  showDialogue(`Session started: ${country} (${difficulty})`);
  addLogEntry('system', 'Presidency begins.');
  document.getElementById('titleScreen').style.display = 'none';
  document.getElementById('hudOverlay').style.display = 'grid';

  // Pull initial stats snapshot
  const stats = await api(`/session/${window.current.sessionId}/stats`);
  updateHUD(stats.approval, stats.stability, stats.economy, stats.justice, stats.power, stats.chaos);
}

// Law enforcement
async function handleEnforceLaw() {
  const sessionId = window.current.sessionId;
  if (!sessionId) return showDialogue('Start a session first.');
  const lawType = document.getElementById('lawType').value;
  const description = document.getElementById('lawDesc').value || 'Law enforced';

  const data = await api('/laws/enforce', 'POST', { sessionId, lawType, description });
  const s = data.stats;
  updateHUD(s.approval, s.stability, s.economy, s.justice, s.power, s.chaos);
  addLogEntry('law', `${description} (${lawType})`);
  showDialogue(`Law applied: ${lawType}`);
}

// Crisis resolution
async function handleResolveCrisis(strategy) {
  const sessionId = window.current.sessionId;
  if (!sessionId) return showDialogue('Start a session first.');
  const data = await api('/crises/resolve', 'POST', { sessionId, strategy, description: 'Crisis handled' });
  const s = data.stats;
  updateHUD(s.approval, s.stability, s.economy, s.justice, s.power, s.chaos);
  addLogEntry('crisis', `Strategy: ${strategy}`);
  showDialogue(`Crisis: ${strategy} executed.`);
}

// Diplomacy
async function handleDiplomacy(action) {
  const sessionId = window.current.sessionId;
  if (!sessionId) return showDialogue('Start a session first.');
  const data = await api('/diplomacy/action', 'POST', { sessionId, action });
  const s = data.stats;
  updateHUD(s.approval, s.stability, s.economy, s.justice, s.power, s.chaos);
  addLogEntry('diplomacy', `Action: ${action}`);
  showDialogue(`Diplomacy: ${action}.`);
}

// Rebellion
async function handleRebellion(strategy) {
  const sessionId = window.current.sessionId;
  if (!sessionId) return showDialogue('Start a session first.');
  const data = await api('/rebellion/act', 'POST', { sessionId, strategy });
  const s = data.stats;
  updateHUD(s.approval, s.stability, s.economy, s.justice, s.power, s.chaos);
  addLogEntry('rebellion', `Action: ${strategy}`);
  showDialogue(`Rebellion: ${strategy}.`);
}

// Cosmic
async function handleCosmic(kind) {
  const sessionId = window.current.sessionId;
  if (!sessionId) return showDialogue('Start a session first.');
  const data = await api('/cosmic/act', 'POST', { sessionId, kind });
  const s = data.stats;
  updateHUD(s.approval, s.stability, s.economy, s.justice, s.power, s.chaos);
  addLogEntry('cosmic', `Action: ${kind}`);
  showDialogue(`Cosmic: ${kind}.`);
}

// Timeline
async function refreshTimeline() {
  const sessionId = window.current.sessionId;
  if (!sessionId) return;
  const items = await api(`/timeline/${sessionId}`);
  const list = document.getElementById('timelineList');
  list.innerHTML = '';
  for (const t of items.reverse()) {
    const div = document.createElement('div');
    div.className = 'timeline-item';
    const when = new Date(t.at).toLocaleTimeString();
    div.innerHTML = `<span class="type">[${t.type}]</span> ${t.description} — ${when}`;
    list.appendChild(div);
  }
}
document.getElementById('timelineOverlay').addEventListener('click', (e) => {
  if (e.target.id === 'timelineOverlay') refreshTimeline();
});

// Archive + Final Vaultline
async function endAndArchive() {
  const sessionId = window.current.sessionId;
  if (!sessionId) return showDialogue('Start a session first.');
  openOverlay('archiveOverlay');
  document.getElementById('archiveMsg').textContent = 'Compressing your presidency...';

  const res = await api('/session/end', 'POST', { sessionId });
  const { archive } = res;

  // Show final screen
  const stats = archive.stats;
  document.getElementById('vaultlineStats').textContent =
    `Country: ${archive.country} | Diff: ${archive.difficulty} | ` +
    `Laws: ${stats.laws} | Crises: ${stats.crises} | ` +
    `Justice: ${stats.justice}% | Power: ${stats.power}% | Chaos: ${stats.chaos}%`;

  document.getElementById('vaultlineGlyphs').textContent = (archive.glyphs || ['⚖️','⚡','🌪️']).join(' ');
  closeOverlay('archiveOverlay');
  openOverlay('vaultlineOverlay');
  showDialogue('Final Vaultline Entry created.');
}

// Return to title
function returnToTitle() {
  window.current.sessionId = null;
  window.current.country = null;
  document.getElementById('vaultlineOverlay').style.display = 'none';
  document.getElementById('hudOverlay').style.display = 'none';
  document.getElementById('titleScreen').style.display = 'block';
  document.getElementById('timelineList').innerHTML = '';
  showDialogue('Welcome to President Sim');
}

// Title screen interactions
window.addEventListener('DOMContentLoaded', () => {
  // Country select
  document.querySelectorAll('.country-card').forEach(card => {
    card.addEventListener('click', () => {
      document.querySelectorAll('.country-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');
      window.current.country = card.getAttribute('data-country');
      showDialogue(`Selected: ${window.current.country}`);
    });
  });

  // Start button
  document.getElementById('startBtn').addEventListener('click', async () => {
    if (!window.current.country) {
      showDialogue('Select a country first.');
      return;
    }
    await startSession();
    // Initial timeline pull
    setTimeout(refreshTimeline, 300);
  });
});