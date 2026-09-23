
const LOCAL_PROXY = ''; // same-origin: works locally (this server serves the page too) and once hosted on Render
const state = { clanTag:null, clan:null, war:null, warlog:null, capital:null, cwl:null, cwlHistory:[], warHistory:[], capitalHistory:[], notes:[], allNotes:[], notebook:'General', notebooks:['General'], thLevels:{}, currentConversationId:null, conversations:[], attackLog:[], memberPage:0 };
let chatHistory = []; // running list of {role, content} for actual conversation memory
let activeChatAbortController = null;
let chatRequestCancelled = false;
let memberSort = { key: 'rank', dir: 'asc' };
let thLoading = false;
let homeSizeControlsHidden = false;
let chatHostPlaceholder = null;

const $ = sel => document.querySelector(sel);
const HOME_TABLE_SIZES = [0.85, 1, 1.15, 1.3];
const HOME_CHAT_SIZES = [560, 680, 800, 900, 1020];
const HOME_CHAT_HEIGHTS = [220, 320, 440, 580];
let homeTableSizeIndex = 1;
let homeChatSizeIndex = 1;
let homeChatHeightIndex = 1;
let chatSuggestionsDismissed = false;

function applyHomeSizing(){
  const dashboard = $('#dashboard');
  if(!dashboard) return;
  const tableScale = HOME_TABLE_SIZES[homeTableSizeIndex];
  const chatWidth = HOME_CHAT_SIZES[homeChatSizeIndex];
  const chatHeight = HOME_CHAT_HEIGHTS[homeChatHeightIndex];
  dashboard.style.setProperty('--home-table-scale', String(tableScale));
  dashboard.style.setProperty('--home-chat-width', chatWidth + 'px');
  dashboard.style.setProperty('--home-chat-height', chatHeight + 'px');
  dashboard.dataset.homeTableSize = String(tableScale);
  const tableValue = $('#homeTableSizeValue');
  const chatValue = $('#homeChatSizeValue');
  const chatHeightValue = $('#homeChatHeightValue');
  if(tableValue) tableValue.textContent = Math.round(tableScale * 100) + '%';
  if(chatValue) chatValue.textContent = Math.round((chatWidth / 680) * 100) + '%';
  if(chatHeightValue) chatHeightValue.textContent = Math.round((chatHeight / 320) * 100) + '%';
  try{
    localStorage.setItem('warroom_home_table_size', String(homeTableSizeIndex));
    localStorage.setItem('warroom_home_chat_size', String(homeChatSizeIndex));
    localStorage.setItem('warroom_home_chat_height', String(homeChatHeightIndex));
  }catch(e){}
}

function setupHomeSizing(){
  try{
    const savedTable = parseInt(localStorage.getItem('warroom_home_table_size'),10);
    const savedChat = parseInt(localStorage.getItem('warroom_home_chat_size'),10);
    const savedChatHeight = parseInt(localStorage.getItem('warroom_home_chat_height'),10);
    if(Number.isInteger(savedTable)) homeTableSizeIndex = Math.min(Math.max(savedTable,0),HOME_TABLE_SIZES.length-1);
    if(Number.isInteger(savedChat)) homeChatSizeIndex = Math.min(Math.max(savedChat,0),HOME_CHAT_SIZES.length-1);
    if(Number.isInteger(savedChatHeight)) homeChatHeightIndex = Math.min(Math.max(savedChatHeight,0),HOME_CHAT_HEIGHTS.length-1);
  }catch(e){}
  $('#homeTableSizeDown')?.addEventListener('click',()=>{
    homeTableSizeIndex = Math.max(0,homeTableSizeIndex-1);
    applyHomeSizing();
  });
  $('#homeTableSizeUp')?.addEventListener('click',()=>{
    homeTableSizeIndex = Math.min(HOME_TABLE_SIZES.length-1,homeTableSizeIndex+1);
    applyHomeSizing();
  });
  $('#homeChatSizeDown')?.addEventListener('click',()=>{
    homeChatSizeIndex = Math.max(0,homeChatSizeIndex-1);
    applyHomeSizing();
  });
  $('#homeChatSizeUp')?.addEventListener('click',()=>{
    homeChatSizeIndex = Math.min(HOME_CHAT_SIZES.length-1,homeChatSizeIndex+1);
    applyHomeSizing();
  });
  $('#homeChatHeightDown')?.addEventListener('click',()=>{
    homeChatHeightIndex = Math.max(0,homeChatHeightIndex-1);
    applyHomeSizing();
  });
  $('#homeChatHeightUp')?.addEventListener('click',()=>{
    homeChatHeightIndex = Math.min(HOME_CHAT_HEIGHTS.length-1,homeChatHeightIndex+1);
    applyHomeSizing();
  });
  applyHomeSizing();
}

