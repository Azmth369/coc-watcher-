// --- Persistent chat history, backed by Supabase, scoped per clan tag ---
let chatHistoryError = '';

function setChatSaveError(msg){
  chatHistoryError = msg || '';
  const el = $('#chatSaveError');
  if(!el) return;
  el.textContent = chatHistoryError;
  el.hidden = !chatHistoryError;
}

async function loadConversationList(){
  try{
    const res = await fetch(`${LOCAL_PROXY}/chats?clanTag=${encodeURIComponent(state.clanTag)}`);
    if(!res.ok){
      console.warn('[chat-history] list load failed:', res.status, await res.text().catch(()=>''));
      setChatSaveError(`Couldn't load saved chats (server said ${res.status}). Check the server terminal.`);
      state.conversations = [];
      return;
    }
    const body = await res.json();
    state.conversations = body.conversations || [];
  }catch(e){
    console.warn('[chat-history] list load error:', e.message);
    setChatSaveError(`Couldn't reach the server to load saved chats: ${e.message}`);
    state.conversations = [];
  }
}

async function persistMessage(role, content){
  if(!state.currentConversationId) return;
  try{
    const res = await fetch(`${LOCAL_PROXY}/chat-messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: state.currentConversationId, role, content })
    });
    if(!res.ok){
      console.warn('[chat-history] message save failed:', res.status, await res.text().catch(()=>''));
      setChatSaveError(`This chat isn't being saved — server said ${res.status}. Check the server terminal.`);
    } else {
      setChatSaveError('');
    }
  }catch(e){
    console.warn('[chat-history] message save error:', e.message);
    setChatSaveError(`This chat isn't being saved — couldn't reach the server: ${e.message}`);
  }
}

async function ensureConversation(firstQuestion){
  if(state.currentConversationId) return state.currentConversationId;
  const title = firstQuestion.length > 60 ? firstQuestion.slice(0, 57) + '...' : firstQuestion;
  try{
    const res = await fetch(`${LOCAL_PROXY}/chats`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clanTag: state.clanTag, title })
    });
    if(res.ok){
      const body = await res.json();
      if(body.conversation){
        state.currentConversationId = body.conversation.id;
        state.conversations.unshift(body.conversation);
        setChatSaveError('');
      } else {
        setChatSaveError(`This chat isn't being saved — the server didn't return a conversation.`);
      }
    } else {
      console.warn('[chat-history] create conversation failed:', res.status, await res.text().catch(()=>''));
      setChatSaveError(`This chat isn't being saved — server said ${res.status}. Check the server terminal.`);
    }
  }catch(e){
    console.warn('[chat-history] create conversation error:', e.message);
    setChatSaveError(`This chat isn't being saved — couldn't reach the server: ${e.message}`);
  }
  return state.currentConversationId;
}

function startNewChat(){
  state.currentConversationId = null;
  chatHistory = [];
  chatSuggestionsDismissed = false;
  setChatSaveError('');
  $('#chatMessages').innerHTML = `<div class="msg sys">New chat. Load your clan above if you haven't, then ask away.</div>`;
  applyChatSuggestionVisibility();
  renderChatSidebarList();
}

async function openConversation(id){
  try{
    const res = await fetch(`${LOCAL_PROXY}/chat-messages?conversationId=${encodeURIComponent(id)}`);
    if(!res.ok){
      console.warn('[chat-history] open failed:', res.status, await res.text().catch(()=>''));
      setChatSaveError(`Couldn't open that chat — server said ${res.status}.`);
      return;
    }
    const body = await res.json();
    const messages = body.messages || [];
    state.currentConversationId = id;
    chatSuggestionsDismissed = messages.some(m => m.role === 'user');
    setChatSaveError('');
    chatHistory = [];
    $('#chatMessages').innerHTML = '';
    applyChatSuggestionVisibility();
    messages.forEach(m => {
      if(m.role === 'user'){
        appendMsg('user', m.content);
        chatHistory.push({ role: 'user', content: m.content });
      } else if(m.role === 'assistant'){
        const div = appendMsg('ai', '');
        div.innerHTML = formatAiReply(m.content);
        chatHistory.push({ role: 'assistant', content: m.content });
      }
    });
    if(chatHistory.length > 16) chatHistory = chatHistory.slice(-16);
    if(messages.length === 0){
      $('#chatMessages').innerHTML = `<div class="msg sys">This chat is empty.</div>`;
    }
  }catch(e){
    console.warn('[chat-history] open error:', e.message);
    setChatSaveError(`Couldn't open that chat: ${e.message}`);
  }
  renderChatSidebarList();
}

