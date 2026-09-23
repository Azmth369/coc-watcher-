// --- Draggable divider between the content column and the AI chat pane ---
(function setupSplitResizer(){
  const splitArea = document.querySelector('.split-area');
  const colMain = $('#colMain');
  const resizer = $('#splitResizer');
  let dragging = false;

  function setSplit(mainPct){
    const pct = Math.min(75, Math.max(25, mainPct));
    colMain.style.flex = `0 0 ${pct}%`;
    try{ localStorage.setItem('warroom_split_pct', String(pct)); }catch(e){}
  }

  let savedPct = 50;
  try{ const s = localStorage.getItem('warroom_split_pct'); if(s) savedPct = parseFloat(s); }catch(e){}
  setSplit(savedPct);

  function onMove(clientX){
    const rect = splitArea.getBoundingClientRect();
    setSplit(((clientX - rect.left) / rect.width) * 100);
  }
  resizer.addEventListener('mousedown', () => { dragging = true; resizer.classList.add('dragging'); document.body.style.userSelect = 'none'; });
  window.addEventListener('mousemove', (e) => { if(dragging) onMove(e.clientX); });
  window.addEventListener('mouseup', () => { dragging = false; resizer.classList.remove('dragging'); document.body.style.userSelect = ''; });
  resizer.addEventListener('touchstart', () => { dragging = true; resizer.classList.add('dragging'); }, { passive: true });
  window.addEventListener('touchmove', (e) => { if(dragging && e.touches[0]) onMove(e.touches[0].clientX); }, { passive: true });
  window.addEventListener('touchend', () => { dragging = false; resizer.classList.remove('dragging'); });
})();

async function connect(){
  const clanTagRaw = $('#clanTag').value.trim();

  if(!clanTagRaw){
    setStatus('Enter your clan tag.', 'error');
    return;
  }
  const newTag = normalizeTag(clanTagRaw);
  if(state.clanTag && state.clanTag !== newTag){
    // Switching clans — don't carry over a chat session scoped to the old one.
    startNewChat();
  }
  state.clanTag = newTag;

  await loadAll(false);
}

// --- Live polling: while a war, CWL round, or capital raid weekend is
// actually in progress, keep re-fetching on a short timer so the dashboard
// (and the attack log) update without anyone touching Refresh. When nothing
// is live, back off to an occasional slow check just to notice something
// new starting, so it isn't hammering the CoC API for no reason 24/7.
const DEFAULT_POLL_MS = 30000;
const MIN_POLL_MS = 10000;
const MAX_POLL_MS = 600000;
const IDLE_POLL_MS = 5 * 60 * 1000;

function getPollIntervalMs(){
  let v = parseInt(localStorage.getItem('warroom_poll_interval_ms'), 10);
  if(!v || isNaN(v)) v = DEFAULT_POLL_MS;
  return Math.max(MIN_POLL_MS, Math.min(MAX_POLL_MS, v));
}
function setPollIntervalMs(ms){
  const clamped = Math.max(MIN_POLL_MS, Math.min(MAX_POLL_MS, ms));
  try{ localStorage.setItem('warroom_poll_interval_ms', String(clamped)); }catch(e){}
  restartPolling();
}

function parseCoCTimeToMs(value){
  if(!value || !/^\d{8}T/.test(value)) return NaN;
  const iso = `${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6,8)}T${value.slice(9,11)}:${value.slice(11,13)}:${value.slice(13,15)}Z`;
  return new Date(iso).getTime();
}

function isCapitalRaidLive(raid){
  if(!raid || !raid.startTime || !raid.endTime) return false;
  const now = Date.now();
  const start = parseCoCTimeToMs(raid.startTime);
  const end = parseCoCTimeToMs(raid.endTime);
  if(isNaN(start) || isNaN(end)) return false;
  return now >= start && now <= end;
}

function computeIsLive(){
  const warLive = !!(state.war && state.war.state === 'inWar');
  const cwlLive = !!(state.cwl && state.cwl.rounds && state.cwl.rounds.some(r => r.state === 'inWar'));
  const capitalLive = isCapitalRaidLive(state.capital?.items?.[0]);
  return warLive || cwlLive || capitalLive;
}