const esc = s => (s ?? '').toString().replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// Expands CoC's compact "YYYYMMDDTHHMMSS.000Z" timestamp into a real ISO
// string; passes anything else through unchanged (already-ISO Supabase
// timestamps, etc.).
function toIsoTimestamp(value){
  if(!value) return null;
  if(/^\d{8}T/.test(value)){
    const y = value.slice(0,4), mo = value.slice(4,6), d = value.slice(6,8);
    const hh = value.slice(9,11) || '00', mi = value.slice(11,13) || '00', ss = value.slice(13,15) || '00';
    return `${y}-${mo}-${d}T${hh}:${mi}:${ss}Z`;
  }
  return value;
}

// Parses any timestamp shape down to epoch milliseconds. Used to dedupe the
// same war/raid across sources (live CoC data vs. Supabase-archived data)
// that may represent the identical instant as DIFFERENT strings — e.g. if a
// column is typed timestamptz, Postgres round-trips "20260913T182241.000Z"
// back as "2026-09-13T18:22:41+00:00". Those never string-match, but their
// epoch-ms values do, which is why merges below key on this instead of the
// raw string.
function toEpochMs(value){
  const iso = toIsoTimestamp(value);
  if(!iso) return null;
  const t = new Date(iso).getTime();
  return isNaN(t) ? null : t;
}

// Formats any date-like value as DD/MM/YYYY, converted to India Standard
// Time (Asia/Kolkata, UTC+5:30) regardless of the machine's own timezone.
// Accepts normal ISO strings (Supabase's created_at/updated_at) as well as
// the CoC API's compact "YYYYMMDDTHHMMSS.000Z" timestamps (endTime/startTime)
// — the compact form is expanded into a real ISO string first so its time
// component is actually used in the conversion (skipping it would let dates
// near the UTC/IST day boundary come out a day off).
const IST_DATE_FORMATTER = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric' });
function formatDMY(value){
  const iso = toIsoTimestamp(value);
  if(!iso) return '—';
  const date = new Date(iso);
  if(isNaN(date)) return '—';
  return IST_DATE_FORMATTER.format(date); // en-GB renders as DD/MM/YYYY
}

// --- Phase 4: monthly rollups, so the archive stays cheap to include in
// context as it grows, instead of a fixed item-count cap that eventually
// stops covering "recent" at all (see improvement.md Problem 3). "Current
// month" is IST-based, matching this app's other date handling (see
// IST_DATE_FORMATTER above) rather than the server or browser's own
// timezone, so the boundary lines up with what the person actually sees as
// "this month" here.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
function monthKey(value){
  const ms = toEpochMs(value);
  if(ms == null) return null;
  const d = new Date(ms + IST_OFFSET_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
function monthLabel(key){
  const [y, m] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function rollupWarsByMonth(wars){
  const byMonth = new Map();
  wars.forEach(w => {
    const key = monthKey(w.endTime);
    if(!key) return;
    if(!byMonth.has(key)) byMonth.set(key, { month: key, totalWars: 0, wins: 0, losses: 0, ties: 0, ourStarsSum: 0, theirStarsSum: 0 });
    const agg = byMonth.get(key);
    agg.totalWars++;
    if(w.result === 'win') agg.wins++;
    else if(w.result === 'lose') agg.losses++;
    else if(w.result === 'tie') agg.ties++;
    agg.ourStarsSum += w.ourStars || 0;
    agg.theirStarsSum += w.theirStars || 0;
  });
  return Array.from(byMonth.values())
    .sort((a, b) => b.month.localeCompare(a.month))
    .map(agg => ({
      month: agg.month, monthLabel: monthLabel(agg.month), totalWars: agg.totalWars,
      wins: agg.wins, losses: agg.losses, ties: agg.ties,
      avgOurStars: agg.totalWars ? +(agg.ourStarsSum / agg.totalWars).toFixed(2) : 0,
      avgTheirStars: agg.totalWars ? +(agg.theirStarsSum / agg.totalWars).toFixed(2) : 0
    }));
}

function rollupCapitalByMonth(raids){
  const byMonth = new Map();
  raids.forEach(r => {
    const key = monthKey(r.startTime);
    if(!key) return;
    if(!byMonth.has(key)) byMonth.set(key, { month: key, weekendCount: 0, totalLootSum: 0, raidsCompletedSum: 0, totalAttacksSum: 0 });
    const agg = byMonth.get(key);
    agg.weekendCount++;
    agg.totalLootSum += r.totalLoot || 0;
    agg.raidsCompletedSum += r.raidsCompleted || 0;
    agg.totalAttacksSum += r.totalAttacks || 0;
  });
  return Array.from(byMonth.values())
    .sort((a, b) => b.month.localeCompare(a.month))
    .map(agg => ({
      month: agg.month, monthLabel: monthLabel(agg.month), weekendCount: agg.weekendCount,
      totalLoot: agg.totalLootSum, totalRaidsCompleted: agg.raidsCompletedSum, totalAttacksUsed: agg.totalAttacksSum
    }));
}
