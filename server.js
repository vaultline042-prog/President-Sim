// server.js
const express = require('express');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const zlib = require('zlib');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// --- DB init ---
const db = new Database('president_sim.db');

// Create tables if not exist
db.exec(`
CREATE TABLE IF NOT EXISTS Session (
  id TEXT PRIMARY KEY,
  playerName TEXT,
  country TEXT,
  difficulty TEXT,
  chaosThreshold INTEGER,
  startedAt TEXT,
  endedAt TEXT
);

CREATE TABLE IF NOT EXISTS Stats (
  sessionId TEXT PRIMARY KEY,
  approval INTEGER,
  stability INTEGER,
  economy INTEGER,
  justice INTEGER,
  power INTEGER,
  chaos INTEGER,
  laws INTEGER,
  crises INTEGER,
  FOREIGN KEY(sessionId) REFERENCES Session(id)
);

CREATE TABLE IF NOT EXISTS TimelineEvent (
  id TEXT PRIMARY KEY,
  sessionId TEXT,
  type TEXT,
  description TEXT,
  at TEXT,
  FOREIGN KEY(sessionId) REFERENCES Session(id)
);

CREATE TABLE IF NOT EXISTS Achievement (
  id TEXT PRIMARY KEY,
  sessionId TEXT,
  key TEXT,
  description TEXT,
  at TEXT,
  FOREIGN KEY(sessionId) REFERENCES Session(id)
);

CREATE TABLE IF NOT EXISTS Archive (
  id TEXT PRIMARY KEY,
  sessionId TEXT,
  payload TEXT,
  createdAt TEXT,
  FOREIGN KEY(sessionId) REFERENCES Session(id)
);

CREATE TABLE IF NOT EXISTS MultiplayerMatch (
  matchId TEXT PRIMARY KEY,
  sessionAId TEXT,
  sessionBId TEXT,
  mode TEXT,
  startedAt TEXT,
  endedAt TEXT
);
`);

// Prepared statements
const insertSession = db.prepare(`
INSERT INTO Session (id, playerName, country, difficulty, chaosThreshold, startedAt) VALUES (@id, @playerName, @country, @difficulty, @chaosThreshold, @startedAt)
`);
const updateSessionEnded = db.prepare(`
UPDATE Session SET endedAt = @endedAt WHERE id = @id
`);
const upsertStats = db.prepare(`
INSERT INTO Stats (sessionId, approval, stability, economy, justice, power, chaos, laws, crises)
VALUES (@sessionId, @approval, @stability, @economy, @justice, @power, @chaos, @laws, @crises)
ON CONFLICT(sessionId) DO UPDATE SET
  approval=@approval, stability=@stability, economy=@economy, justice=@justice, power=@power, chaos=@chaos, laws=@laws, crises=@crises
`);
const getStatsStmt = db.prepare(`SELECT * FROM Stats WHERE sessionId = ?`);
const insertTimeline = db.prepare(`
INSERT INTO TimelineEvent (id, sessionId, type, description, at) VALUES (@id,@sessionId,@type,@description,@at)
`);
const insertAchievement = db.prepare(`
INSERT INTO Achievement (id, sessionId, key, description, at) VALUES (@id,@sessionId,@key,@description,@at)
`);
const insertArchive = db.prepare(`
INSERT INTO Archive (id, sessionId, payload, createdAt) VALUES (@id,@sessionId,@payload,@createdAt)
`);
const insertMatch = db.prepare(`
INSERT INTO MultiplayerMatch (matchId, sessionAId, sessionBId, mode, startedAt) VALUES (@matchId,@sessionAId,@sessionBId,@mode,@startedAt)
`);
const updateMatch = db.prepare(`
UPDATE MultiplayerMatch SET endedAt=@endedAt WHERE matchId=@matchId
`);

// --- Game engine config ---

// Base default stats for a new session (tweak as desired)
const DEFAULT_STATS = {
  approval: 50,
  stability: 50,
  economy: 50,
  justice: 50,
  power: 50,
  chaos: 0,
  laws: 0,
  crises: 0
};

// Deltas for actions (can be replaced by richer rules)
const LAW_DELTAS = {
  'tax_cut':         { approval: +5, economy: +8, stability: -2, chaos: -1, power: 0 },
  'emergency_rule':  { approval: -10, stability: +10, justice: -8, power: +12, chaos: +5 },
  'welfare_boost':   { approval: +8, economy: -6, justice: +5, chaos: -2, power: 0 },
  'police_reform':   { approval: -3, justice: +12, stability: +2, chaos: -1, power: -2 }
  // ... add more as needed
};