let isLiveNow = false;
let pollTimer = null;
let pollPaused = false; // paused while the browser tab is hidden

function currentPollMs(){ return isLiveNow ? getPollIntervalMs() : IDLE_POLL_MS; }

function restartPolling(){
  if(pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  if(!state.clanTag || pollPaused) return;
  pollTimer = setInterval(pollTick, currentPollMs());
  updatePollIndicator();
}

async function pollTick(){
  if(!state.clanTag || document.hidden) return;
  await loadAll(true, { silent: true });
}

document.addEventListener('visibilitychange', () => {
  pollPaused = document.hidden;
  if(!pollPaused && state.clanTag){
    // Catch up immediately on returning to the tab, then resume the timer.
    pollTick();
    restartPolling();
  } else if(pollTimer){
    clearInterval(pollTimer);
    pollTimer = null;
  }
});

let lastPollAt = null;
function updatePollIndicator(){
  const el = $('#pollIndicator');
  if(!el) return;
  const seconds = Math.round(currentPollMs() / 1000);
  const ago = lastPollAt ? Math.max(0, Math.round((Date.now() - lastPollAt) / 1000)) : null;
  const label = isLiveNow ? `Live — refreshing every ${seconds}s` : `Idle — checking every ${seconds >= 60 ? Math.round(seconds/60) + 'm' : seconds + 's'}`;
  el.textContent = ago != null ? `${label} · updated ${ago}s ago` : label;
  el.className = 'poll-indicator' + (isLiveNow ? ' live' : '');
}
setInterval(updatePollIndicator, 5000); // keep the "updated Ns ago" bit ticking even between polls

async function loadCwlLeague(tagPath){
  // CWL isn't exposed via /currentwar — it lives behind its own endpoints:
  //  1) /clans/{tag}/currentwar/leaguegroup gives the round lineup (war tags per round)
  //  2) /clanwarleagues/wars/{warTag} gives the actual war detail for one round
  // The leaguegroup call 404s when the clan isn't currently in a CWL season,
  // which is normal and just means there's nothing to show.
  let group;
  try{
    group = await cocFetch(`/clans/${tagPath}/currentwar/leaguegroup`);
  }catch(e){
    return null;
  }
  if(!group || !group.rounds) return null;

  const ourTag = state.clanTag;
  const rounds = [];

  for(let i = 0; i < group.rounds.length; i++){
    const tags = (group.rounds[i].warTags || []).filter(t => t && t !== '#0');
    if(tags.length === 0) continue; // round not paired/generated yet

    const wars = await Promise.all(
      tags.map(t => cocFetch(`/clanwarleagues/wars/${encodeURIComponent(t)}`).catch(() => null))
    );
    const ourWar = wars.find(w => w && (w.clan?.tag === ourTag || w.opponent?.tag === ourTag));
    if(!ourWar) continue; // our war for this round hasn't been fetched/paired yet

    const us = ourWar.clan?.tag === ourTag ? ourWar.clan : ourWar.opponent;
    const them = ourWar.clan?.tag === ourTag ? ourWar.opponent : ourWar.clan;

    rounds.push({
      round: i + 1,
      state: ourWar.state,
      teamSize: ourWar.teamSize,
      us: { name: us.name, stars: us.stars ?? 0, destruction: us.destructionPercentage ?? 0, attacks: us.attacks ?? 0 },
      opponent: { name: them.name, stars: them.stars ?? 0, destruction: them.destructionPercentage ?? 0 },
      ourMembers: (us.members || []).map(m => ({
        name: m.name,
        mapPosition: m.mapPosition,
        townhallLevel: m.townhallLevel,
        attacksUsed: (m.attacks || []).length,
        starsEarned: (m.attacks || []).reduce((s, a) => s + (a.stars || 0), 0)
      })),
      // Kept only for extractWarAttacks() to pull individual attacks out of —
      // never sent to the AI context or stored in cwlHistory as-is (those
      // build their own, smaller shapes from the fields above).
      rawWar: ourWar
    });
  }

  return { season: group.season, leagueState: group.state, rounds };
}

function cwlRoundResult(r){
  if(r.us.stars !== r.opponent.stars) return r.us.stars > r.opponent.stars ? 'win' : 'loss';
  if(r.us.destruction !== r.opponent.destruction) return r.us.destruction > r.opponent.destruction ? 'win' : 'loss';
  return 'tie';
}

// CWL season history now lives in Supabase, reached through this server's
// /cwl-history route — the browser never talks to Supabase directly, and
// never sees the Supabase URL or keys (those stay server-side only).
async function loadCwlHistory(){
  try{
    const res = await fetch(`${LOCAL_PROXY}/cwl-history?clanTag=${encodeURIComponent(state.clanTag)}`);
    if(!res.ok){ state.cwlHistory = []; return; }
    const body = await res.json();
    state.cwlHistory = (body.history || []).map(h => ({ season: h.season, rounds: h.rounds, savedAt: h.saved_at }));
  }catch(e){
    state.cwlHistory = [];
  }
}

async function saveCwlToHistory(cwl){
  if(!cwl || !cwl.season || !cwl.rounds || cwl.rounds.length === 0) return;
  try{
    await fetch(`${LOCAL_PROXY}/cwl-history`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clanTag: state.clanTag,
        season: cwl.season,
        // rawWar is only kept in-memory for extractWarAttacks() below — it's
        // large (full member/attack detail) and would bloat this history
        // row for no reason, since cwl_seasons only needs the summary shape.
        rounds: cwl.rounds.map(({ rawWar, ...r }) => r)
      })
    });
    // Refresh our local copy so the current season shows up in state.cwlHistory too.
    await loadCwlHistory();
  }catch(e){ /* history save failed — current season still renders from state.cwl */ }
}