async function deleteConversationById(id){
  try{
    const res = await fetch(`${LOCAL_PROXY}/chats?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    if(!res.ok){ console.warn('[chat-history] delete failed:', res.status, await res.text().catch(()=>'')); return; }
    state.conversations = state.conversations.filter(c => c.id !== id);
    setPinned(id, false);
    if(state.currentConversationId === id) startNewChat();
    renderChatSidebarList();
  }catch(e){ console.warn('[chat-history] delete error:', e.message); }
}

// --- Pinning: the chats table has no pinned column, so this is tracked
// locally per-browser, scoped by clan tag. Pinned chats float to the top.
function pinnedKey(){ return `warroom_pinned_${state.clanTag || 'default'}`; }
function getPinnedIds(){
  try{ return JSON.parse(localStorage.getItem(pinnedKey()) || '[]'); }catch(e){ return []; }
}
function isPinned(id){ return getPinnedIds().includes(id); }
function setPinned(id, pinned){
  let ids = getPinnedIds();
  if(pinned && !ids.includes(id)) ids.push(id);
  if(!pinned) ids = ids.filter(x => x !== id);
  try{ localStorage.setItem(pinnedKey(), JSON.stringify(ids)); }catch(e){}
}
function togglePinned(id){
  setPinned(id, !isPinned(id));
  renderChatSidebarList();
}

function renderChatSidebarList(){
  const list = $('#chatSidebarList');
  if(!list) return;
  if(chatHistoryError){
    list.innerHTML = `<div class="save-error" style="padding:8px;">${esc(chatHistoryError)}</div>`;
    return;
  }
  if(state.conversations.length === 0){
    list.innerHTML = `<div class="chat-history-empty">No saved chats yet — ask something to start one.</div>`;
    return;
  }
  const pinnedIds = getPinnedIds();
  const pinned = state.conversations.filter(c => pinnedIds.includes(c.id));
  const rest = state.conversations.filter(c => !pinnedIds.includes(c.id));

  const renderItem = (c) => {
    const dateLabel = formatDMY(c.updated_at);
    const activeClass = c.id === state.currentConversationId ? ' active' : '';
    const pinnedNow = isPinned(c.id);
    return `<div class="chat-history-item${activeClass}" data-id="${esc(c.id)}">
      <div style="min-width:0;">
        <div class="ch-title">${esc(c.title || 'New chat')}</div>
        <div class="ch-date">${esc(dateLabel)}</div>
      </div>
      <div class="ch-btns">
        <button class="ch-pin${pinnedNow ? ' pinned' : ''}" data-id="${esc(c.id)}" title="${pinnedNow ? 'Unpin' : 'Pin'} chat">📌</button>
        <button class="ch-delete" data-id="${esc(c.id)}" title="Delete chat">×</button>
      </div>
    </div>`;
  };

  let html = '';
  if(pinned.length){
    html += `<div class="chat-sidebar-section-label">Pinned</div>` + pinned.map(renderItem).join('');
  }
  if(rest.length){
    html += `<div class="chat-sidebar-section-label">Recent</div>` + rest.map(renderItem).join('');
  }
  list.innerHTML = html;

  list.querySelectorAll('.chat-history-item').forEach(item => {
    item.addEventListener('click', (e) => {
      if(e.target.closest('.ch-delete') || e.target.closest('.ch-pin')) return;
      openConversation(item.dataset.id);
    });
  });
  list.querySelectorAll('.ch-delete').forEach(btn => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); deleteConversationById(btn.dataset.id); });
  });
  list.querySelectorAll('.ch-pin').forEach(btn => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); togglePinned(btn.dataset.id); });
  });
}

function closeChatSidebar(){
  $('#chatSidebar').classList.remove('open');
  $('#historyBtn').classList.remove('on');
  $('#historyBtn').textContent = '☰ History';
  $('#historyBtn').title = 'Show chat history';
}

async function toggleChatSidebar(){
  const sidebar = $('#chatSidebar');
  const willOpen = !sidebar.classList.contains('open');
  if(willOpen){
    await loadConversationList();
    renderChatSidebarList();
  }
  sidebar.classList.toggle('open', willOpen);
  $('#historyBtn').classList.toggle('on', willOpen);
  $('#historyBtn').textContent = willOpen ? '× Hide' : '☰ History';
  $('#historyBtn').title = willOpen ? 'Hide chat history' : 'Show chat history';
}

function setChatBusy(busy){
  const btn = $('#chatSend');
  if(!btn) return;
  btn.disabled = false;
  if(busy){ btn.textContent = 'Cancel'; btn.classList.add('chat-cancel-btn'); btn.title = 'Cancel this AI request'; }
  else { btn.textContent = 'Ask'; btn.classList.remove('chat-cancel-btn'); btn.title = 'Ask'; }
}
function cancelChatRequest(){
  chatRequestCancelled = true;
  if(activeChatAbortController){ activeChatAbortController.abort(); activeChatAbortController = null; }
  hideLimitToast();
  setChatBusy(false);
}
$('#chatSend').addEventListener('click', () => { if(activeChatAbortController) cancelChatRequest(); else sendChat(); });
$('#chatInput').addEventListener('keydown', e => {
  if(e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); if(activeChatAbortController) cancelChatRequest(); else sendChat(); }
});

function resizeChatInput(){
  const input = $('#chatInput');
  if(!input) return;
  input.style.height = '42px';
  const nextHeight = Math.min(Math.max(input.scrollHeight, 42), 132);
  input.style.height = nextHeight + 'px';
}
$('#chatInput').addEventListener('input', resizeChatInput);

const chatEmojiBtn = $('#chatEmojiBtn');
const chatEmojiPicker = $('#chatEmojiPicker');
function setEmojiPicker(open){
  if(!chatEmojiPicker || !chatEmojiBtn) return;
  chatEmojiPicker.hidden = !open;
  chatEmojiBtn.classList.toggle('active', open);
}
chatEmojiBtn?.addEventListener('click', e => {
  e.stopPropagation();
  setEmojiPicker(chatEmojiPicker.hidden);
});
chatEmojiPicker?.addEventListener('click', e => {
  const btn = e.target.closest('[data-emoji]');
  if(!btn) return;
  const input = $('#chatInput');
  const emoji = btn.dataset.emoji || '';
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  input.value = input.value.slice(0,start) + emoji + input.value.slice(end);
  input.selectionStart = input.selectionEnd = start + emoji.length;
  resizeChatInput();
  input.focus();
});
document.addEventListener('click', e => {
  if(chatEmojiPicker && !chatEmojiPicker.hidden && !chatEmojiPicker.contains(e.target) && e.target !== chatEmojiBtn){
    setEmojiPicker(false);
  }
});
resizeChatInput();

$('#newChatBtn').addEventListener('click', startNewChat);
$('#historyBtn').addEventListener('click', (e) => { e.stopPropagation(); toggleChatSidebar(); });
$('#closeSidebarBtn').addEventListener('click', closeChatSidebar);

const chatPanelEl = document.querySelector('.chat-panel');
$('#expandChat').addEventListener('click', () => setChatExpanded(!chatPanelEl.classList.contains('expanded')));
$('#chatBackdrop').addEventListener('click', () => setChatExpanded(false));

function setChatExpanded(on){
  const chatHost = document.querySelector('.col-chat');
  if(!chatHost) return;

  if(on){
    if(!chatHostPlaceholder && chatHost.parentNode){
      chatHostPlaceholder = document.createComment('chat-host-placeholder');
      chatHost.parentNode.insertBefore(chatHostPlaceholder, chatHost);
    }
    // Move the host directly under <body>. This deliberately avoids every
    // Home/dashboard containing-block, transform, overflow and grid rule.
    document.body.appendChild(chatHost);
    chatHost.classList.add('chat-host-expanded');
    chatHost.style.display = 'block';
    chatHost.style.width = '100%';
    chatHost.style.height = '0';
    chatHost.style.padding = '0';
    chatHost.style.margin = '0';
  }else{
    if(chatHostPlaceholder && chatHostPlaceholder.parentNode){
      chatHostPlaceholder.parentNode.insertBefore(chatHost, chatHostPlaceholder);
      chatHostPlaceholder.remove();
    }
    chatHostPlaceholder = null;
    chatHost.classList.remove('chat-host-expanded');
    chatHost.style.removeProperty('display');
    chatHost.style.removeProperty('width');
    chatHost.style.removeProperty('height');
    chatHost.style.removeProperty('padding');
    chatHost.style.removeProperty('margin');
  }

  chatPanelEl.classList.toggle('expanded', on);
  $('#chatBackdrop').classList.toggle('visible', on);
  $('#expandChat').textContent = on ? '×' : '⤢';
  $('#expandChat').title = on ? 'Collapse chat' : 'Expand chat';

  if(on){
    setTimeout(() => $('#chatInput')?.focus(), 0);
  }
}

function showLimitToast(message){
  $('#limitToastText').textContent = message;
  $('#limitToast').hidden = false;
}
function hideLimitToast(){
  $('#limitToast').hidden = true;
}
$('#limitToastClose').addEventListener('click', cancelChatRequest);

async function sendChat(){
  const input = $('#chatInput');
  const question = input.value.trim();
  if(!question) return;
  if(!state.clan){ appendMsg('sys', 'Connect your clan first.'); return; }

  if(activeChatAbortController) return;
  hideLimitToast();
  setEmojiPicker(false);
  chatRequestCancelled = false;
  activeChatAbortController = new AbortController();
  const requestSignal = activeChatAbortController.signal;

  // Recommendations are only for an untouched/new conversation. As soon as
  // the user sends the first real question, keep them hidden for this chat.
  // Starting a new chat or opening an empty saved chat resets this state.
  chatSuggestionsDismissed = true;
  applyChatSuggestionVisibility();

  setChatBusy(true);
  appendMsg('user', question);
  input.value = '';
  const thinkingMsg = appendMsg('ai', 'Thinking...');

  try{
    const context = await buildContext(question);
    if(requestSignal.aborted || chatRequestCancelled) throw new DOMException('The AI request was cancelled.', 'AbortError');
    const messages = [
      { role: 'system', content: 'You are a sharp, concise Clash of Clans clan analyst. Answer using the clan data JSON given below and the conversation so far. Use real numbers and names from the data. If the data does not contain what is asked, say so plainly instead of guessing. IMPORTANT: for any count, total, or "how many" question, use the precomputed fields already provided (roleCounts, currentWar.attackSummary, currentWar.rosterSummary, each capital raid\'s participationSummary) instead of counting the raw member/attack arrays yourself — those fields are exact, and a number you calculate by hand from a long list is much more likely to be wrong than one already given to you. Only enumerate the raw arrays for listing/filtering questions that no precomputed field covers, and if you do, make sure any count you state matches the exact number of items you actually listed. Also note: a capital raid\'s "members" array ONLY contains players who attacked at least once — it never lists zero-attack members with a 0, they are simply absent from that array. Never conclude "everyone in the members list participated, so nobody had zero attacks" — that array was never a list of the full clan to begin with. Use the didNotParticipate field (present on the most recent raid only) to answer who had zero attacks. Similarly, currentWar.ourMembers ONLY contains the teamSize players selected for that war — it is never the full clan, so it can never be used to figure out who was left out of the war. Use currentWar.rosterSummary.notSelectedForWar for "who wasn\'t part of the war roster" questions, and keep that distinct from currentWar.attackSummary.membersWithZeroAttacks, which is about selected players who didn\'t attack. FORMATTING: double-check any figures or names against the data BEFORE you start writing your reply. If you do need to work through something or catch yourself about to state a wrong number, do all of that silently inside a single <thinking></thinking> block at the very start of your response, then close the tag and write ONLY the clean, correct, final answer after it — never write "wait", "let me correct that", "actually", or an earlier wrong value outside the thinking block. If no checking is needed, skip the thinking block entirely and just answer directly. Your <thinking> block has a hard budget of 2-3 short sentences — naming which precomputed fields you\'ll use and what you\'re weighing is enough, that is NOT the place to work through each candidate. NEVER re-list, re-type, or manually recount every item in a members/attacks array inside <thinking> to verify a precomputed field, and NEVER walk through candidates one-by-one there either (e.g. for "who should we kick") — reasoning over many members belongs in the visible answer as a short comparison of the few that actually matter, not as an exhaustive pass over everyone inside <thinking>. Going over the thinking budget risks the whole reply being cut off before the real answer is even written, which helps no one. NAMES AND TAGS: every player and the clan itself has a display name and a separate #-tag (e.g. "mazz" vs "#GUL0GUURC") in the data — the tag exists only so you can look someone up unambiguously in the JSON, never to show the person. Refer to players and the clan by their plain name only. Do not write out anyone\'s #tag, and do not append it in parentheses after a name, in any answer — even if the underlying data lists dozens of players with their tags right next to their names. The only exception is if the person explicitly asks for a tag (for example, asking for someones tag directly). CONCISENESS: when asked to identify one player or a small handful (e.g. "who has the lowest donations", "who should we kick"), name just that player (or the tied few, or the requested count) directly — do not list or rank the entire roster to get there. Save full member-by-member breakdowns for when the person actually asks to see everyone (e.g. "list everyone\'s donations" or "rank the whole clan"). TRUNCATION: recentAttacks is capped to only the most recent entries within the activated categories, not the full archive (see totalAttacksArchived/attacksIncludedInContext). Before answering anything attack-level that could plausibly reach further back than what is included, check whether totalAttacksArchived is bigger than attacksIncludedInContext — if so, say plainly you only have the most recent N of M and the answer might fall outside that window, or use get_attack_details/search_attack_log if a tool covers it, rather than answering as if it were complete. recentWars and recentCapitalRaids work differently as of Phase 4: they cover the CURRENT calendar month in full detail (plus always the single most recent war/raid even if nothing has happened yet this month) — see warsIncludedInContext/raidsIncludedInContext for exactly how many that is. Everything from EARLIER months is never simply missing: warMonthlyRollups and capitalMonthlyRollups give an exact aggregate (wins/losses/ties and average stars per month for wars; loot/raids-completed/attacks-used per month for capital) for every prior month, newest first. For a stats or trend question about an old month (\"how did we do in August\", \"are we improving\", \"which month had the most loot\") answer directly from the matching rollup entry — that is exact, not an estimate, and no tool call is needed. Only reach for search_war_history/search_capital_raids/get_attack_details (or targetedLookup, see below) when the question needs a SPECIFIC war/raid\'s individual detail from an old month, not just that month\'s aggregate. An item\'s absence from recentWars/recentCapitalRaids is never proof it did not happen — check the matching month\'s rollup, or the total counts, before concluding that. RELEVANCE FILTERING: to keep prompts smaller, clanWarLeague, cwlHistory, recentWars, and recentCapitalRaids are each given to you at FULL per-item detail only for the categories (war/cwl/capital) that categoriesIncludedInFullDetail lists as relevant to this specific question — categories not in that list still appear, just as a lighter summary (record totals, most-recent-only, or similar) instead of a full breakdown, and are marked with a "summaryOnly" or "note" field saying so. recentAttacks is filtered the same way, and attacksOmittedByCategoryFilterCount tells you how many were left out. This is a simple keyword guess, not a certainty — if the person\'s question turns out to need detail from a category that only got a summary (for example the classifier missed a war-related word, or the question is genuinely about more than one area), say so plainly and answer from the summary\'s totals rather than inventing specifics that were not included, and suggest they ask about that category directly to get the full breakdown. TARGETED LOOKUP: when the question names a specific month, an opponent, or says something like "first war"/"earliest war"/"first raid"/"earliest raid", the app searches the COMPLETE archive for it (not just the windowed arrays above) and includes the result as targetedLookup, with a found: true/false flag. When targetedLookup is present and found is true, treat matchedWars/matchedCapitalRaids/matchedNotes/matchedAttacks inside it as the authoritative, complete answer for that specific reference — prefer it over recentWars/recentCapitalRaids, which may not include it at all. When targetedLookup is present and found is false, the full archive was actually checked and nothing matched — say so plainly and directly (e.g. "I don\'t see a war against that opponent in the archive"), rather than hedging about incomplete data or guessing from the windowed arrays; this is a real negative result, not a truncation gap. When targetedLookup is absent entirely, the question did not contain a reference specific enough to search for directly, so fall back to the TRUNCATION guidance above instead. TOOLS: when tools are available to you, you also have search_war_history, search_capital_raids, search_notes, get_attack_details, and search_attack_log as callable functions that search the COMPLETE archive directly on demand. Call one whenever a question needs a specific war, raid weekend, note, or attack-by-attack detail that is not already covered by the context above or by targetedLookup — for example a date, opponent, or reference targetedLookup did not catch. For a "did we/they ever attack..." or "has X ever attacked Y" style question about a player\'s attack history that is not tied to one already-identified war or raid, use search_attack_log specifically — it searches every attack ever recorded by attacker/target name, not just the recent window already in context or one specific war get_attack_details would need you to already know. Prefer calling a tool over saying you do not have the data, and prefer it over guessing. Do not call a tool for something already fully answerable from the context above; only reach for one when it would actually add information you do not already have.' },
      { role: 'system', content: `Current clan data (JSON):\n${context}` },
      ...chatHistory,
      { role: 'user', content: question }
    ];
    const provider = AI_PROVIDER_CONFIG[aiProvider] || AI_PROVIDER_CONFIG.sarvam;

    // 429/500/502/503/504 are all "temporary, try again" signals — a busy
    // model, a rate limit, or (per the actual Gemini 503 body seen in
    // testing) explicit "high demand, try again later" text. Retrying a
    // couple of times with a short backoff clears most of these without
    // the person needing to manually resend the question.
    const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
    const RETRY_DELAYS_MS = [1200, 2500];

    // The raw error body is often double-wrapped JSON (this server's own
    // {error: "..."} shape, where that string is itself "Gemini API 503:
    // <Gemini's own JSON error>") — rather than parse that nested shape
    // exactly (fragile if a provider's error format shifts slightly), pull
    // the human-readable message out with a regex that works regardless of
    // how deep it's nested, and fall back to a plain status-based message
    // if nothing recognizable is found.
    function friendlyApiErrorMessage(providerLabel, status, bodyText){
      // The body is often double-encoded (an outer JSON string containing an
      // inner error blob as escaped text), so literal "message" won't match
      // directly — it shows up as \"message\". Un-escape first so the same
      // regex catches both a plain and a nested/escaped error body.
      const normalized = bodyText.replace(/\\"/g, '"');
      const msgMatch = normalized.match(/"message"\s*:\s*"([^"]+)"/);
      const statusMatch = normalized.match(/"status"\s*:\s*"([^"]+)"/);
      if(msgMatch){
        const detail = msgMatch[1].replace(/\\n/g, ' ').trim();
        return `${providerLabel} is temporarily unavailable${statusMatch ? ` (${statusMatch[1]})` : ''} — ${detail} Try again in a moment, or switch providers using the dropdown above.`;
      }
      if(RETRYABLE_STATUSES.has(status)){
        return `${providerLabel} is temporarily unavailable (error ${status}) — this is usually a short-lived spike in demand. Try again in a moment, or switch providers using the dropdown above.`;
      }
      return `${providerLabel} API error ${status}: ${bodyText.slice(0, 300)}`;
    }

    async function waitForRetry(ms, signal){
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        const onAbort = () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          reject(new DOMException('The AI request was cancelled.', 'AbortError'));
        };
        signal.addEventListener('abort', onAbort, { once:true });
        if(signal.aborted) onAbort();
      });
    }

    async function fetchProviderWithRetry(url, options, providerLabel){
      let lastStatus, lastBody;
      for(let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++){
        const res = await fetch(url, Object.assign({}, options, { signal: requestSignal }));
        if(res.ok) return res;
        lastStatus = res.status;
        lastBody = await res.text().catch(() => '');
        if(!RETRYABLE_STATUSES.has(res.status) || attempt === RETRY_DELAYS_MS.length) break;
        thinkingMsg.textContent = providerLabel + ' is busy — retrying (' + (attempt + 1) + '/' + RETRY_DELAYS_MS.length + ')...';
        await waitForRetry(RETRY_DELAYS_MS[attempt], requestSignal);
      }
      throw new Error(friendlyApiErrorMessage(providerLabel, lastStatus, lastBody));
    }

    // Phase 3 tool-call round-trip: when the provider supports it and the
    // model asks to call search_war_history/search_capital_raids/search_notes/
    // get_attack_details, run the tool(s) locally, append the results, and
    // ask again — repeating until a final text answer comes back or a small
    // safety cap is hit. For a provider with supportsTools:false, this loop
    // body runs exactly once, identical to how this worked before Phase 3.
    const MAX_TOOL_ROUNDS = 4;
    let choice, msg;
    for(let round = 0; round <= MAX_TOOL_ROUNDS; round++){
      const res = await fetchProviderWithRetry(`${LOCAL_PROXY}${provider.endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign(
          { model: provider.model, temperature: 0.3, max_tokens: 4096, reasoning_effort: null, messages },
          provider.supportsTools ? { tools: TOOL_DEFINITIONS } : {}
        ))
      }, provider.label);
      const data = await res.json();
      choice = data.choices?.[0];
      msg = choice?.message;
      const toolCalls = msg?.tool_calls;

      if(provider.supportsTools && Array.isArray(toolCalls) && toolCalls.length && round < MAX_TOOL_ROUNDS){
        thinkingMsg.textContent = 'Looking that up...';
        messages.push({ role: 'assistant', content: msg.content || null, tool_calls: toolCalls });
        for(const call of toolCalls){
          const fnName = call.function?.name;
          const handler = TOOL_HANDLERS[fnName];
          let result;
          try{
            const args = JSON.parse(call.function?.arguments || '{}');
            result = handler ? await handler(args) : { error: `Unknown tool: ${fnName}` };
          }catch(e){
            result = { error: `Tool call failed: ${e.message}` };
          }
          messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
        }
        continue;
      }
      break;
    }

    const rawAnswer = (msg?.content && msg.content.trim()) || (msg?.reasoning_content && msg.reasoning_content.trim()) || '';

    // The model was told (system prompt above) to wrap any self-checking in
    // <thinking></thinking> before its real answer. If the reply got cut off
    // by the max_tokens cap partway through — either Sarvam says so directly
    // via finish_reason, or (as a fallback, in case it doesn't) the thinking
    // block was opened but never closed — stop right here: don't render the
    // half-finished text as if it were an answer, don't add it to the
    // conversation's memory, and don't save it. Just tell the user plainly.
    const hitLengthCap = choice?.finish_reason === 'length' ||
      (/<thinking>/i.test(rawAnswer) && !/<\/thinking>/i.test(rawAnswer));

    if(hitLengthCap){
      thinkingMsg.remove();
      showLimitToast("This reply hit the response length limit before it finished and was stopped. Nothing from it was saved — try again, or split it into a narrower question.");
      return;
    }

    const answer = rawAnswer || 'The model returned an empty response — try rephrasing the question, or ask something narrower.';
    thinkingMsg.innerHTML = formatAiReply(answer);
    chatHistory.push({ role: 'user', content: question });
    chatHistory.push({ role: 'assistant', content: answer });
    // Keep only the last 8 exchanges so the request doesn't grow unbounded.
    if(chatHistory.length > 16) chatHistory = chatHistory.slice(-16);

    await ensureConversation(question);
    persistMessage('user', question);
    persistMessage('assistant', answer);
  }catch(err){
    if(err?.name === 'AbortError' || chatRequestCancelled){
      thinkingMsg.remove();
      hideLimitToast();
      return;
    }
    if(err instanceof TypeError){
      thinkingMsg.textContent = LOCAL_PROXY ? `Couldn't reach the local relay at ${LOCAL_PROXY}. Make sure "node coc-local-proxy.js" is running in a terminal window.` : `Couldn't reach the server. Make sure it's running.`;
    } else {
      thinkingMsg.textContent = `Couldn't get a response: ${err.message}`;
    }
  }finally{
    activeChatAbortController = null;
    chatRequestCancelled = false;
    setChatBusy(false);
  }
}

