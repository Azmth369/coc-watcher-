// --- Phase 3: give the model tools instead of guessing what to prefetch ---
// Phase 2's findTargetedLookup() above only catches a handful of hand-coded
// patterns (a month name, "first war", "against <opponent>"). These tools
// let the model ask for exactly what it needs for ANY question, by calling
// back into the same full-archive helpers Phase 2 already uses
// (mergedWarList/mergedCapitalList/state.notes/fetchAttacksFor) — nothing
// new is added to the server, and nothing about Phase 0-2 changes.
//
// Wired for both providers now. Sarvam's endpoint (coc-local-proxy.js's
// /sarvam/chat) is a byte-for-byte pass-through proxy — a `tools` field in
// the request and any `tool_calls` in the response travel through it
// untouched. Gemini's shape is structurally different (functionDeclarations/
// functionCall instead of tools/tool_calls), so /gemini/chat's route
// actually translates both ways via lib/geminiProxy.js's callGemini() —
// this page still only ever sends/receives the one OpenAI-style shape
// either way. Tools are only sent when the selected provider opts in via
// AI_PROVIDER_CONFIG's supportsTools flag.
const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'search_war_history',
      description: "Search the clan's COMPLETE archived regular-war history (not just the recent window already included in context) by opponent name and/or a specific month/year. Use this for any war reference that might be older than what's already in context, or that wasn't already caught by a targetedLookup above.",
      parameters: {
        type: 'object',
        properties: {
          opponentContains: { type: 'string', description: 'Case-insensitive substring to match against the opponent clan name. Omit to not filter by opponent.' },
          year: { type: 'integer', description: 'Four-digit year to filter to, e.g. 2026. Omit to search all years.' },
          month: { type: 'integer', description: 'Month number 1-12 to filter to. Omit to search all months.' },
          limit: { type: 'integer', description: 'Max number of matching wars to return, most recent first. Default 20.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_capital_raids',
      description: "Search the clan's COMPLETE archived capital raid weekend history (not just the recent window already included in context) by month/year. Use this for any raid weekend reference that might be older than what's already in context.",
      parameters: {
        type: 'object',
        properties: {
          year: { type: 'integer', description: 'Four-digit year to filter to. Omit to search all years.' },
          month: { type: 'integer', description: 'Month number 1-12 to filter to. Omit to search all months.' },
          limit: { type: 'integer', description: 'Max number of matching raid weekends to return, most recent first. Default 12.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_notes',
      description: "Search every note across every notebook this clan has, using real full-text search on keyword and/or filtered by month/year. Notes are already fully included in context today (across all notebooks), so this mainly helps pin down a specific match once notes get numerous — full-text search here understands word forms and relevance, not just exact substrings.",
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: 'Search terms to look for inside note text (real full-text search, not a plain substring match). Omit to not filter by keyword.' },
          year: { type: 'integer', description: 'Four-digit year the note was created in. Omit to search all years.' },
          month: { type: 'integer', description: 'Month number 1-12 the note was created in. Omit to search all months.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_attack_details',
      description: "Get the full individual-attack breakdown for one specific war, CWL round, or capital raid weekend, identified by its context and contextRef (both given alongside that war/raid wherever it appears in the data — e.g. a war's endTime, a raid's startTime, or a search_war_history/search_capital_raids result). Use this when a question needs attack-by-attack detail for something that only appears as a summary elsewhere.",
      parameters: {
        type: 'object',
        properties: {
          context: { type: 'string', enum: ['war', 'cwl', 'capital'], description: 'Which kind of attack log to fetch.' },
          contextRef: { type: 'string', description: "The war's endTime, the raid's startTime, or the CWL round reference, exactly as it appears elsewhere in the data." }
        },
        required: ['context', 'contextRef']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_attack_log',
      description: "Search the clan's COMPLETE attack archive (every war, CWL round, and capital raid ever recorded — not just the recent window already in context, and not limited to one already-known war/raid the way get_attack_details is) by attacker and/or target name. Use this for \"did we/they ever attack...\", \"has X ever attacked Y\", or any question about a player's attack history that isn't tied to one specific already-identified war or raid.",
      parameters: {
        type: 'object',
        properties: {
          attackerContains: { type: 'string', description: 'Case-insensitive substring to match against the attacking player\'s name. Omit to not filter by attacker.' },
          defenderContains: { type: 'string', description: "Case-insensitive substring to match against the target's name (an opposing player for war/CWL, or a district name for capital raids). Omit to not filter by target." },
          context: { type: 'string', enum: ['war', 'cwl', 'capital'], description: 'Restrict to just one kind of attack. Omit to search across all three.' },
          limit: { type: 'integer', description: 'Max number of matching attacks to return, most recent first. Default 50.' }
        }
      }
    }
  }
];

// Handles both CoC's raw "YYYYMMDDT..." strings and Supabase's ISO timestamps.
function monthYearMatch(dateStr, year, month){
  if(!dateStr) return false;
  const y = dateStr.slice(0, 4);
  const m = /^\d{8}T/.test(dateStr) ? dateStr.slice(4, 6) : dateStr.slice(5, 7);
  if(year && y !== String(year)) return false;
  if(month && m !== String(month).padStart(2, '0')) return false;
  return true;
}

const TOOL_HANDLERS = {
  async search_war_history({ opponentContains, year, month, limit } = {}){
    const needle = (opponentContains || '').toLowerCase();
    const matches = mergedWarList().filter(w =>
      (!needle || (w.opponentName || '').toLowerCase().includes(needle)) &&
      (!year && !month ? true : monthYearMatch(w.endTime, year, month))
    );
    return { totalMatched: matches.length, wars: matches.slice(0, limit || 20) };
  },
  async search_capital_raids({ year, month, limit } = {}){
    const matches = mergedCapitalList().filter(r => (!year && !month) ? true : monthYearMatch(r.startTime, year, month));
    return {
      totalMatched: matches.length,
      raids: matches.slice(0, limit || 12).map(r => ({
        startTime: r.startTime, totalLoot: r.totalLoot, raidsCompleted: r.raidsCompleted, totalAttacks: r.totalAttacks,
        note: "Per-member detail omitted here — call get_attack_details with context:'capital' and this startTime as contextRef for attack-by-attack detail."
      }))
    };
  },
  async search_notes({ keyword, year, month } = {}){
    // Always hits the server, across ALL notebooks — never just whichever
    // notebook the panel happens to have open — using real Postgres
    // full-text search when a keyword is given (see lib/notes.js).
    let matches = [];
    try{
      const url = (keyword && keyword.trim())
        ? `${LOCAL_PROXY}/notes?clanTag=${encodeURIComponent(state.clanTag)}&q=${encodeURIComponent(keyword.trim())}`
        : `${LOCAL_PROXY}/notes?clanTag=${encodeURIComponent(state.clanTag)}`;
      const res = await fetch(url);
      if(res.ok){ const body = await res.json(); matches = body.notes || []; }
    }catch(e){ /* leave matches empty on a network failure */ }
    if(year || month) matches = matches.filter(n => monthYearMatch(n.created_at, year, month));
    return { totalMatched: matches.length, notes: matches.map(n => ({ content: n.content, notebook: n.notebook, createdAt: n.created_at })) };
  },
  async get_attack_details({ context, contextRef } = {}){
    if(!context || !contextRef) return { error: 'context and contextRef are both required.' };
    const rows = await fetchAttacksFor(context, contextRef);
    return {
      context, contextRef, attackCount: rows.length,
      attacks: rows.map(a => ({
        attacker: a.attacker_name || a.attacker_tag, target: a.defender_name || a.defender_tag,
        stars: a.stars, destructionPercent: a.destruction_percent, recordedAt: a.recorded_at
      }))
    };
  },
  async search_attack_log({ attackerContains, defenderContains, context, limit } = {}){
    // Unlike fetchAttacksFor (used by get_attack_details above), this always
    // hits the server — the whole point is searching the COMPLETE archive by
    // player, not whatever happens to already be sitting in state.attackLog
    // (which is itself capped at 500 rows; a real match could be older than
    // that window and simply absent from memory).
    const params = new URLSearchParams({ clanTag: state.clanTag });
    if(attackerContains) params.set('attackerContains', attackerContains);
    if(defenderContains) params.set('defenderContains', defenderContains);
    if(context) params.set('context', context);
    if(limit) params.set('limit', String(limit));
    try{
      const res = await fetch(`${LOCAL_PROXY}/attack-log?${params.toString()}`);
      if(!res.ok) return { error: `Attack log search failed: server said ${res.status}.` };
      const body = await res.json();
      const rows = body.log || [];
      return {
        totalMatched: rows.length,
        attacks: rows.map(a => ({
          context: a.context, contextRef: a.context_ref,
          attacker: a.attacker_name || a.attacker_tag, target: a.defender_name || a.defender_tag,
          stars: a.stars, destructionPercent: a.destruction_percent, recordedAt: a.recorded_at
        }))
      };
    }catch(e){ return { error: `Attack log search failed: ${e.message}` }; }
  }
};

async function buildContext(question){
  const activated = classifyQuestionCategories(question);
  const c = state.clan;
  const members = (c.memberList || []).map(m => ({
    name: m.name, tag: m.tag, role: ROLE_LABEL[m.role] || m.role, level: m.expLevel, trophies: m.trophies,
    donations: m.donations, received: m.donationsReceived, rank: m.clanRank,
    townHallLevel: state.thLevels[m.tag] ?? undefined
  }));

  // LLMs are unreliable at counting items in a list they're also asked to
  // enumerate — the stated count and the actual list frequently disagree
  // even though both were generated from the same correct data. So we
  // count exact, deterministic totals here in JS and hand them over
  // ready-made, rather than asking the model to count on its own.
  const roleCounts = members.reduce((acc, m) => {
    acc[m.role] = (acc[m.role] || 0) + 1;
    return acc;
  }, {});

  let currentWar = null;
  if(state.war && state.war.state !== 'notInWar'){
    const w = state.war;
    const mapWarMembers = (list) => (list || []).map(m => {
      const attacks = m.attacks || [];
      return {
        name: m.name,
        tag: m.tag,
        mapPosition: m.mapPosition,
        townhallLevel: m.townhallLevel,
        attacksUsed: attacks.length,
        starsEarned: attacks.reduce((sum, a) => sum + (a.stars || 0), 0),
        timesAttackedByEnemy: m.opponentAttacks ?? 0
      };
    });
    const ourMembers = mapWarMembers(w.clan.members);
    const zeroAttackMembers = ourMembers.filter(m => m.attacksUsed === 0);

    // CoC's war API only ever lists the teamSize members who were actually
    // selected into this war's roster — it never includes the rest of the
    // clan. So "who wasn't part of this war" can't be answered from
    // ourMembers alone; it has to be a diff against the full current clan
    // roster, matched by tag (names aren't guaranteed unique, tags are).
    const warParticipantTags = new Set((w.clan.members || []).map(m => m.tag).filter(Boolean));
    const notInWarRoster = (c.memberList || []).filter(m => !warParticipantTags.has(m.tag));

    currentWar = {
      state: w.state, teamSize: w.teamSize, attacksPerMember: w.attacksPerMember,
      us: { name: w.clan.name, stars: w.clan.stars, destruction: w.clan.destructionPercentage, attacksUsed: w.clan.attacks },
      opponent: { name: w.opponent.name, stars: w.opponent.stars, destruction: w.opponent.destructionPercentage },
      ourMembers,
      opponentMembers: mapWarMembers(w.opponent.members),
      // Exact, precomputed — don't recount ourMembers by hand for these.
      attackSummary: {
        attacksUsedTotal: ourMembers.reduce((s, m) => s + m.attacksUsed, 0),
        attacksAvailableTotal: w.teamSize * w.attacksPerMember,
        membersWithZeroAttacksCount: zeroAttackMembers.length,
        membersWithZeroAttacks: zeroAttackMembers.map(m => m.name)
      },
      // Exact, precomputed. NOT the same thing as membersWithZeroAttacks above:
      // that's about players who WERE selected for the war but didn't attack;
      // this is about players who were never selected for the war roster at all
      // (relevant when the clan has more members than the war's teamSize).
      rosterSummary: {
        note: "ourMembers/opponentMembers above list only the teamSize players selected for this war. notSelectedForWar below is every current clan member who is NOT in that list, computed by cross-referencing against the current full clan roster.",
        totalCurrentClanMembers: (c.memberList || []).length,
        notSelectedForWarCount: notInWarRoster.length,
        notSelectedForWar: notInWarRoster.map(m => ({ name: m.name, tag: m.tag }))
      }
    };
  }

  // CoC's capital raid API only lists members who attacked at least once —
  // a member who used zero attacks is simply ABSENT from that list, not
  // present with attacksUsed:0. So "who didn't participate" can never be
  // answered by filtering the raid's own member list; it has to be a diff
  // against the full current clan roster instead. That diff is only
  // meaningful for the most recent raid weekend (idx 0) — for older
  // archived ones the roster has likely changed since (departures/joins),
  // so we don't claim a reliable non-participant list for those.
  const currentRoster = (c.memberList || []).map(m => ({ tag: m.tag, name: m.name }));
  const allCapitalRaids = mergedCapitalList();
  // Phase 4: full raw detail for the current calendar month (plus always the
  // single most-recent weekend, even right after a month boundary with
  // nothing new yet, so the roster-diff feature below never silently loses
  // its target) — everything older becomes a compact monthly rollup instead
  // of a hard, ever-more-inadequate item-count cap. See rollupCapitalByMonth.
  const nowMonth = monthKey(new Date().toISOString());
  const currentMonthCapitalRaids = allCapitalRaids.filter((r, idx) => idx === 0 || monthKey(r.startTime) === nowMonth);
  const currentMonthCapitalKeys = new Set(currentMonthCapitalRaids.map(r => r.startTime));
  const capitalMonthlyRollups = rollupCapitalByMonth(allCapitalRaids.filter(r => !currentMonthCapitalKeys.has(r.startTime)));
  const recentCapitalRaids = activated.has('capital')
    ? currentMonthCapitalRaids.map((s, idx) => {
        // A saved raid's members array can end up with the same player's tag
        // appearing twice (e.g. if a snapshot got merged/re-saved mid-raid).
        // Dedupe by tag (keep the last, most up-to-date entry for that tag)
        // BEFORE computing anything, so the member list length, the
        // participant count, and the roster diff below are all guaranteed to
        // agree with each other. Entries with no tag (only possible on very
        // old saved data) are kept as-is and not deduped.
        const rawRaidMembers = s.members || [];
        const dedupedByTag = new Map();
        const untaggedMembers = [];
        rawRaidMembers.forEach(m => {
          if(m && m.tag) dedupedByTag.set(m.tag, m);
          else if(m) untaggedMembers.push(m);
        });
        const raidMembers = [...dedupedByTag.values(), ...untaggedMembers];
        const participantTags = new Set(dedupedByTag.keys());
        const base = {
          startTime: s.startTime,
          totalLoot: s.totalLoot,
          raidsCompleted: s.raidsCompleted,
          totalAttacks: s.totalAttacks,
          members: raidMembers,
          participationSummary: {
            note: "This raid's members list only includes players who attacked at least once — it never contains zero-attack members.",
            participatedAtLeastOnceCount: raidMembers.length
          }
        };
        if(idx === 0){
          const nonParticipants = currentRoster.filter(m => !participantTags.has(m.tag));
          base.participationSummary.totalCurrentClanMembers = currentRoster.length;
          base.participationSummary.didNotParticipateCount = nonParticipants.length;
          base.participationSummary.didNotParticipate = nonParticipants.map(m => ({ name: m.name, tag: m.tag }));
          base.participationSummary.note += " didNotParticipate below is computed by cross-referencing against the CURRENT full clan roster, and is only reliable for this most recent raid weekend.";
        }
        return base;
      })
    // Question didn't look capital/raid-related — skip the per-member
    // rosters (the expensive part) and just give top-level totals, so the
    // model still knows raids happened and roughly how they went, without
    // paying for detail nothing here asked for.
    : currentMonthCapitalRaids.map(s => ({
        startTime: s.startTime, totalLoot: s.totalLoot, raidsCompleted: s.raidsCompleted, totalAttacks: s.totalAttacks,
        note: "Per-member detail omitted as not relevant to this question — ask about capital raids specifically for the full breakdown."
      }));

  const allWars = mergedWarList();
  // Same Phase 4 treatment as capital raids above: current month (plus the
  // single latest war regardless of month) stays full detail; everything
  // older rolls into a compact per-month record instead of a hard cap.
  const currentMonthWars = allWars.filter((w, idx) => idx === 0 || monthKey(w.endTime) === nowMonth);
  const currentMonthWarKeys = new Set(currentMonthWars.map(w => w.endTime));
  const warMonthlyRollups = rollupWarsByMonth(allWars.filter(w => !currentMonthWarKeys.has(w.endTime)));
  const recentWars = activated.has('war')
    ? currentMonthWars.map(w => ({ opponent: w.opponentName, result: w.result, ourStars: w.ourStars, theirStars: w.theirStars, teamSize: w.teamSize, endTime: w.endTime }))
    // Not war-related — a compact record-only summary instead of all of them.
    : (() => {
        const tally = allWars.reduce((acc, w) => { acc[w.result] = (acc[w.result] || 0) + 1; return acc; }, {});
        return {
          summaryOnly: true,
          note: "Individual war-by-war detail omitted as not relevant to this question — ask about wars specifically for the full list.",
          record: { wins: tally.win || 0, losses: tally.lose || 0, ties: tally.tie || 0 },
          mostRecent: allWars[0] ? { opponent: allWars[0].opponentName, result: allWars[0].result, endTime: allWars[0].endTime } : null
        };
      })();

  // recentAttacks pulls from whatever the server's /attack-log GET already
  // returned into state.attackLog — that endpoint itself caps at 500 rows
  // (see lib/attackLog.js), so on a long-running clan this count can be a
  // floor rather than the true grand total. Not fixing that cap here — out
  // of scope for this pass — just not overclaiming precision around it.
  const allAttacks = state.attackLog || [];
  // Only the contexts (war/cwl/capital) this question actually activated —
  // an attack row is only useful alongside the war/CWL/raid it belongs to,
  // so it follows the same gating as those sections above.
  const relevantAttacks = allAttacks.filter(a => activated.has(a.context));
  const recentAttacks = relevantAttacks.slice(0, 150).map(a => ({
    context: a.context, contextRef: a.context_ref,
    attacker: a.attacker_name || a.attacker_tag, target: a.defender_name || a.defender_tag,
    stars: a.stars, destructionPercent: a.destruction_percent, recordedAt: a.recorded_at
  }));

  const cwlActivated = activated.has('cwl');
  const clanWarLeague = state.cwl
    ? (cwlActivated
        ? {
            season: state.cwl.season,
            rounds: state.cwl.rounds.map(r => ({
              round: r.round, state: r.state,
              us: r.us, opponent: r.opponent,
              ourMembers: r.ourMembers
            }))
          }
        // Not CWL-related — record only, no per-round member breakdowns.
        : {
            season: state.cwl.season,
            summaryOnly: true,
            note: "Per-round member detail omitted as not relevant to this question — ask about CWL specifically for the full breakdown.",
            rounds: state.cwl.rounds.map(r => ({ round: r.round, state: r.state, us: { name: r.us?.name, stars: r.us?.stars }, opponent: { name: r.opponent?.name, stars: r.opponent?.stars } }))
          })
    : null;
  const cwlHistoryFull = (state.cwlHistory || []).filter(s => !state.cwl || s.season !== state.cwl.season);
  const cwlHistory = cwlActivated
    ? cwlHistoryFull.map(s => ({
        season: s.season,
        rounds: s.rounds.map(r => ({ round: r.round, us: r.us, opponent: r.opponent, result: cwlRoundResult(r) }))
      }))
    // Not CWL-related — just season-level win/loss records, not every round.
    : cwlHistoryFull.map(s => {
        const tally = s.rounds.reduce((acc, r) => { const res = cwlRoundResult(r); acc[res] = (acc[res] || 0) + 1; return acc; }, {});
        return { season: s.season, record: { wins: tally.win || 0, losses: tally.lose || 0, ties: tally.tie || 0 } };
      });

  const targetedLookup = await findTargetedLookup(question);

  const ctx = {
    clan: { name: c.name, tag: c.tag, level: c.clanLevel, points: c.clanPoints, warWinStreak: c.warWinStreak, warWins: c.warWins, warLosses: c.warLosses, warTies: c.warTies, capitalHallLevel: c.clanCapital?.capitalHallLevel },
    members,
    roleCounts,
    currentWar,
    clanWarLeague,
    cwlHistory,
    // totalXArchived vs xIncludedInContext: when these differ, the array
    // below is only the most recent slice, not the whole history. See the
    // TRUNCATION instruction in the system prompt (sendChat) for how the
    // model is told to use these.
    totalWarsArchived: allWars.length,
    warsIncludedInContext: Array.isArray(recentWars) ? recentWars.length : 0,
    recentWars,
    // Phase 4: aggregate stats for every month NOT already covered above in
    // full detail, newest month first. Cheap regardless of how far back the
    // archive goes — this doesn't grow the way a raw item list would.
    warMonthlyRollups,
    totalCapitalRaidsArchived: allCapitalRaids.length,
    raidsIncludedInContext: recentCapitalRaids.length,
    recentCapitalRaids,
    capitalMonthlyRollups,
    totalAttacksArchived: allAttacks.length,
    attacksIncludedInContext: recentAttacks.length,
    // Relevance filtering (see classifyQuestionCategories above): which of
    // war/cwl/capital got full detail for THIS question. Sections left out
    // of this list still appear above, just as a lighter summary rather
    // than full detail — never fully removed.
    categoriesIncludedInFullDetail: Array.from(activated),
    attacksOmittedByCategoryFilterCount: allAttacks.length - relevantAttacks.length,
    recentAttacks,
    // Present only when the question contained a specific, recognizable
    // reference (a month, an opponent name, "first war"/"first raid") —
    // see findTargetedLookup above. When present, it was searched against
    // the COMPLETE archive, not just the windowed arrays above.
    targetedLookup,
    // state.allNotes is every note across every notebook — not just the one
    // currently open in the panel — so the chat always sees the full
    // notebook archive regardless of what the person happens to be viewing.
    notes: (state.allNotes || []).map(n => ({ content: n.content, notebook: n.notebook, createdAt: n.created_at }))
  };
  return JSON.stringify(ctx);
}

function appendMsg(role, text){
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.textContent = text;
  $('#chatMessages').appendChild(div);
  $('#chatMessages').scrollTop = $('#chatMessages').scrollHeight;
  return div;
}

function formatBlock(raw){
  const lines = raw.split('\n');
  let html = '';
  let inList = false;
  for(const rawLine of lines){
    const line = rawLine.trim();
    if(line.startsWith('- ') || line.startsWith('* ')){
      if(!inList){ html += '<ul>'; inList = true; }
      html += `<li>${line.slice(2)}</li>`;
      continue;
    }
    if(inList){ html += '</ul>'; inList = false; }
    if(line === '') continue;
    html += `<p>${line}</p>`;
  }
  if(inList) html += '</ul>';
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  return html;
}

function formatAiReply(raw){
  // The model is asked (see the system prompt in sendChat) to put any
  // self-checking or corrections inside a <thinking>...</thinking> block
  // before its real answer, instead of thinking out loud in the reply
  // itself. If it did that, pull the block out and render it as a
  // collapsed "Show thinking" dropdown, so only the clean final answer
  // shows by default. Older saved messages have no such block and render
  // exactly as before.
  let thinking = '';
  let answer = raw;
  const match = raw.match(/<thinking>([\s\S]*?)<\/thinking>/i);
  if(match){
    thinking = match[1].trim();
    answer = (raw.slice(0, match.index) + raw.slice(match.index + match[0].length)).trim();
  } else {
    // The reply got cut off before the model closed its <thinking> block
    // (usually hitting the token limit). Never show raw, unfinished
    // reasoning as if it were the answer — hide it behind the dropdown
    // and show a plain, honest message instead.
    const openIdx = raw.search(/<thinking>/i);
    if(openIdx !== -1){
      thinking = raw.slice(openIdx + '<thinking>'.length).trim();
      answer = raw.slice(0, openIdx).trim() ||
        "That answer got cut off while double-checking itself before finishing. Try asking again, or split it into a narrower question.";
    }
  }
  let html = '';
  if(thinking){
    html += `<details class="ai-thinking"><summary>Show thinking</summary><div class="ai-thinking-body">${formatBlock(esc(thinking))}</div></details>`;
  }
  html += formatBlock(esc(answer));
  return html;
}
