/* --- Reference UI helpers (visual only) --- */
function syncThemeToggle(){
  const theme = document.documentElement.getAttribute('data-theme') || 'light';
  const el = document.querySelector('#themeToggleUI .theme-label');
  if(el) el.textContent = theme === 'light' ? 'Dark' : 'Light';
}
const __warRoomOriginalSetTheme = setTheme;
setTheme = function(theme){
  __warRoomOriginalSetTheme(theme);
  syncThemeToggle();
};
document.getElementById('themeToggleUI')?.addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
  setTheme(next);
});
syncThemeToggle();

