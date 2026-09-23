// --- Panel collapse state, persisted locally so the layout stays how you left it ---
const PANEL_TITLES = {
  notesPanel: 'Notebook', warPanel: 'Current War', cwlPanel: 'Clan War League',
  membersPanel: 'Members', warlogPanel: 'War History', capitalPanel: 'Capital Raid Seasons',
  attackLogPanel: 'Attack Log',
  warHistoryFullPanel: 'War History (Full)', capitalHistoryFullPanel: 'Capital Raid History (Full)',
  cwlHistoryFullPanel: 'Clan War League History (Full)', settingsPanel: 'Settings'
};
let collapsedPanels = {};
try{ collapsedPanels = JSON.parse(localStorage.getItem('warroom_collapsed') || '{}'); }catch(e){ collapsedPanels = {}; }
function isPanelCollapsed(id){ return !!collapsedPanels[id]; }
function setPanelCollapsed(id, collapsed){
  collapsedPanels[id] = collapsed;
  try{ localStorage.setItem('warroom_collapsed', JSON.stringify(collapsedPanels)); }catch(e){}
}
function togglePanelCollapse(id){
  setPanelCollapsed(id, !isPanelCollapsed(id));
  renderAll();
}
// Builds a standard panel header with a Hide/Show toggle. Render functions
// pass their body HTML and get back the full panel innerHTML, already
// respecting the saved collapsed state.
function renderCollapsiblePanel(id, titleHtml, bodyHtml, extraHeaderBtnsHtml){
  const collapsed = isPanelCollapsed(id);
  return `
    <div class="panel-header-row">
      <h3><span class="dot"></span>${titleHtml}</h3>
      <div class="panel-header-btns">
        ${extraHeaderBtnsHtml || ''}
        <button class="btn-ghost btn-small collapse-toggle" data-panel="${id}">${collapsed ? 'Show' : 'Hide'}</button>
      </div>
    </div>
    <div class="panel-body" ${collapsed ? 'hidden' : ''}>${bodyHtml}</div>
  `;
}
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.collapse-toggle');
  if(btn){ togglePanelCollapse(btn.dataset.panel); }
});
$('#collapseAllBtn').addEventListener('click', () => {
  const anyExpanded = Object.keys(PANEL_TITLES).some(id => !isPanelCollapsed(id));
  Object.keys(PANEL_TITLES).forEach(id => setPanelCollapsed(id, anyExpanded));
  renderAll();
});

// --- Row-limiting for long tables ("show less"), persisted locally ---
let expandedTables = {};
try{ expandedTables = JSON.parse(localStorage.getItem('warroom_expanded_tables') || '{}'); }catch(e){ expandedTables = {}; }
function isTableExpanded(id){ return !!expandedTables[id]; }
function toggleTableExpanded(id){
  expandedTables[id] = !expandedTables[id];
  try{ localStorage.setItem('warroom_expanded_tables', JSON.stringify(expandedTables)); }catch(e){}
  renderAll();
}
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.table-expand-toggle');
  if(btn){ toggleTableExpanded(btn.dataset.table); }
});
// rows: array of already-built <tr> html strings. Returns { rowsHtml, moreHtml }.
function limitRows(id, rows, defaultLimit){
  const expanded = isTableExpanded(id);
  const shown = expanded ? rows : rows.slice(0, defaultLimit);
  let moreHtml = '';
  if(rows.length > defaultLimit){
    moreHtml = `<div class="table-more-row"><button class="btn-ghost btn-small table-expand-toggle" data-table="${id}">${expanded ? 'Show less' : `Show all ${rows.length}`}</button></div>`;
  }
  return { rowsHtml: shown.join(''), moreHtml };
}

// --- Setup ("Connect your clan") panel collapse, same pattern as panel collapse above ---
let setupCollapsed = localStorage.getItem('warroom_setup_collapsed') === '1';
function applySetupCollapsed(){
  $('#setupBody').hidden = setupCollapsed;
  $('#setupPanel').classList.toggle('is-collapsed', setupCollapsed);
  $('#setupToggleBtn').textContent = setupCollapsed ? 'Show' : 'Hide';
}
function setSetupCollapsed(collapsed){
  setupCollapsed = collapsed;
  try{ localStorage.setItem('warroom_setup_collapsed', collapsed ? '1' : '0'); }catch(e){}
  applySetupCollapsed();
}
$('#setupToggleBtn').addEventListener('click', () => setSetupCollapsed(!setupCollapsed));
applySetupCollapsed();

