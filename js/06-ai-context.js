// --- Phase 1: lightweight relevance filtering ----------------------------
// A cheap keyword pass so a narrow question doesn't drag in every war,
// every CWL season, every raid weekend, and every attack all at once.
// Deliberately fails OPEN: if nothing matches, or the question doesn't
// clearly point at just one area, MORE gets included, not less — a
// heuristic this simple should never be the reason a real answer goes
// missing. Members, role counts, current war, and notes are always
// included in full regardless of this classification — they're small,
// and too broadly useful to gate behind a keyword guess.
const CONTEXT_KEYWORDS = {
  war: /\b(war|attack(ed|ing|s)?|star|destruction|opponent|enemy|lineup|roster|team ?size)\b/i,
  cwl: /\b(cwl|clan war league|league|round)\b/i,
  capital: /\b(capital|raid|district|obstacle|loot|raid ?weekend)\b/i,
  // Kicking/inactivity/donation questions genuinely depend on cross-category
  // activity, not just the member list (which is always included anyway) —
  // see where this is used below for why it pulls in war+cwl+capital too.
  memberActivity: /\b(kick|inactive|inactivity|remove|removed|promot|demot|donat|activity|particip|role|leader|elder|co-?leader|trophies|town ?hall|th ?level|th\d)\b/i
};

function classifyQuestionCategories(question){
  const q = question || '';
  const activated = new Set();
  if(CONTEXT_KEYWORDS.war.test(q)) activated.add('war');
  if(CONTEXT_KEYWORDS.cwl.test(q)) activated.add('cwl');
  if(CONTEXT_KEYWORDS.capital.test(q)) activated.add('capital');
  if(CONTEXT_KEYWORDS.memberActivity.test(q)){
    activated.add('war'); activated.add('cwl'); activated.add('capital');
  }
  // Fail open: nothing recognized at all -> include everything. A narrow
  // guess here is worse than a slightly bigger prompt.
  if(activated.size === 0){
    activated.add('war'); activated.add('cwl'); activated.add('capital');
  }
  return activated;
}

// --- Phase 2: targeted on-demand lookups for out-of-window data ----------
// Phase 1 above decides which CATEGORIES (war/cwl/capital) get full detail.
// This is different: it looks for a SPECIFIC identifiable reference in the
// question — a month, an opponent's name, "first war" — and searches for
// it directly, regardless of the normal 30-war/12-raid windows.
//
// This works without any new network round-trip for wars, raids, and notes,
// because loadWarHistory()/loadCapitalHistory()/loadNotes() already pull
// the server's COMPLETE archive into state.warHistory/capitalHistory/notes
// (those endpoints have no row cap — only /attack-log does, at 500). So
// mergedWarList()/mergedCapitalList()/state.notes here are already the full
// picture; only per-attack detail for a match older than that 500-row
// window needs an actual live fetch, done lazily below.
const MONTH_NAMES = ['january','february','march','april','may','june','july','august','september','october','november','december'];