const CRISIS_DELTAS = {
  'pandemic':      { approval: -6, stability: -10, economy: -12, justice: 0, power: +5, chaos: +8 },
  'economic_shock':{ approval: -8, stability: -6, economy: -15, justice: 0, power: +3, chaos: +6 },
  'diplomatic_row':{ approval: -4, stability: -3, economy: -2, power: -1, chaos: +2 }
  // ...
};

const DIPLOMACY_DELTAS = {
  'treaty':   { approval: +2, stability: +3, economy: +2, chaos: -1 },
  'trade':    { approval: +1, economy: +6, stability: +1 },
  'rivalry':  { approval: -3, stability: -4, chaos: +4 }
};

const REBELLION_DELTAS = {
  'negotiate': { approval: +5, stability: +6, chaos: -8, power: -5 },
  'suppress':  { approval: -12, stability: +10, chaos: +10, power: +8 },
  'appease':   { approval: +3, stability: +4, economy: -4, chaos: -5 }
};

const COSMIC_DELTAS = {
  'probe':    { approval: -2, chaos: +10, power: +3 },
  'entreat':  { approval: +4, chaos: -6, stability: +2 },
  'distort':  { approval: -20, chaos: +25, stability: -15, power: +20 }
};

// Achievement rules (example)
const ACHIEVEMENT_RULES = [
  { key:'stable_mandate', condition: s => s.stability >= 90, description: 'Stability >= 90' },
  { key:'economic_wizard', condition: s => s.economy >= 90, description: 'Economy >= 90' },
  { key:'chaos_master', condition: s => s.chaos >= 80, description: 'Chaos >= 80' },
  { key:'iron_fist', condition: s => s.power >= 90 && s.justice < 30, description: 'Power >= 90 while Justice < 30' }
];

// thresholds for game over or rebellion
function checkGameOver(stats, chaosThreshold) {
  // Example rules: if chaos >= chaosThreshold OR stability <= 0 OR approval <= 0 -> game over
  if (stats.chaos >= chaosThreshold) return { gameOver: true, reason: 'Chaos exceeded threshold' };
  if (stats.stability <= 0) return { gameOver: true, reason: 'Stability collapsed' };
  if (stats.approval <= 0) return { gameOver: true, reason: 'Approval vanished' };
  return { gameOver: false };
}

function checkRebellionChance(stats) {
  // returns rebellion intensity or null.
  // Example simple rule: if chaos>50 or stability<25 -> chance of rebellion
  if (stats.chaos > 65 || stats.stability < 20) return { rebellion: true, intensity: Math.min(100, Math.round((stats.chaos + (50 - stats.stability))/2)) };
  if (stats.approval < 15) return { rebellion: true, intensity: Math.max(10, 40 - stats.approval) };
  return { rebellion: false };
}

// Utility to apply deltas to stats and clamp 0..100 (chaos can exceed 100)
function applyDeltas(stats, deltas) {
  let s = Object.assign({}, stats);
  for (const key of ['approval','stability','economy','justice','power']) {
    if (deltas[key] !== undefined) s[key] = Math.max(0, Math.min(100, s[key] + deltas[key]));
  }
  if (deltas.chaos !== undefined) {
    s.chaos = Math.max(0, s.chaos + deltas.chaos); // chaos can grow beyond 100 maybe
  }
  if (deltas.laws !== undefined) s.laws = (s.laws || 0) + deltas.laws;
  if (deltas.crises !== undefined) s.crises = (s.crises || 0) + deltas.crises;
  return s;
}

// Save timeline helper
function pushTimeline(sessionId, type, description) {
  const ev = { id: uuidv4(), sessionId, type, description, at: new Date().toISOString() };
  insertTimeline.run(ev);
  return ev;
}

// Achievement logic: check rules and insert any new ones
function evaluateAchievements(sessionId, stats) {
  const found = [];
  const existing = db.prepare(`SELECT key FROM Achievement WHERE sessionId = ?`).all(sessionId).map(r=>r.key);
  for (const rule of ACHIEVEMENT_RULES) {
    if (!existing.includes(rule.key) && rule.condition(stats)) {
      const ach = { id: uuidv4(), sessionId, key: rule.key, description: rule.description, at: new Date().toISOString() };
      insertAchievement.run(ach);
      found.push(ach);
      pushTimeline(sessionId, 'achievement', `Achievement unlocked: ${rule.key} - ${rule.description}`);
    }
  }
  return found;
}