// --- Settings: theme, table density, and section order — all local prefs, same pattern as above ---
const SECTION_LABELS = {
  secSummary: 'Clan Summary Details', secWar: 'Ongoing War Result', secInfo: 'Clan Info',
  secCapital: 'Ongoing Capital Raid', secAttackLog: 'Live Attack Log', secHistory: 'Full History', secNotes: 'Notes'
};
const DEFAULT_SECTION_ORDER = ['secSummary', 'secWar', 'secInfo', 'secCapital', 'secAttackLog', 'secHistory', 'secNotes'];
let sectionOrder = DEFAULT_SECTION_ORDER.slice();
try{
  const saved = JSON.parse(localStorage.getItem('warroom_section_order') || 'null');
  // Only trust a saved order if it's the same set of sections this version knows about —
  // guards against a stale order from an older file version breaking the layout.
  if(Array.isArray(saved) && saved.length === DEFAULT_SECTION_ORDER.length && DEFAULT_SECTION_ORDER.every(id => saved.includes(id))){
    sectionOrder = saved;
  }
}catch(e){ sectionOrder = DEFAULT_SECTION_ORDER.slice(); }

function applySectionOrder(){
  const colMain = $('#colMain');
  if(!colMain) return;
  const settings = document.getElementById('secSettings');
  sectionOrder.forEach(id => {
    const el = document.getElementById(id);
    if(el) colMain.appendChild(el);
  });
  // Settings always stays last, right below Notes by default, regardless of reordering above.
  if(settings) colMain.appendChild(settings);
}

function reorderSection(draggedId, targetId, placeAfter){
  const from = sectionOrder.indexOf(draggedId);
  if(from === -1 || draggedId === targetId) return;
  sectionOrder.splice(from, 1);
  let to = sectionOrder.indexOf(targetId);
  if(to === -1) return;
  if(placeAfter) to += 1;
  sectionOrder.splice(to, 0, draggedId);
  try{ localStorage.setItem('warroom_section_order', JSON.stringify(sectionOrder)); }catch(e){}
  applySectionOrder();
  renderSettings();
}

function setTheme(theme){
  document.documentElement.setAttribute('data-theme', theme);
  try{ localStorage.setItem('warroom_theme', theme); }catch(e){}
  renderSettings();
}

function setDensity(density){
  document.body.setAttribute('data-density', density);
  try{ localStorage.setItem('warroom_density', density); }catch(e){}
  renderSettings();
}

function setFontSize(size){
  const allowed = ['small','normal','large','xlarge'];
  const value = allowed.includes(size) ? size : 'normal';
  document.body.setAttribute('data-font-size', value);
  try{ localStorage.setItem('warroom_font_size', value); }catch(e){}
  renderSettings();
}

function setFontFamily(family){
  const fonts = {
    inter: "'Inter',system-ui,-apple-system,sans-serif",
    system: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
    serif: "Georgia,'Times New Roman',serif",
    mono: "'SFMono-Regular',Consolas,'Liberation Mono',monospace"
  };
  const value = Object.prototype.hasOwnProperty.call(fonts, family) ? family : 'inter';
  document.body.style.setProperty('--warroom-font-family', fonts[value]);
  try{ localStorage.setItem('warroom_font_family', value); }catch(e){}
  renderSettings();
}


function setChatPosition(position){
  document.body.classList.toggle('chat-position-top', position === 'top');
  try{ localStorage.setItem('warroom_chat_position', position); }catch(e){}
  renderSettings();
}