function computeWarResult(us, opponent){
  if(us.stars !== opponent.stars) return us.stars > opponent.stars ? 'win' : 'lose';
  if(us.destructionPercentage !== opponent.destructionPercentage) return us.destructionPercentage > opponent.destructionPercentage ? 'win' : 'lose';
  return 'tie';
}

// CoC's own warlog quietly mixes in CWL season-aggregate entries: for these,
// the API blanks out the opponent and result, and reports whole-season
// totals instead of one war's stats (so star counts can look impossibly
// high for the team size). Real 1v1 wars always have an opponent name;
// these don't, so we filter them out of regular war history and let the
// dedicated CWL history (built from the leaguegroup endpoints) cover them.
function isRegularWarEntry(item){
  return !!(item.opponent && item.opponent.name);
}

function mapCapitalMembers(rawMembers){
  return (rawMembers || []).map(m => ({
    tag: m.tag,
    name: m.name,
    attacksUsed: m.attacks,
    attackLimit: (m.attackLimit ?? 0) + (m.bonusAttackLimit ?? 0),
    loot: m.capitalResourcesLooted
  }));
}

// --- Individual attack extraction, for the attack_log table ---
// Pulls every single attack (ours and the opponent's) out of a war-shaped
// object (works for both the regular /currentwar response and a CWL round's
// war, since they're the same shape). Each attack becomes one row tagged
// with a context ('war' or 'cwl') and a contextRef that identifies which
// specific war/round it belongs to, so repeated polls of the same live war
// naturally land in the same bucket.
function buildTagNameLookup(members){
  const map = new Map();
  (members || []).forEach(m => { if(m && m.tag) map.set(m.tag, m.name); });
  return map;
}

function extractWarAttacks(w, context, contextRef){
  if(!w || !w.clan || !w.opponent || !contextRef) return [];
  const ourNames = buildTagNameLookup(w.clan.members);
  const theirNames = buildTagNameLookup(w.opponent.members);
  const out = [];
  (w.clan.members || []).forEach(m => {
    (m.attacks || []).forEach(a => {
      out.push({
        context, contextRef,
        attackerTag: m.tag, attackerName: m.name,
        defenderTag: a.defenderTag, defenderName: theirNames.get(a.defenderTag) || null,
        stars: a.stars, destructionPercent: a.destructionPercentage, attackOrder: a.order
      });
    });
  });
  (w.opponent.members || []).forEach(m => {
    (m.attacks || []).forEach(a => {
      out.push({
        context, contextRef,
        attackerTag: m.tag, attackerName: m.name,
        defenderTag: a.defenderTag, defenderName: ourNames.get(a.defenderTag) || null,
        stars: a.stars, destructionPercent: a.destructionPercentage, attackOrder: a.order
      });
    });
  });
  return out;
}