// Archive compression: compress final JSON using zlib deflate -> base64 -> map to glyph-like characters
function compressToGlyphs(obj) {
  const json = JSON.stringify(obj);
  const def = zlib.deflateSync(Buffer.from(json, 'utf8'));
  const b64 = def.toString('base64');
  // Create glyph map: map base64 chars to a small glyph set for "glyphy" archive
  const glyphSet = '⍟✦✧✵✶✷✸✹✺✼✽✾★☼☯☸✺❂❃❁✿☙♆♔♕♖♗♘♙';
  // map each base64 char code to one of glyphSet
  let glyphs = '';
  for (let i = 0; i < b64.length; i++) {
    const ch = b64.charCodeAt(i);
    glyphs += glyphSet[ch % glyphSet.length];
  }
  return glyphs;
}

// --- Endpoint implementations ---

// POST /session/start
app.post('/session/start', (req, res) => {
  const { playerName = 'Player', country = 'Republic', difficulty = 'normal', chaosThreshold = 100 } = req.body || {};
  const id = uuidv4();
  const startedAt = new Date().toISOString();
  insertSession.run({ id, playerName, country, difficulty, chaosThreshold, startedAt });

  // insert default stats snapshot
  const baseStats = Object.assign({ sessionId: id }, DEFAULT_STATS);
  upsertStats.run(baseStats);

  pushTimeline(id, 'system', `Session started for ${playerName} in ${country} (${difficulty})`);

  return res.json({ sessionId: id, stats: baseStats });
});

// POST /session/end -> close run, compute archive
app.post('/session/end', (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  const endedAt = new Date().toISOString();
  updateSessionEnded.run({ id: sessionId, endedAt });

  // compute final state and create archive
  const stats = getStatsStmt.get(sessionId);
  if (!stats) return res.status(404).json({ error: 'session not found or no stats' });

  const archivePayload = { sessionId, stats, endedAt, generatedAt: new Date().toISOString() };
  const glyphs = compressToGlyphs(archivePayload);

  const archiveRecord = { id: uuidv4(), sessionId, payload: glyphs, createdAt: new Date().toISOString() };
  insertArchive.run(archiveRecord);

  pushTimeline(sessionId, 'archive', 'Presidency archived');

  return res.json({ archiveId: archiveRecord.id, glyphs });
});

// GET /session/:id/stats
app.get('/session/:id/stats', (req, res) => {
  const id = req.params.id;
  const stats = getStatsStmt.get(id);
  if (!stats) return res.status(404).json({ error: 'stats not found' });
  return res.json({ stats });
});

// POST /laws/enforce
app.post('/laws/enforce', (req, res) => {
  const { sessionId, lawKey, description } = req.body;
  if (!sessionId || !lawKey) return res.status(400).json({ error: 'sessionId and lawKey required' });

  const statsRow = getStatsStmt.get(sessionId);
  if (!statsRow) return res.status(404).json({ error: 'session not found' });

  const deltas = LAW_DELTAS[lawKey] || { approval: 0 };
  deltas.laws = 1; // increment laws count
  const newStats = applyDeltas(statsRow, deltas);
  upsertStats.run(newStats);

  pushTimeline(sessionId, 'law', description || `Enforced law: ${lawKey}`);

  // evaluate achievements & rebellion
  const achievements = evaluateAchievements(sessionId, newStats);
  const rebellion = checkRebellionChance(newStats);
  const chaosThreshold = db.prepare(`SELECT chaosThreshold FROM Session WHERE id = ?`).get(sessionId)?.chaosThreshold || 100;
  const gameOver = checkGameOver(newStats, chaosThreshold);

  // return updated state
  res.json({ stats: newStats, achievements, rebellion, gameOver });
});

