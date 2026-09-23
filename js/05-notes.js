// --- Notebook, backed by Supabase, scoped per clan tag AND per notebook ---
// (a note belongs to exactly one notebook, like a folder — 'General' by
// default; see notes-migration.sql for the schema change this needs).
let notesError = '';

async function loadNotebooks(){
  try{
    const res = await fetch(`${LOCAL_PROXY}/notebooks?clanTag=${encodeURIComponent(state.clanTag)}`);
    if(!res.ok){ state.notebooks = ['General']; return; }
    const body = await res.json();
    state.notebooks = (body.notebooks && body.notebooks.length) ? body.notebooks : ['General'];
    if(!state.notebooks.includes(state.notebook)) state.notebook = state.notebooks[0];
  }catch(e){
    console.warn('[notebooks] load error:', e.message);
    state.notebooks = ['General'];
  }
}

// Every note across every notebook — kept separately from state.notes (which
// is scoped to whichever notebook the panel is currently showing) so the AI
// chat's context always sees the whole notebook archive, not just whatever
// happens to be open in the UI right now.
async function loadAllNotes(){
  try{
    const res = await fetch(`${LOCAL_PROXY}/notes?clanTag=${encodeURIComponent(state.clanTag)}`);
    if(!res.ok){ state.allNotes = []; return; }
    const body = await res.json();
    state.allNotes = body.notes || [];
  }catch(e){
    console.warn('[notes] load-all error:', e.message);
    state.allNotes = [];
  }
}

async function loadNotes(){
  try{
    const res = await fetch(`${LOCAL_PROXY}/notes?clanTag=${encodeURIComponent(state.clanTag)}&notebook=${encodeURIComponent(state.notebook)}`);
    if(!res.ok){
      const body = await res.text().catch(()=>'');
      console.warn('[notes] load failed:', res.status, body);
      notesError = `Couldn't load notes (server said ${res.status}). Check the server terminal for details.`;
      state.notes = [];
      return;
    }
    const body = await res.json();
    state.notes = body.notes || [];
    notesError = '';
  }catch(e){
    console.warn('[notes] load error:', e.message);
    notesError = `Couldn't reach the server to load notes: ${e.message}`;
    state.notes = [];
  }
}

async function switchNotebook(name){
  if(!name || name === state.notebook) return;
  state.notebook = name;
  await loadNotes();
  renderNotes();
}

async function createNotebook(name){
  const trimmed = (name || '').trim();
  if(!trimmed) return;
  // The notebook itself isn't a row anywhere — it only really exists once a
  // note is saved to it — so just switch to it now (adding it to the local
  // list so the picker shows it right away) and let addNote() create the
  // first real row when the person actually writes something.
  if(!state.notebooks.includes(trimmed)) state.notebooks = [...state.notebooks, trimmed].sort((a,b) => a.localeCompare(b));
  await switchNotebook(trimmed);
}

async function addNote(content){
  if(!content || !content.trim()) return;
  try{
    const res = await fetch(`${LOCAL_PROXY}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clanTag: state.clanTag, content: content.trim(), notebook: state.notebook })
    });
    if(res.ok){
      notesError = '';
      await Promise.all([loadNotes(), loadAllNotes(), loadNotebooks()]);
      renderNotes();
    } else {
      const body = await res.text().catch(()=>'');
      console.warn('[notes] save failed:', res.status, body);
      notesError = `Note wasn't saved — server said ${res.status}. Check the server terminal for details.`;
      renderNotes();
    }
  }catch(e){
    console.warn('[notes] save error:', e.message);
    notesError = `Note wasn't saved — couldn't reach the server: ${e.message}`;
    renderNotes();
  }
}