// Capital raid attacks come from a totally different shape: each entry in
// attackLog is an enemy clan we raided, broken into districts, each with its
// own list of attacks. There's no "defender player" here — the defender is
// a district, so defenderTag/defenderName describe that district instead.
// CoC doesn't number these attacks, so the array index stands in for
// attackOrder (stable enough across polls of the same finished data; a rare
// duplicate row here is harmless).
function extractCapitalAttacks(raidItem, contextRef){
  if(!raidItem || !contextRef) return [];
  const out = [];
  (raidItem.attackLog || []).forEach(enemy => {
    (enemy.districts || []).forEach(d => {
      (d.attacks || []).forEach((a, idx) => {
        out.push({
          context: 'capital', contextRef,
          attackerTag: a.attacker?.tag, attackerName: a.attacker?.name,
          defenderTag: `${enemy.defender?.tag || 'enemy'}:${d.id}`,
          defenderName: `${enemy.defender?.name || 'Enemy capital'} — ${d.name}`,
          stars: a.stars, destructionPercent: a.destructionPercent, attackOrder: idx
        });
      });
    });
  });
  return out;
}

// Gathers every attack currently visible across war/CWL/capital and upserts
// them all in one call — the server's unique constraint + ignoreDuplicates
// means re-posting attacks we already saved is a harmless no-op, so this can
// just be called on every loadAll() (initial connect, manual refresh, and
// every poll tick) without tracking what was already sent.
async function syncAttackLog(){
  if(!state.clanTag) return;
  const batch = [];
  if(state.war && state.war.endTime){
    batch.push(...extractWarAttacks(state.war, 'war', state.war.endTime));
  }
  if(state.cwl && state.cwl.rounds && state.cwl.season){
    state.cwl.rounds.forEach(r => {
      if(r.rawWar){
        batch.push(...extractWarAttacks(r.rawWar, 'cwl', `${state.cwl.season}:R${r.round}`));
      }
    });
  }
  const latestRaid = state.capital?.items?.[0];
  if(latestRaid && latestRaid.startTime){
    batch.push(...extractCapitalAttacks(latestRaid, latestRaid.startTime));
  }
  if(batch.length === 0) return;
  try{
    const res = await fetch(`${LOCAL_PROXY}/attack-log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clanTag: state.clanTag, attacks: batch })
    });
    if(!res.ok) console.warn('[attack-log] save failed:', res.status, await res.text().catch(()=>''));
  }catch(e){ console.warn('[attack-log] save error:', e.message); }
}

async function loadAttackLog(){
  if(!state.clanTag){ state.attackLog = []; return; }
  try{
    const res = await fetch(`${LOCAL_PROXY}/attack-log?clanTag=${encodeURIComponent(state.clanTag)}`);
    if(!res.ok){
      console.warn('[attack-log] load failed:', res.status, await res.text().catch(()=>''));
      state.attackLog = [];
      return;
    }
    const body = await res.json();
    state.attackLog = body.log || [];
  }catch(e){
    console.warn('[attack-log] load error:', e.message);
    state.attackLog = [];
  }
}

// Regular war history now lives in Supabase too, reached through this
// server's /war-history route, same pattern as CWL history above. CoC's
// own war log only keeps the last 10 wars, so this is what lets the
// archive grow past that over time.
async function loadWarHistory(){
  try{
    const res = await fetch(`${LOCAL_PROXY}/war-history?clanTag=${encodeURIComponent(state.clanTag)}`);
    if(!res.ok){
      console.warn('[war-history] load failed:', res.status, await res.text().catch(()=>'')); 
      state.warHistory = []; return;
    }
    const body = await res.json();
    state.warHistory = body.history || [];
  }catch(e){
    console.warn('[war-history] load error:', e.message);
    state.warHistory = [];
  }
}

async function saveWarToHistory(war){
  if(!war || !war.endTime) return;
  try{
    const res = await fetch(`${LOCAL_PROXY}/war-history`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clanTag: state.clanTag, ...war })
    });
    if(!res.ok) console.warn('[war-history] save failed:', res.status, await res.text().catch(()=>''));
  }catch(e){ console.warn('[war-history] save error:', e.message); }
}

function mergedWarList(){
  const map = new Map();
  (state.warlog?.items || []).forEach(item => {
    if(!item.endTime || !isRegularWarEntry(item)) return;
    const key = toEpochMs(item.endTime);
    if(key == null) return;
    map.set(key, {
      endTime: item.endTime, opponentName: item.opponent?.name || 'Unknown',
      teamSize: item.teamSize, result: item.result,
      ourStars: item.clan.stars, theirStars: item.opponent.stars
    });
  });
  if(state.war && state.war.state === 'warEnded' && state.war.endTime && isRegularWarEntry(state.war)){
    const w = state.war;
    const key = toEpochMs(w.endTime);
    if(key != null) map.set(key, {
      endTime: w.endTime, opponentName: w.opponent.name, teamSize: w.teamSize,
      result: computeWarResult(w.clan, w.opponent), ourStars: w.clan.stars, theirStars: w.opponent.stars
    });
  }
  (state.warHistory || []).forEach(h => {
    // Defensive: also drop any already-archived rows saved before this filter existed.
    if(!h.end_time || !h.opponent_name) return;
    const key = toEpochMs(h.end_time);
    if(key == null || map.has(key)) return;
    map.set(key, {
      endTime: h.end_time, opponentName: h.opponent_name || 'Unknown',
      teamSize: h.team_size, result: h.result,
      ourStars: h.our_stars, theirStars: h.their_stars
    });
  });
  return Array.from(map.values()).sort((a, b) => (toEpochMs(b.endTime) || 0) - (toEpochMs(a.endTime) || 0));
}

// Capital raid history — same idea. CoC's API only keeps the last few
// weekends, so anything older only exists because we saved it here.
async function loadCapitalHistory(){
  try{
    const res = await fetch(`${LOCAL_PROXY}/capital-history?clanTag=${encodeURIComponent(state.clanTag)}`);
    if(!res.ok){
      console.warn('[capital-history] load failed:', res.status, await res.text().catch(()=>''));
      state.capitalHistory = []; return;
    }
    const body = await res.json();
    state.capitalHistory = body.history || [];
  }catch(e){
    console.warn('[capital-history] load error:', e.message);
    state.capitalHistory = [];
  }
}

async function saveCapitalToHistory(season){
  if(!season || !season.startTime) return;
  try{
    const res = await fetch(`${LOCAL_PROXY}/capital-history`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clanTag: state.clanTag, ...season })
    });
    if(!res.ok) console.warn('[capital-history] save failed:', res.status, await res.text().catch(()=>''));
  }catch(e){ console.warn('[capital-history] save error:', e.message); }
}

function mergedCapitalList(){
  const map = new Map();
  (state.capital?.items || []).forEach(s => {
    if(!s.startTime) return;
    const key = toEpochMs(s.startTime);
    if(key == null) return;
    map.set(key, {
      startTime: s.startTime, totalLoot: s.capitalTotalLoot,
      raidsCompleted: s.raidsCompleted, totalAttacks: s.totalAttacks,
      members: mapCapitalMembers(s.members)
    });
  });
  (state.capitalHistory || []).forEach(h => {
    if(!h.start_time) return;
    const key = toEpochMs(h.start_time);
    if(key == null || map.has(key)) return;
    map.set(key, {
      startTime: h.start_time, totalLoot: h.total_loot,
      raidsCompleted: h.raids_completed, totalAttacks: h.total_attacks,
      members: h.members || []
    });
  });
  return Array.from(map.values()).sort((a, b) => (toEpochMs(b.startTime) || 0) - (toEpochMs(a.startTime) || 0));
}