// POST /crises/resolve
app.post('/crises/resolve', (req, res) => {
  const { sessionId, crisisKey, method, description } = req.body;
  if (!sessionId || !crisisKey) return res.status(400).json({ error: 'sessionId and crisisKey required' });

  const statsRow = getStatsStmt.get(sessionId);
  if (!statsRow) return res.status(404).json({ error: 'session not found' });

  // crisis base delta
  const base = CRISIS_DELTAS[crisisKey] || { approval: -2 };
  // method can modify delta: e.g., 'bold' => more power but more chaos, 'measured' => stability focus
  let methodMod = {};
  if (method === 'bold') methodMod = { power: +5, chaos: +4, approval: -3 };
  else if (method === 'measured') methodMod = { stability: +4, approval: +2, economy: -3 };
  else if (method === 'ignore') methodMod = { approval: -10, stability: -12, chaos: +10 };

  const merged = Object.assign({}, base);
  for (const k of Object.keys(methodMod)) merged[k] = (merged[k] || 0) + methodMod[k];

  merged.crises = 1;
  const newStats = applyDeltas(statsRow, merged);
  upsertStats.run(newStats);

  pushTimeline(sessionId, 'crisis', description || `Resolved crisis ${crisisKey} by ${method || 'default'}`);

  const achievements = evaluateAchievements(sessionId, newStats);
  const rebellion = checkRebellionChance(newStats);
  const chaosThreshold = db.prepare(`SELECT chaosThreshold FROM Session WHERE id = ?`).get(sessionId)?.chaosThreshold || 100;
  const gameOver = checkGameOver(newStats, chaosThreshold);
  res.json({ stats: newStats, achievements, rebellion, gameOver });
});

// POST /diplomacy/action
app.post('/diplomacy/action', (req, res) => {
  const { sessionId, actionKey, target, description } = req.body;
  if (!sessionId || !actionKey) return res.status(400).json({ error: 'sessionId and actionKey required' });

  const statsRow = getStatsStmt.get(sessionId);
  if (!statsRow) return res.status(404).json({ error: 'session not found' });

  const deltas = DIPLOMACY_DELTAS[actionKey] || { approval: 0 };
  const newStats = applyDeltas(statsRow, deltas);
  upsertStats.run(newStats);

  pushTimeline(sessionId, 'diplomacy', description || `Diplomacy ${actionKey} with ${target || 'unknown'}`);

  const achievements = evaluateAchievements(sessionId, newStats);
  const rebellion = checkRebellionChance(newStats);
  res.json({ stats: newStats, achievements, rebellion });
});

// POST /rebellion/act
app.post('/rebellion/act', (req, res) => {
  const { sessionId, act, description } = req.body;
  if (!sessionId || !act) return res.status(400).json({ error: 'sessionId and act required' });

  const statsRow = getStatsStmt.get(sessionId);
  if (!statsRow) return res.status(404).json({ error: 'session not found' });

  const deltas = REBELLION_DELTAS[act] || { approval: 0 };
  const newStats = applyDeltas(statsRow, deltas);
  upsertStats.run(newStats);

  pushTimeline(sessionId, 'rebellion', description || `Rebellion action: ${act}`);

  const achievements = evaluateAchievements(sessionId, newStats);
  const rebellion = checkRebellionChance(newStats);
  const chaosThreshold = db.prepare(`SELECT chaosThreshold FROM Session WHERE id = ?`).get(sessionId)?.chaosThreshold || 100;
  const gameOver = checkGameOver(newStats, chaosThreshold);

  res.json({ stats: newStats, achievements, rebellion, gameOver });
});

// POST /cosmic/act
app.post('/cosmic/act', (req, res) => {
  const { sessionId, actKey, description } = req.body;
  if (!sessionId || !actKey) return res.status(400).json({ error: 'sessionId and actKey required' });

  const statsRow = getStatsStmt.get(sessionId);
  if (!statsRow) return res.status(404).json({ error: 'session not found' });

  const deltas = COSMIC_DELTAS[actKey] || { chaos: +5 };
  const newStats = applyDeltas(statsRow, deltas);
  upsertStats.run(newStats);

  pushTimeline(sessionId, 'cosmic', description || `Cosmic act: ${actKey}`);

  // cosmic acts can immediately unlock mythic achievements
  if (actKey === 'distort') {
    insertAchievement.run({ id: uuidv4(), sessionId, key: 'distorted_realm', description: 'Distorted the fabric of state', at: new Date().toISOString() });
    pushTimeline(sessionId, 'achievement', 'Achievement unlocked: distorted_realm');
  }

  const achievements = evaluateAchievements(sessionId, newStats);
  const rebellion = checkRebellionChance(newStats);
  const chaosThreshold = db.prepare(`SELECT chaosThreshold FROM Session WHERE id = ?`).get(sessionId)?.chaosThreshold || 100;
  const gameOver = checkGameOver(newStats, chaosThreshold);

  res.json({ stats: newStats, achievements, rebellion, gameOver });
});