function renderSettings(){
  const p = $('#settingsPanel');
  if(!p) return;
  const theme = localStorage.getItem('warroom_theme') || 'light';
  const density = localStorage.getItem('warroom_density') || 'normal';
  const fontSize = localStorage.getItem('warroom_font_size') || 'normal';
  const fontFamily = localStorage.getItem('warroom_font_family') || 'inter';

  const themeRow = `
    <div class="settings-row">
      <div class="settings-label">Theme</div>
      <div class="settings-btns">
        <button class="btn-ghost btn-small settings-theme-btn${theme === 'dark' ? ' active' : ''}" data-theme="dark">Dark</button>
        <button class="btn-ghost btn-small settings-theme-btn${theme === 'light' ? ' active' : ''}" data-theme="light">Light</button>
      </div>
    </div>`;

  const densityRow = `
    <div class="settings-row">
      <div class="settings-label">Table size</div>
      <div class="settings-btns">
        <button class="btn-ghost btn-small settings-density-btn${density === 'compact' ? ' active' : ''}" data-density="compact">Compact</button>
        <button class="btn-ghost btn-small settings-density-btn${density === 'normal' ? ' active' : ''}" data-density="normal">Normal</button>
        <button class="btn-ghost btn-small settings-density-btn${density === 'comfortable' ? ' active' : ''}" data-density="comfortable">Comfortable</button>
      </div>
    </div>`;

  const fontSizeRow = `
    <div class="settings-row">
      <div class="settings-label">Font size</div>
      <div class="settings-btns">
        <button class="btn-ghost btn-small settings-fontsize-btn${fontSize === 'small' ? ' active' : ''}" data-fontsize="small">Small</button>
        <button class="btn-ghost btn-small settings-fontsize-btn${fontSize === 'normal' ? ' active' : ''}" data-fontsize="normal">Normal</button>
        <button class="btn-ghost btn-small settings-fontsize-btn${fontSize === 'large' ? ' active' : ''}" data-fontsize="large">Large</button>
        <button class="btn-ghost btn-small settings-fontsize-btn${fontSize === 'xlarge' ? ' active' : ''}" data-fontsize="xlarge">Extra large</button>
      </div>
    </div>`;

  const fontFamilyRow = `
    <div class="settings-row">
      <div class="settings-label">Font style</div>
      <div class="settings-btns">
        <select id="fontFamilySelect" class="settings-font-select">
          <option value="inter" ${fontFamily === 'inter' ? 'selected' : ''}>Inter</option>
          <option value="system" ${fontFamily === 'system' ? 'selected' : ''}>System</option>
          <option value="serif" ${fontFamily === 'serif' ? 'selected' : ''}>Serif</option>
          <option value="mono" ${fontFamily === 'mono' ? 'selected' : ''}>Monospace</option>
        </select>
      </div>
    </div>`;

  const pollSeconds = Math.round(getPollIntervalMs() / 1000);
  const pollRow = `
    <div class="settings-row">
      <div class="settings-label">Live polling interval<br><span class="empty" style="padding:0;">While a war, CWL round, or raid weekend is active (10-600s)</span></div>
      <div class="settings-btns">
        <input type="number" id="pollIntervalInput" class="settings-poll-input" min="10" max="600" step="5" value="${pollSeconds}">
        <span class="empty" style="padding:0 4px;">sec</span>
        <button class="btn-ghost btn-small" id="applyPollInterval">Apply</button>
      </div>
    </div>
    <div class="empty" style="padding-top:0;">${isLiveNow ? `Currently live — refreshing every ${pollSeconds}s.` : `Currently idle — checking every ${Math.round(IDLE_POLL_MS/60000)} min for something to go live.`}</div>`;

  const chatPosition = localStorage.getItem('warroom_chat_position') === 'top' ? 'top' : 'bottom';
  const chatPositionRow = `
    <div class="settings-row">
      <div class="settings-label">AI chat position on phone/tablet<br><span class="empty" style="padding:0;">Only affects the narrow, stacked layout — desktop keeps chat on the side</span></div>
      <div class="settings-btns">
        <button class="btn-ghost btn-small settings-chatpos-btn${chatPosition === 'top' ? ' active' : ''}" data-chatpos="top">Top (under clan info)</button>
        <button class="btn-ghost btn-small settings-chatpos-btn${chatPosition === 'bottom' ? ' active' : ''}" data-chatpos="bottom">Bottom (default)</button>
      </div>
    </div>`;

  const orderRows = sectionOrder.map((id) => `
    <div class="settings-order-row" draggable="true" data-id="${esc(id)}">
      <span class="order-drag-handle" title="Drag to reorder">⠿</span>
      <span>${esc(SECTION_LABELS[id] || id)}</span>
    </div>`).join('');

  const body = `
    ${themeRow}
    ${densityRow}
    ${fontSizeRow}
    ${fontFamilyRow}
    ${pollRow}
    ${chatPositionRow}
    <div class="settings-row settings-row-order">
      <div class="settings-label">Panel order</div>
      <div class="empty" style="padding:0;">Settings always stays last, below Notes.</div>
    </div>
    <div class="settings-order-list">${orderRows}</div>
  `;

  p.innerHTML = renderCollapsiblePanel('settingsPanel', 'Settings', body);
}

document.addEventListener('click', (e) => {
  const themeBtn = e.target.closest('.settings-theme-btn');
  if(themeBtn){ setTheme(themeBtn.dataset.theme); return; }
  const densityBtn = e.target.closest('.settings-density-btn');
  if(densityBtn){ setDensity(densityBtn.dataset.density); return; }
  const fontSizeBtn = e.target.closest('.settings-fontsize-btn');
  if(fontSizeBtn){ setFontSize(fontSizeBtn.dataset.fontsize); return; }
  const fontSelect = e.target.closest('#fontFamilySelect');
  if(fontSelect){ setFontFamily(fontSelect.value); return; }
  const applyPollBtn = e.target.closest('#applyPollInterval');
  if(applyPollBtn){
    const input = $('#pollIntervalInput');
    const seconds = parseInt(input?.value, 10);
    if(seconds && seconds >= 10){
      setPollIntervalMs(seconds * 1000);
      renderSettings();
      renderAttackLog();
    }
    return;
  }
  const chatPosBtn = e.target.closest('.settings-chatpos-btn');
  if(chatPosBtn){ setChatPosition(chatPosBtn.dataset.chatpos); return; }
});