async function deleteNoteById(id){
  try{
    const res = await fetch(`${LOCAL_PROXY}/notes?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    if(!res.ok){ console.warn('[notes] delete failed:', res.status, await res.text().catch(()=>'')); return; }
    state.notes = state.notes.filter(n => n.id !== id);
    state.allNotes = state.allNotes.filter(n => n.id !== id);
    renderNotes();
  }catch(e){ console.warn('[notes] delete error:', e.message); }
}

function renderNotes(){
  const p = $('#notesPanel');
  if(!p) return;
  const rows = state.notes.map(n => {
    const dateLabel = formatDMY(n.created_at);
    return `<div class="note-item">
      <div class="note-text">${esc(n.content)}</div>
      <div class="note-meta">
        <span>${esc(dateLabel)}</span>
        <button class="note-delete" data-id="${esc(n.id)}" title="Delete note">×</button>
      </div>
    </div>`;
  }).join('');
  const notebookOptions = state.notebooks.map(nb => `<option value="${esc(nb)}" ${nb === state.notebook ? 'selected' : ''}>${esc(nb)}</option>`).join('');
  const body = `
    <div class="notebook-picker-row">
      <select id="notebookSelect" title="Switch notebook">${notebookOptions}</select>
      <button class="btn-ghost btn-small" id="newNotebookBtn" title="Create a new notebook">+ New notebook</button>
    </div>
    <div class="note-add-row">
      <textarea id="noteInput" placeholder="Jot something down — a decision, a reminder, a lineup idea..."></textarea>
      <button class="btn btn-small" id="addNoteBtn">Add</button>
    </div>
    ${notesError ? `<div class="save-error">${esc(notesError)}</div>` : ''}
    <div class="note-list">
      ${rows || `<div class="empty">No notes yet in "${esc(state.notebook)}".</div>`}
    </div>
  `;
  p.innerHTML = renderCollapsiblePanel('notesPanel', `Notebook: ${esc(state.notebook)}${state.notes.length ? ` (${state.notes.length})` : ''}`, body);
  $('#notebookSelect').addEventListener('change', (e) => switchNotebook(e.target.value));
  $('#newNotebookBtn').addEventListener('click', () => {
    const name = prompt('Name for the new notebook:');
    if(name) createNotebook(name);
  });
  $('#addNoteBtn').addEventListener('click', () => {
    const input = $('#noteInput');
    addNote(input.value);
    input.value = '';
  });
  document.querySelectorAll('.note-delete').forEach(btn => {
    btn.addEventListener('click', () => deleteNoteById(btn.dataset.id));
  });
}

async function loadAll(isRefresh, opts){
  opts = opts || {};
  const silent = !!opts.silent;
  const btn = isRefresh ? $('#refreshBtn') : $('#connectBtn');
  if(!silent){ btn.disabled = true; setStatus('Connecting to your clan...', 'loading'); }

  try{
    const tagPath = encodeURIComponent(state.clanTag);
    await loadCwlHistory();
    await loadWarHistory();
    await loadCapitalHistory();
    await loadNotebooks();
    await loadNotes();
    await loadAllNotes();
    state.clan = await cocFetch(`/clans/${tagPath}`);

    if(!silent) setStatus('Loading current war...', 'loading');
    try{ state.war = await cocFetch(`/clans/${tagPath}/currentwar`); }
    catch(e){ state.war = null; }

    if(state.war && state.war.state === 'warEnded' && state.war.endTime){
      saveWarToHistory({
        endTime: state.war.endTime,
        opponentName: state.war.opponent.name,
        teamSize: state.war.teamSize,
        result: computeWarResult(state.war.clan, state.war.opponent),
        ourStars: state.war.clan.stars,
        theirStars: state.war.opponent.stars,
        ourDestruction: state.war.clan.destructionPercentage,
        theirDestruction: state.war.opponent.destructionPercentage
      }); // fire-and-forget
    }

    if(state.clan.isWarLogPublic){
      if(!silent) setStatus('Loading war log...', 'loading');
      try{ state.warlog = await cocFetch(`/clans/${tagPath}/warlog?limit=10`); }
      catch(e){ state.warlog = null; }
    } else {
      state.warlog = null;
    }

    // Backfill: every publicly visible past war gets saved too, so the
    // archive keeps growing even if the war log later turns private.
    // CWL aggregate entries (no opponent name) are skipped — they're not
    // real 1v1 wars and their stats are season totals, not war totals.
    (state.warlog?.items || []).forEach(item => {
      if(!item.endTime || !isRegularWarEntry(item)) return;
      saveWarToHistory({
        endTime: item.endTime,
        opponentName: item.opponent?.name,
        teamSize: item.teamSize,
        result: item.result,
        ourStars: item.clan.stars,
        theirStars: item.opponent.stars,
        ourDestruction: item.clan.destructionPercentage,
        theirDestruction: item.opponent.destructionPercentage
      });
    });

    if(!silent) setStatus('Loading capital raids...', 'loading');
    try{ state.capital = await cocFetch(`/clans/${tagPath}/capitalraidseasons?limit=3`); }
    catch(e){ state.capital = null; }

    (state.capital?.items || []).forEach(s => {
      if(!s.startTime) return;
      saveCapitalToHistory({
        startTime: s.startTime,
        totalLoot: s.capitalTotalLoot,
        raidsCompleted: s.raidsCompleted,
        totalAttacks: s.totalAttacks,
        members: mapCapitalMembers(s.members)
      });
    });

    if(!silent) setStatus('Checking for Clan War League...', 'loading');
    try{ state.cwl = await loadCwlLeague(tagPath); }
    catch(e){ state.cwl = null; }
    saveCwlToHistory(state.cwl); // fire-and-forget: don't block dashboard render on the history write

    // Pull every attack currently visible (war/CWL/capital) into Supabase,
    // then reload the merged log from there for display + the AI context.
    await syncAttackLog();
    await loadAttackLog();

    renderAll();
    $('#setupPanel').style.marginBottom = '20px';
    $('#dashboard').hidden = false;
    if(!silent){
      setStatus(`Connected — showing ${state.clan.name}.`, 'ok');
      setSetupCollapsed(true);
    }

    // Switch polling cadence immediately if a war/CWL round/raid just
    // started or just ended, instead of waiting for the next tick.
    lastPollAt = Date.now();
    const nowLive = computeIsLive();
    if(nowLive !== isLiveNow || !pollTimer){
      isLiveNow = nowLive;
      restartPolling();
    } else {
      updatePollIndicator();
    }

    if(!silent) loadTownHallLevels(); // fire-and-forget: dashboard is already usable, TH column backfills as this completes
  }catch(err){
    if(!silent) setStatus(err.message, 'error');
    else console.warn('[poll] silent refresh failed:', err.message);
  }finally{
    if(!silent) btn.disabled = false;
  }
}

function renderAll(){
  renderHero();
  renderWar();
  renderCwl();
  renderMembers();
  renderWarlog();
  renderCapital();
  renderAttackLog();
  renderNotes();
  renderChips();
  renderHistoryView();
  renderSettings();
}

function renderHero(){
  const c = state.clan;
  $('#clanHero').innerHTML = `
    <img src="${esc(c.badgeUrls?.medium || '')}" alt="" />
    <div>
      <div class="name">${esc(c.name)} <span class="tag">${esc(c.tag)}</span></div>
      <div class="desc">${esc(c.description || '')}</div>
    </div>
    <div class="stat-strip">
      <div class="stat"><div class="v">${esc(c.clanLevel)}</div><div class="l">Level</div></div>
      <div class="stat"><div class="v">${esc(c.members)}/50</div><div class="l">Members</div></div>
      <div class="stat"><div class="v">${esc(c.warWinStreak)}</div><div class="l">Win Streak</div></div>
      <div class="stat"><div class="v">${esc(c.warWins ?? '—')}</div><div class="l">War Wins</div></div>
      <div class="stat"><div class="v">${esc(c.clanCapital?.capitalHallLevel ?? '—')}</div><div class="l">Capital Hall</div></div>
    </div>
  `;
}

function renderWar(){
  const p = $('#warPanel');
  const w = state.war;
  if(!w || w.state === 'notInWar'){
    p.innerHTML = renderCollapsiblePanel('warPanel', 'Current War', `<div class="empty">Not currently in a war, or the clan's current-war data is private.</div>`);
    return;
  }
  const stateClass = { inWar:'ws-inWar', warEnded:'ws-warEnded', preparation:'ws-preparation' }[w.state] || 'ws-none';
  const stateLabel = { inWar:'Battle Day', warEnded:'War Ended', preparation:'Preparation Day' }[w.state] || w.state;

  const body = `
    <span class="war-state ${stateClass}">${esc(stateLabel)}</span>
    <div class="war-vs">
      <div class="war-side">
        <div class="clan-name">${esc(w.clan.name)}</div>
        <div class="stars">${esc(w.clan.stars ?? 0)}★</div>
        <div class="destro">${(w.clan.destructionPercentage ?? 0).toFixed(1)}% destruction</div>
      </div>
      <div class="war-mid">vs</div>
      <div class="war-side">
        <div class="clan-name">${esc(w.opponent.name)}</div>
        <div class="stars">${esc(w.opponent.stars ?? 0)}★</div>
        <div class="destro">${(w.opponent.destructionPercentage ?? 0).toFixed(1)}% destruction</div>
      </div>
    </div>
    <div class="empty" style="padding-top:0;">Team size: ${esc(w.teamSize)} · Attacks per member: ${esc(w.attacksPerMember ?? 1)} · Attacks used: ${esc(w.clan.attacks ?? 0)}</div>
  `;
  p.innerHTML = renderCollapsiblePanel('warPanel', 'Current War', body);
}

function renderCwl(){
  const p = $('#cwlPanel');
  const cwl = state.cwl;
  const history = (state.cwlHistory || []).filter(s => !cwl || s.season !== cwl.season);
  let panelTitle = 'Clan War League';

  let html = '';
  if(!cwl || !cwl.rounds || cwl.rounds.length === 0){
    html += `<div class="empty">Not currently in a CWL season (or this season hasn't started pairing wars yet).</div>`;
  } else {
    const stateClass = { inWar:'ws-inWar', warEnded:'ws-warEnded', preparation:'ws-preparation' };
    const stateLabel = { inWar:'Battle Day', warEnded:'War Ended', preparation:'Preparation Day' };
    const rows = cwl.rounds.map(r => {
      const cls = stateClass[r.state] || 'ws-none';
      const label = stateLabel[r.state] || r.state;
      return `
        <div class="war-vs" style="margin-bottom:6px;">
          <div class="war-side">
            <div class="clan-name">${esc(r.us.name)}</div>
            <div class="stars">${esc(r.us.stars)}★</div>
            <div class="destro">${r.us.destruction.toFixed(1)}%</div>
          </div>
          <div class="war-mid">Round ${r.round}<br/><span class="war-state ${cls}" style="margin-top:4px;">${esc(label)}</span></div>
          <div class="war-side">
            <div class="clan-name">${esc(r.opponent.name)}</div>
            <div class="stars">${esc(r.opponent.stars)}★</div>
            <div class="destro">${r.opponent.destruction.toFixed(1)}%</div>
          </div>
        </div>`;
    }).join('<hr style="border-color:#262b34;border-style:solid;margin:10px 0;">');
    panelTitle = `Clan War League — Season ${esc(cwl.season || '')}`;
    html += rows;
  }

  if(history.length > 0){
    const histRows = history.slice().reverse().map(s => {
      const wins = s.rounds.filter(r => cwlRoundResult(r) === 'win').length;
      const losses = s.rounds.filter(r => cwlRoundResult(r) === 'loss').length;
      const ties = s.rounds.filter(r => cwlRoundResult(r) === 'tie').length;
      return `<tr><td class="name">${esc(s.season)}</td><td>${wins}-${losses}-${ties}</td><td>${s.rounds.length}</td></tr>`;
    }).join('');
    html += `
      <h3 style="margin-top:18px;"><span class="dot"></span>Past CWL Seasons</h3>
      <div class="empty" style="padding-top:0;margin-bottom:8px;">Saved automatically on this browser while a season is live — the API itself keeps no history.</div>
      <table>
        <thead><tr><th>Season</th><th>Record (W-L-T)</th><th>Rounds</th></tr></thead>
        <tbody>${histRows}</tbody>
      </table>`;
  }

  p.innerHTML = renderCollapsiblePanel('cwlPanel', panelTitle, html);
}

const ROLE_ORDER = { leader: 0, coLeader: 1, admin: 2, member: 3 };
const ROLE_LABEL = { leader:'Leader', coLeader:'Co-Leader', admin:'Elder', member:'Member' };

const MEMBER_COLUMNS = [
  { key: 'rank', label: '#' },
  { key: 'name', label: 'Name' },
  { key: 'role', label: 'Role' },
  { key: 'th', label: 'TH' },
  { key: 'level', label: 'Lvl' },
  { key: 'trophies', label: 'Trophies' },
  { key: 'donated', label: 'Donated' },
  { key: 'received', label: 'Received' }
];

function memberSortValue(m, key){
  switch(key){
    case 'rank': return m.clanRank;
    case 'name': return m.name.toLowerCase();
    case 'role': return ROLE_ORDER[m.role] ?? 9;
    case 'th': return state.thLevels[m.tag] ?? -1;
    case 'level': return m.expLevel;
    case 'trophies': return m.trophies;
    case 'donated': return m.donations;
    case 'received': return m.donationsReceived;
    default: return 0;
  }
}

function setMemberSort(key){
  if(memberSort.key === key){
    memberSort.dir = memberSort.dir === 'asc' ? 'desc' : 'asc';
  } else {
    memberSort = { key, dir: key === 'name' ? 'asc' : 'desc' };
    if(key === 'rank') memberSort.dir = 'asc';
  }
  state.memberPage = 0;
  renderMembers();
}

async function loadTownHallLevels(force){
  if(thLoading) return;
  thLoading = true;
  const members = state.clan.memberList || [];
  if(force){ for(const m of members) delete state.thLevels[m.tag]; }
  const btn = $('#loadThBtn');
  for(let i = 0; i < members.length; i++){
    const m = members[i];
    if(state.thLevels[m.tag] != null) continue;
    if(btn) btn.textContent = `Loading TH levels... (${i+1}/${members.length})`;
    try{
      const p = await cocFetch(`/players/${encodeURIComponent(m.tag)}`);
      state.thLevels[m.tag] = p.townHallLevel ?? '—';
    }catch(e){
      state.thLevels[m.tag] = '—';
    }
    renderMembers();
  }
  thLoading = false;
  renderMembers();
}

function renderMembers(){
  const p = $('#membersPanel');
  const members = (state.clan.memberList || []).slice();
  if(members.length === 0){ p.innerHTML = renderCollapsiblePanel('membersPanel', 'Members', `<div class="empty">No member data available.</div>`); return; }

  const dirMul = memberSort.dir === 'asc' ? 1 : -1;
  members.sort((a, b) => {
    const va = memberSortValue(a, memberSort.key), vb = memberSortValue(b, memberSort.key);
    if(va < vb) return -1 * dirMul;
    if(va > vb) return 1 * dirMul;
    return 0;
  });

  const pageSize = 10;
  const pageCount = Math.max(1, Math.ceil(members.length / pageSize));
  if(!Number.isInteger(state.memberPage)) state.memberPage = 0;
  state.memberPage = Math.min(Math.max(state.memberPage, 0), pageCount - 1);
  const pageStart = state.memberPage * pageSize;
  const pageMembers = members.slice(pageStart, pageStart + pageSize);
  const headerHtml = MEMBER_COLUMNS.map(col => {
    const arrow = memberSort.key === col.key ? (memberSort.dir === 'asc' ? ' ▲' : ' ▼') : '';
    return `<th class="sortable" data-key="${col.key}">${esc(col.label)}${arrow}</th>`;
  }).join('');

  const allRows = pageMembers.map(m => {
    const roleClass = m.role === 'leader' ? 'role-leader' : (m.role === 'coLeader' ? 'role-coLeader' : '');
    const th = state.thLevels[m.tag] ?? '—';
    return `<tr>
      <td>${esc(m.clanRank)}</td>
      <td class="name">${esc(m.name)}</td>
      <td><span class="role-badge ${roleClass}">${esc(ROLE_LABEL[m.role] || m.role)}</span></td>
      <td>${esc(th)}</td>
      <td>${esc(m.expLevel)}</td>
      <td>${esc(m.trophies)}</td>
      <td>${esc(m.donations)}</td>
      <td>${esc(m.donationsReceived)}</td>
    </tr>`;
  });
  const rowsHtml = allRows.join('');
  const moreHtml = pageCount > 1 ? `<div class="table-pager" aria-label="Member pages"><button class="btn-ghost btn-small" id="membersPrevBtn" ${state.memberPage === 0 ? 'disabled' : ''}>← Previous</button><span class="page-label">Page ${state.memberPage + 1} / ${pageCount}</span><button class="btn-ghost btn-small" id="membersNextBtn" ${state.memberPage === pageCount - 1 ? 'disabled' : ''}>Next →</button></div>` : '';

  const needsThButton = members.some(m => state.thLevels[m.tag] == null);
  const thButtonHtml = `<button class="btn-ghost btn-small" id="loadThBtn">${needsThButton ? 'Load TH levels' : 'Refresh TH levels'}</button>`;

  const body = `
    <div class="table-scroll-x members-table-scroll">
      <table>
        <thead><tr>${headerHtml}</tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
    ${moreHtml}
  `;
  p.innerHTML = renderCollapsiblePanel('membersPanel', `Members (${members.length})`, body, thButtonHtml);

  document.querySelectorAll('#membersPanel th.sortable').forEach(th => {
    th.addEventListener('click', () => setMemberSort(th.dataset.key));
  });
  const prevBtn = $('#membersPrevBtn');
  const nextBtn = $('#membersNextBtn');
  if(prevBtn) prevBtn.addEventListener('click', () => {
    if(state.memberPage > 0){ state.memberPage--; renderMembers(); }
  });
  if(nextBtn) nextBtn.addEventListener('click', () => {
    if(state.memberPage < pageCount - 1){ state.memberPage++; renderMembers(); }
  });

  const tableWrap = p.querySelector('.members-table-scroll');
  if(tableWrap && pageCount > 1){
    let touchStartX = null, touchStartY = null;
    tableWrap.addEventListener('touchstart', e => {
      const t = e.changedTouches[0]; touchStartX = t.clientX; touchStartY = t.clientY;
    }, { passive:true });
    tableWrap.addEventListener('touchend', e => {
      if(touchStartX == null) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - touchStartX, dy = t.clientY - touchStartY;
      touchStartX = null; touchStartY = null;
      if(Math.abs(dx) < 55 || Math.abs(dx) <= Math.abs(dy)) return;
      if(dx < 0 && state.memberPage < pageCount - 1){ state.memberPage++; renderMembers(); }
      else if(dx > 0 && state.memberPage > 0){ state.memberPage--; renderMembers(); }
    }, { passive:true });
  }

  const loadBtn = $('#loadThBtn');
  if(loadBtn) loadBtn.addEventListener('click', () => loadTownHallLevels(!needsThButton));
}

function renderWarlog(){
  const p = $('#warlogPanel');
  const merged = mergedWarList();
  if(merged.length === 0){
    p.innerHTML = renderCollapsiblePanel('warlogPanel', 'War History', `<div class="empty">War log is private, and no wars have been archived yet. Play a war with this dashboard open to start building history.</div>`);
    return;
  }
  const DISPLAY_LIMIT = 25;
  const shown = merged.slice(0, DISPLAY_LIMIT);
  const allRows = shown.map(item => {
    const resClass = item.result === 'win' ? 'result-win' : (item.result === 'lose' ? 'result-lose' : 'result-tie');
    const resLabel = item.result ? item.result.charAt(0).toUpperCase() + item.result.slice(1) : '—';
    const dateLabel = formatDMY(item.endTime);
    return `<tr>
      <td>${esc(dateLabel)}</td>
      <td class="name">${esc(item.opponentName || 'Unknown')}</td>
      <td>${esc(item.teamSize ?? '—')}</td>
      <td>${esc(item.ourStars ?? '—')}★ – ${esc(item.theirStars ?? '—')}★</td>
      <td class="${resClass}">${resLabel}</td>
    </tr>`;
  });
  const { rowsHtml, moreHtml } = limitRows('warlogPanel', allRows, 8);
  const moreNote = merged.length > DISPLAY_LIMIT ? `<div class="empty" style="padding-top:8px;">+${merged.length - DISPLAY_LIMIT} more archived in Supabase — ask the AI about older wars.</div>` : '';
  const body = `
    <div class="empty" style="padding-top:0;margin-bottom:8px;">Showing ${shown.length} of ${merged.length} wars — CoC's live API only keeps the last 10, the rest are archived in Supabase.</div>
    <table>
      <thead><tr><th>Date</th><th>Opponent</th><th>Size</th><th>Stars</th><th>Result</th></tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>
    ${moreHtml}
    ${moreNote}
  `;
  p.innerHTML = renderCollapsiblePanel('warlogPanel', 'War History', body);
}

function renderCapital(){
  const p = $('#capitalPanel');
  const merged = mergedCapitalList();
  if(merged.length === 0){
    p.innerHTML = renderCollapsiblePanel('capitalPanel', 'Capital Raids', `<div class="empty">No raid weekend data available yet.</div>`);
    return;
  }
  const DISPLAY_LIMIT = 12;
  const shown = merged.slice(0, DISPLAY_LIMIT);
  const allRows = shown.map(s => {
    const start = formatDMY(s.startTime);
    return `<tr>
      <td class="name">${esc(start)}</td>
      <td>${(s.totalLoot ?? 0).toLocaleString()}</td>
      <td>${esc(s.raidsCompleted ?? '—')}</td>
      <td>${esc(s.totalAttacks ?? '—')}</td>
    </tr>`;
  });
  const { rowsHtml, moreHtml } = limitRows('capitalPanel', allRows, 6);
  const moreNote = merged.length > DISPLAY_LIMIT ? `<div class="empty" style="padding-top:8px;">+${merged.length - DISPLAY_LIMIT} more archived in Supabase — ask the AI about older weekends.</div>` : '';
  const body = `
    <div class="empty" style="padding-top:0;margin-bottom:8px;">Showing ${shown.length} of ${merged.length} weekends — CoC's API only keeps the last 3, the rest are archived in Supabase.</div>
    <table>
      <thead><tr><th>Weekend</th><th>Total Loot</th><th>Raids Won</th><th>Attacks Used</th></tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>
    ${moreHtml}
    ${moreNote}
  `;
  p.innerHTML = renderCollapsiblePanel('capitalPanel', 'Capital Raid Seasons', body);
}

const ATTACK_CONTEXT_LABEL = { war: 'War', cwl: 'CWL', capital: 'Capital' };

function renderAttackLog(){
  const p = $('#attackLogPanel');
  if(!p) return;
  const log = state.attackLog || [];
  const pollBtn = `<span class="poll-indicator" id="pollIndicator"></span>`;
  if(log.length === 0){
    p.innerHTML = renderCollapsiblePanel(
      'attackLogPanel', 'Attack Log',
      `<div class="empty">No individual attacks recorded yet. This fills in automatically — attacker, target, stars, destruction — while a war, CWL round, or raid weekend is live.</div>`,
      pollBtn
    );
    updatePollIndicator();
    return;
  }
  // Attacker/target here can each be either one of our own members or an
  // opponent, with no other column saying which — underline ours so it's
  // obvious at a glance which side someone is on.
  const ownTags = new Set((state.clan?.memberList || []).map(m => m.tag));
  // The own-member-vs-opponent ambiguity only exists for war/CWL rows —
  // capital raid attacks are always our own member attacking an enemy
  // capital district, so underlining there wouldn't distinguish anything.
  const nameCell = (name, tag, context) => {
    const label = esc(name || tag || 'Unknown');
    return (context !== 'capital' && ownTags.has(tag)) ? `<span class="own-member">${label}</span>` : label;
  };
  const allRows = log.map(a => {
    const starClass = a.stars >= 3 ? 'result-win' : (a.stars <= 0 ? 'result-lose' : 'result-tie');
    return `<tr>
      <td><span class="role-badge">${esc(ATTACK_CONTEXT_LABEL[a.context] || a.context)}</span></td>
      <td class="name">${nameCell(a.attacker_name, a.attacker_tag, a.context)}</td>
      <td>${nameCell(a.defender_name, a.defender_tag, a.context)}</td>
      <td class="${starClass}">${a.stars != null ? esc(a.stars) + '★' : '—'}</td>
      <td>${a.destruction_percent != null ? Number(a.destruction_percent).toFixed(1) + '%' : '—'}</td>
      <td>${esc(formatDMY(a.recorded_at))}</td>
    </tr>`;
  });
  const { rowsHtml, moreHtml } = limitRows('attackLogPanel', allRows, 10);
  const body = `
    <div class="empty" style="padding-top:0;margin-bottom:8px;">${log.length} attacks recorded across war, CWL, and capital raids. In war/CWL rows, <span class="own-member">underlined</span> names are our own members.</div>
    <table>
      <thead><tr><th>Event</th><th>Attacker</th><th>Target</th><th>Stars</th><th>Destruction</th><th>Recorded</th></tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>
    ${moreHtml}
  `;
  p.innerHTML = renderCollapsiblePanel('attackLogPanel', `Attack Log (${log.length})`, body, pollBtn);
  updatePollIndicator();
}

function renderHistoryView(){
  if(!state.clan) return;

  // Full war history — no display cap, this is the dedicated archive view.
  const wars = mergedWarList();
  const warRows = wars.map(item => {
    const resClass = item.result === 'win' ? 'result-win' : (item.result === 'lose' ? 'result-lose' : 'result-tie');
    const resLabel = item.result ? item.result.charAt(0).toUpperCase() + item.result.slice(1) : '—';
    const dateLabel = formatDMY(item.endTime);
    return `<tr>
      <td>${esc(dateLabel)}</td>
      <td class="name">${esc(item.opponentName || 'Unknown')}</td>
      <td>${esc(item.teamSize ?? '—')}</td>
      <td>${esc(item.ourStars ?? '—')}★ – ${esc(item.theirStars ?? '—')}★</td>
      <td class="${resClass}">${resLabel}</td>
    </tr>`;
  }).join('');
  $('#warHistoryFullPanel').innerHTML = renderCollapsiblePanel('warHistoryFullPanel', `War History — ${wars.length} total`, `
    <div class="empty" style="padding-top:0;margin-bottom:8px;">Everything archived in Supabase, oldest and newest included. Grows every time this dashboard sees a war.</div>
    ${wars.length === 0
      ? `<div class="empty">Nothing archived yet.</div>`
      : `<div class="scroll-table"><table>
           <thead><tr><th>Date</th><th>Opponent</th><th>Size</th><th>Stars</th><th>Result</th></tr></thead>
           <tbody>${warRows}</tbody>
         </table></div>`}
  `);

  // Full capital raid history.
  const raids = mergedCapitalList();
  const raidRows = raids.map(s => {
    const start = formatDMY(s.startTime);
    return `<tr>
      <td class="name">${esc(start)}</td>
      <td>${(s.totalLoot ?? 0).toLocaleString()}</td>
      <td>${esc(s.raidsCompleted ?? '—')}</td>
      <td>${esc(s.totalAttacks ?? '—')}</td>
    </tr>`;
  }).join('');
  $('#capitalHistoryFullPanel').innerHTML = renderCollapsiblePanel('capitalHistoryFullPanel', `Capital Raid History — ${raids.length} total`, `
    <div class="empty" style="padding-top:0;margin-bottom:8px;">Every raid weekend archived in Supabase.</div>
    ${raids.length === 0
      ? `<div class="empty">Nothing archived yet.</div>`
      : `<div class="scroll-table"><table>
           <thead><tr><th>Weekend</th><th>Total Loot</th><th>Raids Won</th><th>Attacks Used</th></tr></thead>
           <tbody>${raidRows}</tbody>
         </table></div>`}
  `);

  // Full CWL season history (current season, if live, plus everything archived).
  const cwlSeasons = (state.cwlHistory || []).slice();
  if(state.cwl && state.cwl.season && !cwlSeasons.some(s => s.season === state.cwl.season)){
    cwlSeasons.push({ season: state.cwl.season, rounds: state.cwl.rounds });
  }
  cwlSeasons.sort((a, b) => (b.season || '').localeCompare(a.season || ''));
  const cwlRows = cwlSeasons.map(s => {
    const wins = s.rounds.filter(r => cwlRoundResult(r) === 'win').length;
    const losses = s.rounds.filter(r => cwlRoundResult(r) === 'loss').length;
    const ties = s.rounds.filter(r => cwlRoundResult(r) === 'tie').length;
    return `<tr><td class="name">${esc(s.season)}</td><td>${wins}-${losses}-${ties}</td><td>${s.rounds.length}</td></tr>`;
  }).join('');
  $('#cwlHistoryFullPanel').innerHTML = renderCollapsiblePanel('cwlHistoryFullPanel', `Clan War League History — ${cwlSeasons.length} season(s)`, `
    ${cwlSeasons.length === 0
      ? `<div class="empty">No CWL seasons archived yet.</div>`
      : `<table>
           <thead><tr><th>Season</th><th>Record (W-L-T)</th><th>Rounds</th></tr></thead>
           <tbody>${cwlRows}</tbody>
         </table>`}
  `);
}

function applyHomeSizeControlsVisibility(){
  const controls = $('#homeSizeControls');
  const toggle = $('#homeSizeControlsToggle');
  if(!controls || !toggle) return;
  controls.hidden = homeSizeControlsHidden;
  toggle.textContent = homeSizeControlsHidden ? 'Show sizes' : 'Hide';
  toggle.title = homeSizeControlsHidden ? 'Show Home size controls' : 'Hide Home size controls';
}

function setupHomeSizeControlsVisibility(){
  try{
    homeSizeControlsHidden = localStorage.getItem('warroom_home_size_controls_hidden') === '1';
  }catch(e){}
  $('#homeSizeControlsToggle')?.addEventListener('click',()=>{
    homeSizeControlsHidden = !homeSizeControlsHidden;
    try{
      localStorage.setItem('warroom_home_size_controls_hidden', homeSizeControlsHidden ? '1' : '0');
    }catch(e){}
    applyHomeSizeControlsVisibility();
  });
  applyHomeSizeControlsVisibility();
}

function applyChatSuggestionVisibility(){
  const chips = $('#chips');
  if(!chips) return;
  chips.hidden = chatSuggestionsDismissed;
}

function renderChips(){
  const suggestions = [
    "Who has the lowest donations?",
    "List the opponent's war lineup",
    "Summarize our last 10 wars",
    "Who should we consider kicking?"
  ];
  $('#chips').innerHTML = suggestions.map(s => `<button class="chip">${esc(s)}</button>`).join('');
  applyChatSuggestionVisibility();
  document.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => { $('#chatInput').value = chip.textContent; sendChat(); });
  });
}