// POST /achievement/unlock (manual unlock)
app.post('/achievement/unlock', (req, res) => {
  const { sessionId, key, description } = req.body;
  if (!sessionId || !key) return res.status(400).json({ error: 'sessionId and key required' });
  const ach = { id: uuidv4(), sessionId, key, description: description || key, at: new Date().toISOString() };
  insertAchievement.run(ach);
  pushTimeline(sessionId, 'achievement', `Manually unlocked: ${key}`);
  res.json({ achievement: ach });
});

// GET /timeline/:id
app.get('/timeline/:id', (req, res) => {
  const id = req.params.id;
  const rows = db.prepare(`SELECT * FROM TimelineEvent WHERE sessionId = ? ORDER BY at ASC`).all(id);
  return res.json({ timeline: rows });
});

// POST /archive/export -> compress presidency (manual export)
app.post('/archive/export', (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

  const stats = getStatsStmt.get(sessionId);
  if (!stats) return res.status(404).json({ error: 'session not found' });

  // Build full payload: session row + stats + timeline + achievements
  const sessionRow = db.prepare(`SELECT * FROM Session WHERE id = ?`).get(sessionId) || {};
  const timeline = db.prepare(`SELECT * FROM TimelineEvent WHERE sessionId = ? ORDER BY at ASC`).all(sessionId);
  const achievements = db.prepare(`SELECT key, description, at FROM Achievement WHERE sessionId = ?`).all(sessionId);

  const payload = { session: sessionRow, stats, timeline, achievements, exportedAt: new Date().toISOString() };
  const glyphs = compressToGlyphs(payload);

  const archiveId = uuidv4();
  insertArchive.run({ id: archiveId, sessionId, payload: glyphs, createdAt: new Date().toISOString() });

  pushTimeline(sessionId, 'archive', 'Archive exported manually');

  // Return glyph payload and a small ascii preview size
  return res.json({ archiveId, glyphsSample: glyphs.slice(0, 256), glyphsLength: glyphs.length });
});

// POST /multiplayer/start
app.post('/multiplayer/start', (req, res) => {
  const { sessionAId, sessionBId, mode = 'versus' } = req.body;
  if (!sessionAId || !sessionBId) return res.status(400).json({ error: 'both session IDs required' });
  const matchId = uuidv4();
  insertMatch.run({ matchId, sessionAId, sessionBId, mode, startedAt: new Date().toISOString() });
  pushTimeline(sessionAId, 'system', `Multiplayer match ${matchId} started vs ${sessionBId}`);
  pushTimeline(sessionBId, 'system', `Multiplayer match ${matchId} started vs ${sessionAId}`);
  res.json({ matchId, mode });
});

// POST /multiplayer/update
app.post('/multiplayer/update', (req, res) => {
  const { matchId, deltaA, deltaB, end = false } = req.body;
  const match = db.prepare(`SELECT * FROM MultiplayerMatch WHERE matchId = ?`).get(matchId);
  if (!match) return res.status(404).json({ error: 'match not found' });

  // Apply deltas to sessions if provided
  if (deltaA && match.sessionAId) {
    const sA = getStatsStmt.get(match.sessionAId);
    if (sA) {
      const newA = applyDeltas(sA, deltaA);
      upsertStats.run(newA);
      pushTimeline(match.sessionAId, 'system', `Multiplayer update applied to A`);
    }
  }
  if (deltaB && match.sessionBId) {
    const sB = getStatsStmt.get(match.sessionBId);
    if (sB) {
      const newB = applyDeltas(sB, deltaB);
      upsertStats.run(newB);
      pushTimeline(match.sessionBId, 'system', `Multiplayer update applied to B`);
    }
  }

  if (end) {
    updateMatch.run({ matchId, endedAt: new Date().toISOString() });
    pushTimeline(match.sessionAId, 'system', `Match ${matchId} ended`);
    pushTimeline(match.sessionBId, 'system', `Match ${matchId} ended`);
  }

  res.json({ ok: true });
});

// Generic health check
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// Start server
app.listen(PORT, () => {
  console.log(`President Sim backend listening on port ${PORT}`);
});