function detectTargetedReference(question){
  const q = (question || '').toLowerCase();

  if(/\b(first|earliest|very first)\s+war\b/.test(q)) return { type: 'firstWar' };
  if(/\b(first|earliest|very first)\s+raid\b/.test(q)) return { type: 'firstRaid' };

  for(let i = 0; i < MONTH_NAMES.length; i++){
    const re = new RegExp(`\\b${MONTH_NAMES[i]}\\b(?:\\s+(\\d{4}))?`, 'i');
    const m = q.match(re);
    if(m) return { type: 'month', monthNum: String(i + 1).padStart(2, '0'), year: m[1] || null, monthName: MONTH_NAMES[i] };
  }

  const oppMatch = q.match(/\b(?:against|vs\.?|versus)\s+([a-z0-9][a-z0-9 '\-]{1,30})/i);
  if(oppMatch) return { type: 'opponent', name: oppMatch[1].trim() };

  return null;
}

async function fetchAttacksFor(context, contextRef){
  // Prefer what's already loaded (no network call) — only reach out to the
  // server if this specific war/raid isn't in the already-fetched window.
  const already = (state.attackLog || []).filter(a => a.context === context && a.context_ref === contextRef);
  if(already.length) return already;
  try{
    const res = await fetch(`${LOCAL_PROXY}/attack-log?clanTag=${encodeURIComponent(state.clanTag)}&context=${context}&contextRef=${encodeURIComponent(contextRef)}`);
    if(!res.ok){ console.warn('[targeted-lookup] attack fetch failed:', res.status); return []; }
    const body = await res.json();
    return body.log || [];
  }catch(e){ console.warn('[targeted-lookup] attack fetch error:', e.message); return []; }
}

async function findTargetedLookup(question){
  const ref = detectTargetedReference(question);
  if(!ref) return null;

  const allWarsFull = mergedWarList();
  const allRaidsFull = mergedCapitalList();
  // Full cross-notebook archive, not just whichever notebook the panel
  // currently has open — a note only needs fetching fresh here for the
  // 'month' reference type below, so skip the round-trip otherwise.
  const allNotesFull = ref.type === 'month' ? await (async () => {
    try{
      const res = await fetch(`${LOCAL_PROXY}/notes?clanTag=${encodeURIComponent(state.clanTag)}`);
      if(!res.ok) return state.allNotes || [];
      const body = await res.json();
      return body.notes || [];
    }catch(e){ return state.allNotes || []; }
  })() : [];

  let matchedWars = [], matchedRaids = [], matchedNotes = [], detectedReference = '';

  if(ref.type === 'firstWar'){
    detectedReference = 'first/earliest war on record';
    if(allWarsFull.length) matchedWars = [allWarsFull[allWarsFull.length - 1]];
  } else if(ref.type === 'firstRaid'){
    detectedReference = 'first/earliest capital raid on record';
    if(allRaidsFull.length) matchedRaids = [allRaidsFull[allRaidsFull.length - 1]];
  } else if(ref.type === 'month'){
    const currentYear = new Date().getFullYear();
    const years = ref.year ? [ref.year] : [String(currentYear), String(currentYear - 1)];
    detectedReference = ref.year ? `${ref.monthName} ${ref.year}` : `${ref.monthName} (year not stated — checked ${years.join(' and ')})`;
    matchedWars = allWarsFull.filter(w => w.endTime && years.includes(w.endTime.slice(0, 4)) && w.endTime.slice(4, 6) === ref.monthNum);
    matchedRaids = allRaidsFull.filter(r => r.startTime && years.includes(r.startTime.slice(0, 4)) && r.startTime.slice(4, 6) === ref.monthNum);
    matchedNotes = allNotesFull.filter(n => {
      if(!n.created_at) return false;
      const d = new Date(n.created_at);
      if(isNaN(d)) return false;
      return years.includes(String(d.getFullYear())) && String(d.getMonth() + 1).padStart(2, '0') === ref.monthNum;
    });
  } else if(ref.type === 'opponent'){
    const needle = ref.name.toLowerCase();
    detectedReference = `wars against a name matching "${ref.name}"`;
    matchedWars = allWarsFull.filter(w => (w.opponentName || '').toLowerCase().includes(needle));
    // Capital raid weekends hit several enemy clans each, with no single
    // "opponent" field in our stored shape — opponent search only applies
    // to wars, not raids.
  }

  const found = matchedWars.length > 0 || matchedRaids.length > 0 || matchedNotes.length > 0;

  const attackBatches = await Promise.all([
    ...matchedWars.map(w => fetchAttacksFor('war', w.endTime)),
    ...matchedRaids.map(r => fetchAttacksFor('capital', r.startTime))
  ]);
  const matchedAttacks = attackBatches.flat().map(a => ({
    context: a.context, contextRef: a.context_ref,
    attacker: a.attacker_name || a.attacker_tag, target: a.defender_name || a.defender_tag,
    stars: a.stars, destructionPercent: a.destruction_percent, recordedAt: a.recorded_at
  }));

  return {
    detectedReference, found,
    matchedWars, matchedCapitalRaids: matchedRaids,
    matchedNotes: matchedNotes.map(n => ({ content: n.content, notebook: n.notebook, createdAt: n.created_at })),
    matchedAttacks
  };
}

