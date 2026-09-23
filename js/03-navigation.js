// --- Panel order: hold-and-drag reordering (HTML5 drag-and-drop) ---
// Delegated on the settings panel so this keeps working across every
// renderSettings() re-render, without re-binding listeners each time.
let draggedSectionId = null;
document.addEventListener('dragstart', (e) => {
  const row = e.target.closest('.settings-order-row');
  if(!row) return;
  draggedSectionId = row.dataset.id;
  row.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', draggedSectionId); // Firefox requires data to be set to allow the drag
});
document.addEventListener('dragend', (e) => {
  const row = e.target.closest('.settings-order-row');
  if(row) row.classList.remove('dragging');
  document.querySelectorAll('.settings-order-row.drag-over-top, .settings-order-row.drag-over-bottom')
    .forEach(el => el.classList.remove('drag-over-top', 'drag-over-bottom'));
  draggedSectionId = null;
});
document.addEventListener('dragover', (e) => {
  const row = e.target.closest('.settings-order-row');
  if(!row || !draggedSectionId || row.dataset.id === draggedSectionId) return;
  e.preventDefault(); // required to allow a drop
  e.dataTransfer.dropEffect = 'move';
  const before = (e.clientY - row.getBoundingClientRect().top) < row.offsetHeight / 2;
  row.classList.toggle('drag-over-top', before);
  row.classList.toggle('drag-over-bottom', !before);
});
document.addEventListener('dragleave', (e) => {
  const row = e.target.closest('.settings-order-row');
  if(row) row.classList.remove('drag-over-top', 'drag-over-bottom');
});
document.addEventListener('drop', (e) => {
  const row = e.target.closest('.settings-order-row');
  if(!row || !draggedSectionId) return;
  e.preventDefault();
  const before = (e.clientY - row.getBoundingClientRect().top) < row.offsetHeight / 2;
  reorderSection(draggedSectionId, row.dataset.id, !before);
});

// Apply saved theme/density immediately (before first render) and lay out
// sections in the saved order as soon as the dashboard's markup exists.
document.documentElement.setAttribute('data-theme', localStorage.getItem('warroom_theme') || 'light');
document.body.setAttribute('data-density', localStorage.getItem('warroom_density') || 'normal');
document.body.setAttribute('data-font-size', localStorage.getItem('warroom_font_size') || 'normal');
(function(){
  const fonts = {
    inter: "'Inter',system-ui,-apple-system,sans-serif",
    system: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
    serif: "Georgia,'Times New Roman',serif",
    mono: "'SFMono-Regular',Consolas,'Liberation Mono',monospace"
  };
  const key = localStorage.getItem('warroom_font_family') || 'inter';
  document.body.style.setProperty('--warroom-font-family', fonts[key] || fonts.inter);
})();
document.body.classList.toggle('chat-position-top', (localStorage.getItem('warroom_chat_position') || 'bottom') === 'top');
applySectionOrder();

// --- AI provider switch (Sarvam / Gemini) — persisted like the other local prefs ---
let aiProvider = localStorage.getItem('warroom_ai_provider') || 'sarvam';
const AI_PROVIDER_CONFIG = {
  sarvam: { endpoint: '/sarvam/chat', model: 'sarvam-105b', label: 'Sarvam', supportsTools: true },
  // lib/geminiProxy.js on the server translates our OpenAI-shaped
  // { messages, tools } into Gemini's contents/functionDeclarations shape
  // and translates its functionCall responses back into OpenAI-shaped
  // tool_calls, so this can now be true too.
  gemini: { endpoint: '/gemini/chat', model: 'gemini-3.6-flash', label: 'Gemini', supportsTools: true },
};
$('#aiProviderSelect').value = aiProvider;
$('#aiProviderSelect').addEventListener('change', (e) => {
  aiProvider = e.target.value;
  try{ localStorage.setItem('warroom_ai_provider', aiProvider); }catch(err){}
});

function setStatus(msg, kind){
  const el = $('#statusLine');
  el.textContent = msg || '';
  el.className = 'status-line' + (kind ? ' ' + kind : '');
}

function normalizeTag(raw){
  let t = raw.trim().toUpperCase();
  if(!t.startsWith('#')) t = '#' + t;
  return t;
}

async function cocFetch(path){
  let res;
  try{
    res = await fetch(`${LOCAL_PROXY}/coc${path}`);
  }catch(e){
    throw new Error(LOCAL_PROXY ? `Couldn't reach the local relay at ${LOCAL_PROXY}. Make sure "node coc-local-proxy.js" is running in a terminal window.` : `Couldn't reach the server. Make sure it's running.`);
  }
  if(!res.ok){
    let detail = '';
    try{ detail = (await res.json()).message || ''; }catch(e){}
    if(res.status === 403) throw new Error(`403 Forbidden — check that your CoC API key has 45.79.218.79 whitelisted as its allowed IP. ${detail}`);
    if(res.status === 404) throw new Error(`404 Not found — double check the clan tag. ${detail}`);
    throw new Error(`${res.status} ${res.statusText} ${detail}`);
  }
  return res.json();
}

$('#connectBtn').addEventListener('click', connect);
$('#refreshBtn').addEventListener('click', () => loadAll(true));

// Auto-connect on load if a clan tag is already filled in (e.g. the default).
window.addEventListener('DOMContentLoaded', () => {
  if($('#clanTag').value.trim()) connect();
});

// --- Main navigation ---
// Sidebar items switch the dashboard view instead of scrolling the Home page.
// This changes only visibility/layout; existing data, API, polling, and chat
// state stay in the same DOM nodes.
const DASHBOARD_VIEWS = new Set(['home','chat','members','war','info','capital','attack-log','history','notes','settings']);

function setDashboardView(view){
  if(!DASHBOARD_VIEWS.has(view)) view = 'home';
  const dashboard = $('#dashboard');
  if(!dashboard) return;

  dashboard.dataset.view = view;

  document.querySelectorAll('.nav-item[data-view]').forEach(item => {
    item.classList.toggle('nav-active', item.dataset.view === view);
  });

  const chatPanel = document.querySelector('.chat-panel');
  if(chatPanel && view !== 'chat'){
    if(chatPanel.classList.contains('expanded')) setChatExpanded(false);
    chatPanel.classList.remove('expanded');
    const backdrop = $('#chatBackdrop');
    if(backdrop) backdrop.classList.remove('visible');
    const expandBtn = $('#expandChat');
    if(expandBtn){
      expandBtn.textContent = '⤢';
      expandBtn.title = 'Expand chat';
    }
  }

  dashboard.scrollTop = 0;
}

function openNavSidebar(){
  $('#navSidebar').classList.add('open');
  $('#navBackdrop').classList.add('visible');
}
function closeNavSidebar(){
  $('#navSidebar').classList.remove('open');
  $('#navBackdrop').classList.remove('visible');
}
$('#navMenuBtn').addEventListener('click', () => {
  $('#navSidebar').classList.contains('open') ? closeNavSidebar() : openNavSidebar();
});
$('#navBackdrop').addEventListener('click', closeNavSidebar);
$('#closeNavBtn').addEventListener('click', closeNavSidebar);
document.querySelectorAll('.nav-item[data-view]').forEach(item => {
  item.addEventListener('click', () => {
    setDashboardView(item.dataset.view);
    closeNavSidebar();
  });
});

setupHomeSizing();
setupHomeSizeControlsVisibility();
