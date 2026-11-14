// NutriPath frontend — auth + onboarding, summary-only home dashboard, and every deep
// feature inside module modals (bottom sheet on phones, docked right panel on desktop).
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const fmt = (n) => Number(n || 0).toLocaleString('en-IN');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* storage unavailable */ } },
};

const state = {
  token: store.get('np-session'), user: null, config: null,
  water: 0, waterTarget: 8, view: null, forcePhone: store.get('np-view') === 'phone', dash: null,
};

async function api(url, opts = {}) {
  const headers = { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}) };
  const r = await fetch(url, { ...opts, headers: { ...headers, ...opts.headers } });
  const body = await r.json().catch(() => ({}));
  if (r.status === 401 && !url.startsWith('/api/auth') && url !== '/api/login') {
    // Offline guest has no session: don't bounce back to login, just fail this call
    if (state.guest) throw new Error('Guest mode — sign in to use this feature');
    signOut(true);
    throw new Error('Session expired — please sign in again');
  }
  if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
  return body;
}
const post = (url, data, method = 'POST') => api(url, { method, body: JSON.stringify(data ?? {}) });

function toast(msg, ms = 2800) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, ms);
}

const charts = {};
function makeChart(key, canvas, config) { charts[key]?.destroy(); charts[key] = new Chart(canvas, config); }

const pill = (t, cls = 'bg-emerald-50 text-emerald-700') => `<span class="inline-block ${cls} rounded-full px-2 py-0.5 text-xs mr-1 mb-1">${esc(t)}</span>`;
const seg = (group, tabs, active) => `<div class="seg" data-seg="${group}">${tabs.map(([id, label]) =>
  `<button type="button" data-tab="${id}" class="${id === active ? 'on' : ''}">${esc(label)}</button>`).join('')}</div>`;
const pane = (group, id, active, html) => `<div data-pane="${group}:${id}" ${id === active ? '' : 'hidden'} class="space-y-3">${html}</div>`;
const macroLine = (m) => `${fmt(Math.round(m.kcal))} kcal · P ${Math.round(m.protein_g)} · C ${Math.round(m.carbs_g)} · F ${Math.round(m.fat_g)}`;
const STATUS_CLS = { normal: 'bg-emerald-50 text-emerald-700', borderline: 'bg-amber-50 text-amber-800', insufficient: 'bg-amber-50 text-amber-800', low: 'bg-amber-50 text-amber-800', deficient: 'bg-red-50 text-red-700', high: 'bg-red-50 text-red-700' };

// ===================================================================
// Loggable items registry: any "+ Log" button anywhere → POST /api/log-meal → refresh rings
// ===================================================================
const loggable = new Map();
let logSeq = 0;
const regLog = (item) => { const id = `L${++logSeq}`; loggable.set(id, item); return id; };
const logBtn = (item, label = '+ Log') => `<button type="button" class="log-btn" data-log="${regLog(item)}">${label}</button>`;

async function logMeals(items, btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Logging…'; }
  try {
    const r = await post('/api/log-meal', { items });
    toast(`✅ Logged ${items.length > 1 ? `${items.length} items` : items[0].name} — today ${fmt(r.totals.calories)} kcal`);
    if (btn) { btn.textContent = '✓ Logged'; btn.classList.add('done'); }
    await loadDashboard(); // instantly refresh Home rings
    if (state.view === 'fitness') renderFoodLog();
    return r;
  } catch (e) {
    toast(`⚠️ ${e.message}`);
    if (btn) { btn.disabled = false; btn.textContent = '+ Log'; }
    return null;
  }
}

// ===================================================================
// Auth: Firebase Google sign-in (or demo sign-in when Firebase isn't configured)
// ===================================================================
let fbAuth = null;

function showAuth(error) {
  $('#app').hidden = true;
  $('#onboarding').hidden = true;
  $('#authScreen').hidden = false;
  const cfg = state.config || {};
  $('#googleSignIn').hidden = !(cfg.firebase && fbAuth);
  $('#demoForm').hidden = !cfg.demoLogin;
  $('#authError').hidden = !error;
  $('#authError').textContent = error || '';
}

async function exchangeFirebaseUser(fbUser) {
  const idToken = await fbUser.getIdToken();
  const r = await post('/api/auth/login', { idToken });
  await startSession(r);
}

async function startSession({ token, user, needsOnboarding }) {
  state.token = token;
  store.set('np-session', token);
  await enterApp(user, needsOnboarding);
}

$('#googleSignIn').addEventListener('click', async () => {
  try {
    const provider = new firebase.auth.GoogleAuthProvider();
    const res = await fbAuth.signInWithPopup(provider);
    await exchangeFirebaseUser(res.user);
  } catch (e) {
    if (['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment'].includes(e.code)) {
      return fbAuth.signInWithRedirect(new firebase.auth.GoogleAuthProvider());
    }
    if (e.code !== 'auth/popup-closed-by-user') showAuth(e.message);
  }
});

// TEMP fallback: "Continue as Guest" — never blocks. Tries a real demo session named "Guest"
// (so data saves when the server allows demo login); otherwise enters the UI as an offline guest.
async function continueAsGuest() {
  try {
    const r = await post('/api/login', { name: 'Guest' });
    state.guest = false;
    return await startSession(r);
  } catch (e) {
    console.warn('Guest session unavailable — continuing as offline guest:', e.message);
  }
  state.guest = true;
  state.token = null;
  store.del('np-session');
  await enterApp({ name: 'Guest' }, false);
}
$('#guestBtn').addEventListener('click', continueAsGuest);

$('#demoForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const r = await post('/api/login', Object.fromEntries(new FormData(e.target)));
    await startSession(r);
  } catch (err) {
    showAuth(err.message);
  }
});

async function signOut(expired = false) {
  state.guest = false;
  state.token = null;
  state.user = null;
  store.del('np-session');
  try { await fbAuth?.signOut(); } catch { /* ignore */ }
  closeSheet(true);
  showAuth(expired ? 'Your session expired — please sign in again.' : '');
}

async function enterApp(user, needsOnboarding) {
  state.user = user;
  $('#authScreen').hidden = true;
  $('#app').hidden = false;
  applyLayout(true);
  renderUser();
  try {
    await loadDashboard(); // UI is already visible; a failed load must never block it
  } catch (e) {
    console.error('Initial dashboard load failed', e);
  }
  if (needsOnboarding) openOnboarding();
  const initialView = location.hash.slice(1);
  if (views[initialView]) showView(initialView);
}

function renderUser() {
  const u = state.user || {};
  $('#userName').textContent = (u.name || 'there').split(' ')[0];
  $('#avatar').innerHTML = u.photo_url ? `<img src="${esc(u.photo_url)}" alt="" referrerpolicy="no-referrer">` : esc((u.name || '?')[0].toUpperCase());
  $('#greetDate').textContent = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short' });
}

// ===================================================================
// Onboarding (3 steps: Goal → Diet → Allergies)
// ===================================================================
let obStep = 1;
function openOnboarding() { obStep = 1; renderOnboarding(); $('#onboarding').hidden = false; }
function renderOnboarding() {
  $$('[data-step]').forEach((s) => { s.hidden = Number(s.dataset.step) !== obStep; });
  $$('#obDots .ob-dot').forEach((d, i) => d.classList.toggle('on', i < obStep));
  $('#obBack').hidden = obStep === 1;
  $('#obNext').textContent = obStep === 3 ? 'Finish setup' : 'Next';
  $('#obError').hidden = true;
}
$('#obBack').addEventListener('click', () => { obStep = Math.max(1, obStep - 1); renderOnboarding(); });
$('#onboardForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (obStep < 3) { obStep += 1; renderOnboarding(); return; }
  const fd = new FormData(e.target);
  const allergies = [...fd.getAll('allergies'), ...String(fd.get('allergies_other') || '').split(',')].map((s) => s.trim()).filter(Boolean);
  const body = { ...Object.fromEntries([...fd.entries()].filter(([k]) => !k.startsWith('allergies'))), allergies };
  try {
    $('#obNext').disabled = true;
    const r = await post('/api/users/setup', body);
    state.user = r.user;
    $('#onboarding').hidden = true;
    toast(`🎯 All set! Your daily target is ${fmt(r.targets.calories)} kcal`);
    loadDashboard();
  } catch (err) {
    $('#obError').textContent = err.message;
    $('#obError').hidden = false;
  } finally {
    $('#obNext').disabled = false;
  }
});

// ===================================================================
// Layout: phone (<1024px) vs desktop 12-column dashboard (≥1024px)
// ===================================================================
const isDesktop = () => document.body.classList.contains('is-desktop');
function applyLayout(force = false) {
  const desktop = window.matchMedia('(min-width: 1024px)').matches && !state.forcePhone;
  const changed = desktop !== isDesktop();
  document.body.classList.toggle('is-desktop', desktop);
  $$('#viewToggle button').forEach((b) => b.classList.toggle('on', (b.dataset.viewmode === 'laptop') === desktop));
  if (!changed && !force) return;
  if (!state.user) return;
  if (desktop) {
    $('#sheetBackdrop').hidden = true;
    $('#sheet').hidden = false;
    if (!state.view) showView('welcome');
  } else if (!state.view || state.view === 'welcome') {
    closeSheet(true);
  } else {
    $('#sheetBackdrop').hidden = false;
  }
}
$$('#viewToggle button').forEach((b) => b.addEventListener('click', () => {
  state.forcePhone = b.dataset.viewmode === 'phone';
  store.set('np-view', state.forcePhone ? 'phone' : 'laptop');
  applyLayout();
}));
window.addEventListener('resize', () => applyLayout());

// ===================================================================
// Home dashboard (summaries only)
// ===================================================================
function setRing(el, pct, label) {
  el.style.setProperty('--p', Math.min(100, Math.max(0, pct)));
  if (label !== undefined) el.querySelector('span').textContent = label;
}
function renderWater() {
  $('#waterValue').textContent = state.water;
  $('#waterTarget').textContent = state.waterTarget;
  $('#waterBar').style.width = `${Math.min(100, (state.water / state.waterTarget) * 100)}%`;
}
const SOURCE_LABEL = { google_fit: 'Google Fit', apple_health: 'Apple Health' };
const timeOf = (sqlUtc) => (sqlUtc ? new Date(`${sqlUtc.replace(' ', 'T')}Z`).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }) : '');

async function loadDashboard() {
  try {
    const d = await api('/api/dashboard');
    state.dash = d;
    state.user = d.user;
    renderUser();
    const { today: t, targets } = d;
    $('#calValue').textContent = fmt(t.calories);
    $('#calTarget').textContent = `/${fmt(targets.calories)} kcal`;
    setRing($('#calRing'), (t.calories / targets.calories) * 100);
    $('#calRing').style.setProperty('--c', t.calories > targets.calories * 1.1 ? '#ef4444' : '#2fbf71');
    const left = targets.calories - t.calories + (t.calories_burned || 0);
    $('#calLeft').textContent = left >= 0 ? `${fmt(left)} kcal left${t.calories_burned ? ' (incl. burned)' : ''}` : `${fmt(-left)} kcal over`;
    const m = targets.macros;
    const pct = (v, tgt) => Math.round((Number(v) / tgt) * 100);
    const p = pct(t.protein_g, m.protein_g), c = pct(t.carbs_g, m.carbs_g), f = pct(t.fat_g, m.fat_g);
    setRing($('#ringProtein'), p, `${p}%`);
    setRing($('#ringCarbs'), c, `${c}%`);
    setRing($('#ringFat'), f, `${f}%`);

    state.water = Number(t.water_glasses);
    state.waterTarget = Number(targets.water_glasses);
    renderWater();

    const synced = t.steps != null;
    $('#stepsValue').textContent = synced ? fmt(t.steps) : '—';
    $('#stepsBar').style.width = `${synced ? Math.min(100, (t.steps / targets.steps) * 100) : 0}%`;
    $('#stepsSub').textContent = synced ? `${Math.round((t.steps / targets.steps) * 100)}% of ${fmt(targets.steps)} goal` : `Goal ${fmt(targets.steps)}`;
    $('#burnValue').textContent = synced ? fmt(t.calories_burned) : '—';
    $('#syncSub').innerHTML = synced
      ? `${esc(SOURCE_LABEL[t.sync_source] || 'Synced')} · ${esc(timeOf(t.synced_at))} <button type="button" data-view="profile" class="text-teal-700 underline">resync</button>`
      : '<button type="button" data-view="profile" class="text-teal-700 underline">Sync health app</button>';
  } catch (e) {
    console.error('Dashboard load failed', e);
  }
}

$('#waterCard').addEventListener('click', async () => {
  state.water = state.water >= state.waterTarget ? 0 : state.water + 1;
  renderWater();
  try { await post('/api/water', { glasses: state.water }); } catch (e) { toast(`⚠️ ${e.message}`); }
});

// ===================================================================
// Sheet / right panel
// ===================================================================
function openSheet(title, html, chat = false) {
  $('#sheetTitle').textContent = title;
  $('#sheetBody').innerHTML = html;
  $('#sheetBody').scrollTop = 0;
  $('#chatForm').hidden = !chat;
  $('#sheet').hidden = false;
  $('#sheetBackdrop').hidden = isDesktop();
  if (chat && isDesktop()) $('#chatInput').focus();
}
function leaveView() { stopScanner(); }
function closeSheet(force = false) {
  leaveView();
  if (isDesktop() && !force && state.user) return showView('welcome');
  state.view = null;
  $('#sheet').hidden = true;
  $('#sheetBackdrop').hidden = true;
  setNav('home');
  markModule(null);
}
$('#sheetClose').onclick = () => closeSheet();
$('#sheetBackdrop').onclick = () => closeSheet();
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !isDesktop() && !$('#sheet').hidden) closeSheet(); });

function setNav(name) { $$('[data-nav]').forEach((x) => x.classList.toggle('active', x.dataset.nav === name)); }
function markModule(view) { $$('.module-icon').forEach((c) => c.classList.toggle('is-active', c.dataset.view === view)); }
const NAV_FOR_VIEW = { chat: 'chat', diet: 'diet', analytics: 'analytics', profile: 'profile', welcome: 'home' };

async function showView(name) {
  const view = views[name];
  if (!view) return;
  leaveView();
  state.view = name;
  setNav(NAV_FOR_VIEW[name] || 'home');
  markModule(name);
  openSheet('Loading…', '<p class="text-gray-400">Fetching data…</p>', name === 'chat');
  try {
    const { title, html, after } = await view();
    if (state.view !== name) return;
    openSheet(title, html, name === 'chat');
    after?.();
  } catch (err) {
    if (state.view === name) openSheet('Error', `<p class="text-red-600">Could not load: ${esc(err.message)}</p>`);
  }
}

document.addEventListener('click', async (e) => {
  const tab = e.target.closest('[data-seg] [data-tab]');
  if (tab) {
    const group = tab.parentElement.dataset.seg;
    $$('button', tab.parentElement).forEach((b) => b.classList.toggle('on', b === tab));
    $$(`[data-pane^="${group}:"]`).forEach((p) => { p.hidden = p.dataset.pane !== `${group}:${tab.dataset.tab}`; });
    if (group === 'diet' && tab.dataset.tab !== 'scan') stopScanner();
    return;
  }
  const lb = e.target.closest('[data-log]');
  if (lb) { const item = loggable.get(lb.dataset.log); if (item) logMeals([item], lb); return; }
  const trigger = e.target.closest('[data-view]');
  if (trigger) { showView(trigger.dataset.view); return; }
  const home = e.target.closest('[data-nav="home"]');
  if (home) {
    $('#scroll').scrollTo({ top: 0, behavior: 'smooth' });
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (isDesktop()) showView('welcome'); else closeSheet();
  }
});

// ===================================================================
// Image helper: downscale photos before upload (keeps Gemini requests small)
// ===================================================================
async function fileToDataURL(file, max = 1280) {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.85);
  } catch {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = reject;
      fr.readAsDataURL(file);
    });
  }
}

// ===================================================================
// Views
// ===================================================================
const views = {
  // ---------------- Desktop default panel ----------------
  async welcome() {
    const shortcut = (view, icon, title, sub) => `<button data-view="${view}" class="w-full flex items-center gap-3 border border-gray-100 hover:border-teal-200 hover:bg-teal-50/40 rounded-2xl p-3 text-left">
      <span class="text-2xl">${icon}</span><span><b class="text-gray-900">${title}</b><br><span class="text-xs text-gray-500">${sub}</span></span></button>`;
    return { title: 'Workspace', html: `
      <p class="text-gray-500">Open a module — it renders here, side-by-side with your dashboard.</p>
      ${shortcut('diet', '🍽️', 'Diet Planner', 'AI meal suggestions · Hostel menu · Scan & log')}
      ${shortcut('fitness', '👟', 'Fitness Nutrition', 'TDEE sliders · Today’s food log')}
      ${shortcut('recovery', '❤️‍🩹', 'Health & Recovery', 'Lab report scan · Illness roadmap · Condition toggles')}
      ${shortcut('supplements', '💊', 'Supplement Hub', 'Interaction checker · AI quiz · Partner brands')}
      ${shortcut('chat', '🤖', 'AI Nutrition Chat', 'Gemini-powered Indian nutritionist')}
      ${shortcut('analytics', '📊', 'Analytics', 'Micronutrient gap dashboard')}
      ${shortcut('profile', '🧑🏽', 'Profile', 'Health sync · Daily email · Settings')}` };
  },

  // ---------------- DIET PLANNER: [Meal Plans] [Hostel Menu] [Scan & Log] ----------------
  async diet() {
    const d = await api('/api/diet-planner');
    loggable.clear();
    const g = d.generator;
    const defDiet = ['non-veg', 'eggetarian'].includes(state.dash?.profile?.diet_type) ? 'Non-Veg' : 'Veg';
    const select = (name, label, list, cur) => `<div class="field"><label>${label}</label><select name="${name}">${list.map((v) => `<option ${v === cur ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></div>`;
    const hour = new Date().getHours();
    const defType = hour < 11 ? 'Breakfast' : hour < 16 ? 'Lunch' : hour < 19 ? 'Snack' : 'Dinner';

    const swapsHtml = `<div class="overflow-x-auto"><table class="tbl swap-tbl">
      <tr><th>Instead of</th><th>Choose (local)</th><th>Protein /100 g</th><th>₹/kg</th><th>Save</th></tr>
      ${d.substitutions.map((s) => `<tr>
        <td class="text-gray-500">🌍 ${esc(s.from?.name)}<br><span class="text-[0.65rem]">${s.from?.protein_g} g · ₹${fmt(s.from?.cost_inr_per_kg)}</span></td>
        <td><b>🇮🇳 ${s.to.map((t) => esc(t.name)).join('<br>🇮🇳 ')}</b></td>
        <td>${s.to.map((t) => `${t.protein_g} g`).join('<br>')}</td>
        <td>${s.to.map((t) => `₹${fmt(t.cost_inr_per_kg)}`).join('<br>')}</td>
        <td>${s.savings_pct != null ? pill(`${s.savings_pct}%`) : '—'}</td></tr>
        <tr class="swap-why"><td colspan="5">${esc(s.why)}</td></tr>`).join('')}
    </table></div>`;

    const plansHtml = `
      <form id="mealGenForm" class="box space-y-2">
        <p class="font-semibold text-gray-900">✨ AI meal suggestion</p>
        <p class="text-xs text-gray-500">Pick a meal, cuisine and diet — Gemini suggests one nutritious meal sized to your calorie and protein targets.</p>
        <div class="grid grid-cols-3 gap-2">
          ${select('meal_type', 'Meal type', g.meal_type, defType)}
          ${select('cuisine', 'Cuisine', g.cuisine, g.cuisine[0])}
          ${select('diet', 'Diet', g.diet, defDiet)}
        </div>
        <button class="btn-primary w-full" id="mealGenBtn">Suggest a meal</button>
      </form>
      <div id="mealGenResult"></div>
      <div class="box"><p class="font-semibold text-gray-900 mb-2">🇮🇳 Smart local swaps</p>${swapsHtml}</div>`;

    const hostelHtml = `
      <div class="box space-y-2">
        <p class="font-semibold text-gray-900">📋 Upload mess menu</p>
        <p class="text-xs text-gray-500">Photograph the mess board or printed weekly menu. AI reads each dish, estimates macros and saves it to your menu below.</p>
        <label class="upload-btn"><input type="file" accept="image/*" capture="environment" id="menuUpload" hidden>📋 Upload Menu Photo</label>
        <div id="menuScanStatus"></div>
      </div>
      <div id="hostelMenu"><p class="text-xs text-gray-400">Loading saved menu…</p></div>`;

    const scanHtml = `
      <div class="box space-y-2">
        <p class="font-semibold text-gray-900">📷 Barcode scanner <span class="text-xs font-normal text-gray-400">· Open Food Facts</span></p>
        <div id="reader" class="reader" hidden></div>
        <div class="flex gap-2">
          <button type="button" id="scanStart" class="btn-primary flex-1">📷 Scan barcode</button>
          <button type="button" id="scanStop" class="btn-ghost" hidden>Stop</button>
        </div>
        <form id="barcodeForm" class="flex gap-2">
          <input id="barcodeInput" inputmode="numeric" pattern="[0-9]*" maxlength="14" class="input flex-1" placeholder="…or type a barcode, e.g. 8901058851281">
          <button class="btn-ghost">Look up</button>
        </form>
        <div id="barcodeResult"></div>
      </div>
      <div class="box space-y-2">
        <p class="font-semibold text-gray-900">🤖 AI meal photo</p>
        <p class="text-xs text-gray-500">Snap your plate — AI identifies each food and estimates macros. Review, then log.</p>
        <label class="upload-btn"><input type="file" accept="image/*" capture="environment" data-vision="meal" hidden>📸 Upload Meal Photo</label>
        <div id="visionMealResult"></div>
      </div>
      <details class="box">
        <summary class="font-semibold text-gray-900 cursor-pointer">✍️ Quick manual log</summary>
        <form id="manualForm" class="grid grid-cols-2 gap-2 mt-3">
          <div class="field col-span-2"><label>Food</label><input name="name" required maxlength="120" placeholder="e.g. Masala dosa"></div>
          <div class="field"><label>Calories</label><input name="kcal" type="number" min="0" max="5000" required></div>
          <div class="field"><label>Protein g</label><input name="protein_g" type="number" min="0" step="0.1" value="0"></div>
          <div class="field"><label>Carbs g</label><input name="carbs_g" type="number" min="0" step="0.1" value="0"></div>
          <div class="field"><label>Fat g</label><input name="fat_g" type="number" min="0" step="0.1" value="0"></div>
          <button class="btn-primary col-span-2">+ Log food</button>
        </form>
      </details>`;

    return { title: 'Diet Planner', html: `
      ${seg('diet', [['plans', '🍱 Meal Plans'], ['hostel', '🏫 Hostel Menu'], ['scan', '📷 Scan & Log']], 'plans')}
      ${pane('diet', 'plans', 'plans', plansHtml)}
      ${pane('diet', 'hostel', 'plans', hostelHtml)}
      ${pane('diet', 'scan', 'plans', scanHtml)}`,
    after() {
      mealGen.seen = [];
      $('#mealGenForm').addEventListener('submit', (e) => { e.preventDefault(); mealGen.seen = []; generateMeal(); });
      $('#menuUpload').addEventListener('change', (e) => scanMenu(e.target));
      loadHostelMenu();
      $('#scanStart').onclick = startScanner;
      $('#scanStop').onclick = stopScanner;
      $$('[data-vision]').forEach((inp) => inp.addEventListener('change', () => runVision(inp)));
    } };
  },

  // ---------------- FITNESS NUTRITION ----------------
  async fitness() {
    const fit = await api('/api/fitness');
    const i = fit.input;
    const acts = Object.keys(fit.options.activity);
    state.fit = { mult: fit.options.activity, acts };
    const slider = (name, label, min, max, step, val, unit) => `<div class="slider">
      <div class="flex justify-between text-xs"><label for="s-${name}" class="font-semibold text-gray-600">${label}</label><b id="o-${name}" class="text-gray-900"></b></div>
      <input id="s-${name}" name="${name}" type="range" min="${min}" max="${max}" step="${step}" value="${val}" data-unit="${unit}"></div>`;
    return { title: 'Fitness Nutrition', html: `
      ${seg('fit', [['calc', '🧮 TDEE Calculator'], ['log', '📒 Today’s Food Log']], 'calc')}
      ${pane('fit', 'calc', 'calc', `
        <form id="fitForm" class="box space-y-3">
          ${slider('weight', 'Weight', 30, 150, 0.5, i.weight, 'kg')}
          ${slider('height', 'Height', 130, 210, 1, i.height, 'cm')}
          ${slider('age', 'Age', 14, 80, 1, i.age, 'yrs')}
          ${slider('activity', 'Activity', 0, acts.length - 1, 1, Math.max(0, acts.indexOf(i.activity)), '')}
          <div class="grid grid-cols-2 gap-2">
            <div class="field"><label>Sex</label><select name="sex">${['male', 'female'].map((v) => `<option ${v === i.sex ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
            <div class="field"><label>Goal</label><select name="goal">${fit.options.goals.map((v) => `<option ${v === i.goal ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
          </div>
        </form>
        <div id="fitResult"></div>
        <button type="button" id="fitSave" class="btn-primary w-full">💾 Save as my daily target</button>
        <p class="text-[0.7rem] text-gray-400 font-mono">BMR = 10·W + 6.25·H − 5·A + s (s = +5 ♂ / −161 ♀) · TDEE = BMR × activity</p>`)}
      ${pane('fit', 'log', 'calc', '<div id="foodLog"><p class="text-gray-400 text-xs">Loading…</p></div>')}`,
    after() {
      $('#fitForm').addEventListener('input', renderFitness);
      renderFitness();
      $('#fitSave').onclick = saveFitness;
      renderFoodLog();
    } };
  },

  // ---------------- HEALTH & RECOVERY ----------------
  async recovery() {
    const labs = await api('/api/labs');
    const prev = labs.observations.length
      ? `<p class="text-[0.7rem] text-gray-500">Last saved: ${labs.observations.map((o) => `${esc(o.metric)} ${esc(o.value)} ${esc(o.unit)} (${esc(o.status)})`).join(' · ')}</p>` : '';
    return { title: 'Health & Recovery', html: `
      ${seg('health', [['lab', '🧪 Lab Analyzer'], ['roadmap', '🗓️ Illness Roadmap'], ['cond', '⚕️ Conditions']], 'lab')}
      ${pane('health', 'lab', 'lab', `
        <div class="box space-y-2">
          <p class="font-semibold text-gray-900">🧪 Upload Lab Report</p>
          <p class="text-xs text-gray-500">Take a clear photo of your blood test report. Gemini Vision extracts <b>Vitamin B12</b>, <b>Vitamin D</b> and <b>Iron</b> (ferritin / serum iron / haemoglobin), then you get a status and food fixes for your diet type.</p>
          <label class="upload-btn"><input type="file" accept="image/*" capture="environment" id="labUpload" hidden>📄 Upload Lab Report (Image)</label>
          ${prev}
        </div>
        <div id="labResult" class="space-y-2"></div>`)}
      ${pane('health', 'roadmap', 'lab', `
        ${seg('rplan', [['viral_cold', '🤒 Viral Fever & Cold'], ['food_poisoning', '🤢 Food Poisoning']], 'viral_cold')}
        <div id="roadmap"><p class="text-xs text-gray-400">Loading…</p></div>`)}
      ${pane('health', 'cond', 'lab', '<div id="condBox"><p class="text-xs text-gray-400">Loading…</p></div>')}
      <p class="text-xs text-gray-400">General dietary guidance only — not a substitute for medical diagnosis or treatment.</p>`,
    after() {
      $('#labUpload').addEventListener('change', (e) => uploadLabReport(e.target));
      $('[data-seg="rplan"]').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) loadRoadmap(b.dataset.tab); });
      loadRoadmap('viral_cold');
      loadConditions();
    } };
  },

  // ---------------- SUPPLEMENT HUB ----------------
  async supplements() {
    const [lib, quiz, sp] = await Promise.all([api('/api/supplements'), api('/api/supplements/quiz'), api('/api/sponsored')]);
    const o = lib.options;
    const quizHtml = quiz.questions.map((q, n) => `<fieldset class="mb-3"><legend class="text-xs font-semibold text-gray-700 mb-1.5">${n + 1}. ${esc(q.q)}</legend>
      <div class="flex flex-wrap gap-1.5">${q.options.map(([v, l]) => `<label class="chip"><input type="radio" name="${q.id}" value="${esc(v)}" required><span>${esc(l)}</span></label>`).join('')}</div></fieldset>`).join('');
    const theme = { gold: 'sp-gold', emerald: 'sp-emerald', sky: 'sp-sky', violet: 'sp-violet' };
    const sponsored = sp.products.map((p) => `<div class="sp-card ${theme[p.theme] || 'sp-gold'}">
      <div class="flex items-start justify-between gap-2"><span class="sp-badge">${esc(p.badge)}</span><span class="text-3xl">${p.emoji}</span></div>
      <p class="text-[0.7rem] uppercase tracking-widest opacity-80 mt-2">${esc(p.brand)}</p>
      <p class="font-bold text-base leading-tight">${esc(p.product)}</p>
      <p class="text-xs opacity-85 mt-1">${esc(p.tagline)}</p>
      <div class="flex items-center justify-between mt-3"><b class="text-lg">₹${fmt(p.price_inr)}</b><button type="button" class="sp-buy" data-sponsor="${esc(p.id)}">${esc(p.cta)} →</button></div>
    </div>`).join('');
    return { title: 'Supplement Hub', html: `
      <div class="box space-y-2">
        <p class="font-semibold text-gray-900">⚠️ Interaction checker</p>
        <form id="interactionForm" class="grid grid-cols-2 gap-2">
          <div class="field"><label>Medication</label><select name="med" required><option value="">Select…</option>${o.medications.map((m) => `<option>${esc(m)}</option>`).join('')}</select></div>
          <div class="field"><label>Supplement</label><select name="supp"><option value="">All supplements</option>${o.supplements.map((s) => `<option>${esc(s)}</option>`).join('')}</select></div>
          <button class="btn-primary col-span-2">Check interactions</button>
        </form>
        <div id="interactionResult"></div>
      </div>
      <div class="box">
        <p class="font-semibold text-gray-900 mb-2">🤖 AI supplement quiz</p>
        <form id="quizForm">${quizHtml}<button class="btn-primary w-full">Get my recommendations</button></form>
        <div id="quizResult" class="space-y-2 mt-3"></div>
      </div>
      <div>
        <div class="flex items-center justify-between mb-2"><p class="font-semibold text-gray-900">✨ Partner Brands</p><span class="text-[0.65rem] uppercase tracking-wider text-gray-400 border border-gray-200 rounded-full px-2 py-0.5">${esc(sp.label)}</span></div>
        <div class="sp-grid">${sponsored}</div>
        <p class="text-[0.65rem] text-gray-400 mt-1">Sponsored placements. Listing does not imply medical endorsement.</p>
      </div>
      <details class="box"><summary class="font-semibold text-gray-900 cursor-pointer">📚 Supplement library</summary><div class="space-y-2 mt-3">
        ${lib.supplements.map((s) => `<div class="border-t border-gray-50 pt-2"><div class="flex justify-between gap-2"><p class="font-semibold text-gray-900">${esc(s.name)}</p>${pill(`${s.evidence_level} evidence`)}</div>
        <p class="text-xs text-gray-500">${esc(s.typical_dose)} · ${esc(s.benefits)}</p><p class="text-xs mt-1">🇮🇳 <b>Local swap:</b> ${esc(s.local_alternative)}</p></div>`).join('')}
      </div></details>`,
    after() {
      $('#interactionForm').addEventListener('submit', checkInteractions);
      $('#quizForm').addEventListener('submit', runQuiz);
      $$('[data-sponsor]').forEach((b) => b.addEventListener('click', () => toast('🛒 Partner store link coming soon — this is a sponsored placeholder listing.')));
    } };
  },

  // ---------------- ANALYTICS: Micronutrient Gap Dashboard ----------------
  async analytics() {
    const a = await api('/api/analytics');
    const RISK = {
      High: { cls: 'risk-high', color: '#dc2626' }, Moderate: { cls: 'risk-mod', color: '#d97706' },
      Low: { cls: 'risk-low', color: '#059669' }, 'No data': { cls: 'risk-none', color: '#9ca3af' },
    };
    const hasData = a.days_logged > 0;
    const card = (m) => {
      const r = RISK[m.risk] || RISK['No data'];
      const width = Math.min(100, m.pct);
      return `<div class="box gap-card">
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0"><p class="font-semibold text-gray-900">${esc(m.label)}</p>
          <p class="text-xs text-gray-500">${hasData ? `<b class="text-gray-900">${esc(m.value)}</b> ${esc(m.unit)}` : 'No data'} · target ${esc(m.target_text)}</p></div>
          <span class="risk-badge ${r.cls}">${esc(m.risk)}${m.risk === 'No data' ? '' : ' risk'}</span>
        </div>
        ${hasData ? `<div class="flex items-center gap-2 mt-2"><div class="flex-1 h-1.5 rounded-full bg-gray-100 overflow-hidden"><div class="h-full rounded-full" style="width:${width}%;background:${r.color}"></div></div><span class="text-[0.7rem] font-semibold tabular-nums" style="color:${r.color}">${m.pct}%</span></div>` : ''}
        ${m.detail && hasData ? `<p class="text-[0.7rem] text-gray-500 mt-1">${esc(m.detail)}</p>` : ''}
        ${m.lab ? `<p class="text-[0.7rem] text-red-700 mt-1">🧪 Lab: ${esc(m.lab)}</p>` : ''}
        <p class="text-xs mt-2 text-gray-700"><b>Clinical recommendation:</b> ${esc(m.recommendation)}</p>
        ${m.sources?.length ? `<p class="text-[0.7rem] text-gray-400 mt-1">Top sources in your log: ${m.sources.map(esc).join(', ')}</p>` : ''}
      </div>`;
    };
    return { title: 'Micronutrient Gap Dashboard', html: `
      <div class="box">
        <div class="flex items-center justify-between gap-2"><p class="font-semibold text-gray-900">🩺 % of daily requirement</p>
        <p class="text-[0.7rem] text-gray-500">${a.days_logged}/${a.window_days} days · ${a.items_logged} foods</p></div>
        ${hasData ? `<div class="flex gap-2 mt-2 text-xs">${pill(`${a.summary.high} high risk`, 'bg-red-50 text-red-700')}${pill(`${a.summary.moderate} moderate`, 'bg-amber-50 text-amber-800')}</div>
          <div class="h-72 mt-1"><canvas id="gapRadar" aria-label="Radar chart of micronutrient adequacy"></canvas></div>`
          : '<p class="text-xs text-gray-500 py-6 text-center">No food logged in the last 7 days. <button type="button" data-view="diet" class="text-teal-700 underline">Log meals in the Diet Planner</button> to see your gaps.</p>'}
      </div>
      ${a.metrics.map(card).join('')}
      <p class="text-[0.7rem] text-gray-400">${esc(a.note)} Not a diagnosis — confirm deficiencies with a blood test.</p>`,
    after() {
      if (!hasData) return;
      const pts = a.metrics.map((m) => Math.min(150, m.pct));
      makeChart('gapRadar', $('#gapRadar'), {
        type: 'radar',
        data: {
          labels: a.metrics.map((m) => m.label.replace(' (Bioavailable)', ' (abs.)')),
          datasets: [
            { label: 'Your intake', data: pts, backgroundColor: 'rgba(20,184,166,0.18)', borderColor: '#0d9488', borderWidth: 2,
              pointBackgroundColor: a.metrics.map((m) => (RISK[m.risk] || RISK['No data']).color), pointRadius: 4 },
            { label: 'Requirement (100%)', data: a.metrics.map(() => 100), borderColor: '#9ca3af', borderDash: [4, 4], borderWidth: 1.5, pointRadius: 0, fill: false },
          ],
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } },
            tooltip: { callbacks: { label: (ctx) => (ctx.datasetIndex ? 'Requirement: 100%' : `${a.metrics[ctx.dataIndex].label}: ${a.metrics[ctx.dataIndex].pct}% · ${a.metrics[ctx.dataIndex].risk} risk`) } } },
          scales: { r: { min: 0, max: 150, ticks: { stepSize: 50, callback: (v) => `${v}%`, backdropColor: 'transparent', font: { size: 9 } }, pointLabels: { font: { size: 10 } }, grid: { color: '#e5e7eb' } } },
        },
      });
    } };
  },

  // ---------------- PROFILE ----------------
  async profile() {
    const { user, profile: p, targets, disclaimer, options, email } = await api('/api/profile');
    const t = state.dash?.today || {};
    const opt = (list, cur) => list.map((v) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${v.replace('_', ' ')}</option>`).join('');
    const list = (v) => (Array.isArray(v) ? v.join(', ') : v || '');
    const appliance = (id, icon, label) => `<label class="flex items-center gap-2 bg-gray-50 rounded-xl px-3 py-2 cursor-pointer">
      <input type="checkbox" name="appliances" value="${id}" ${(p.appliances || []).includes(id) ? 'checked' : ''}> ${icon} ${label}</label>`;
    return { title: 'Profile', html: `
      <div class="flex items-center gap-3">
        <div class="avatar avatar-lg">${user.photo_url ? `<img src="${esc(user.photo_url)}" alt="" referrerpolicy="no-referrer">` : esc(user.name[0].toUpperCase())}</div>
        <div class="min-w-0 flex-1"><p class="font-semibold text-gray-900 text-base truncate">${esc(user.name)}</p>
        <p class="text-xs text-gray-500 truncate">${esc(user.email || 'no email')} · ${user.provider === 'google' ? 'Google' : 'Demo'} account</p>
        <p class="text-xs text-gray-500">Target <b id="profTarget">${fmt(p.daily_calorie_target || targets.calories)}</b> kcal · ${targets.macros.protein_g} g protein</p></div>
        <button type="button" id="signOutBtn" class="btn-ghost text-xs">Sign out</button>
      </div>

      <div class="box space-y-2">
        <p class="font-semibold text-gray-900">🔄 Health app sync</p>
        <p class="text-xs text-gray-500">Pull today's steps and calories burned into your Home dashboard.${t.synced_at ? ` Last sync: ${esc(SOURCE_LABEL[t.sync_source])} at ${esc(timeOf(t.synced_at))}.` : ''}</p>
        <div class="flex gap-2">
          <select id="syncSource" class="input flex-1"><option value="google_fit">Google Fit</option><option value="apple_health">Apple Health</option></select>
          <button type="button" id="syncBtn" class="btn-primary">Sync Health App</button>
        </div>
        <p class="text-[0.7rem] text-gray-400">Demo integration: activity data is simulated until the Google Fit / HealthKit APIs are connected.</p>
      </div>

      <div class="box space-y-2">
        <p class="font-semibold text-gray-900">📧 Daily summary email</p>
        <p class="text-xs text-gray-500">Every day at 8 AM we email yesterday's calories, macros, water and steps${user.email ? ` to <b>${esc(user.email)}</b>` : ''}.</p>
        <label class="flex items-center gap-2 text-sm"><input type="checkbox" id="emailOptIn" ${user.email_opt_in ? 'checked' : ''}> Send me the daily summary</label>
        <button type="button" id="testEmailBtn" class="btn-ghost w-full" ${user.email ? '' : 'disabled'}>Send test email now</button>
        ${email.smtp ? '' : '<p class="text-[0.7rem] text-amber-700">SMTP not configured on the server — emails are written to the server log instead of being delivered.</p>'}
      </div>

      <form id="profileForm" class="space-y-3">
        <p class="text-xs font-semibold text-gray-900 uppercase tracking-wide">Health</p>
        <div class="grid grid-cols-2 sm:grid-cols-3 gap-2">
          <div class="field"><label>Name</label><input name="name" value="${esc(user.name)}" maxlength="100"></div>
          <div class="field"><label>Age</label><input name="age" type="number" min="10" max="110" value="${esc(p.age)}"></div>
          <div class="field"><label>Sex</label><select name="sex">${opt(['male', 'female'], p.sex)}</select></div>
          <div class="field"><label>Height (cm)</label><input name="height_cm" type="number" min="100" max="250" value="${esc(p.height_cm)}"></div>
          <div class="field"><label>Weight (kg)</label><input name="weight_kg" type="number" min="20" max="300" step="0.1" value="${esc(p.weight_kg)}"></div>
          <div class="field"><label>Diet</label><select name="diet_type">${opt(options.diet_types, p.diet_type)}</select></div>
          <div class="field"><label>Activity</label><select name="activity_level">${opt(options.activity, p.activity_level)}</select></div>
          <div class="field"><label>Goal</label><select name="goal">${opt(options.goals, p.goal)}</select></div>
          <div class="field"><label>Water target</label><input name="daily_water_target" type="number" min="1" max="30" value="${esc(p.daily_water_target)}"></div>
          <div class="field"><label>Living</label><select name="living_setup">${opt(['hostel', 'pg', 'home'], p.living_setup)}</select></div>
        </div>
        <p class="text-xs font-semibold text-gray-900 uppercase tracking-wide pt-1">Hostel appliances</p>
        <div class="grid grid-cols-2 gap-2 text-sm">${appliance('kettle', '🫖', 'Electric Kettle')}${appliance('induction', '🍳', 'Induction')}</div>
        <div class="field"><label>Mess menu (typical)</label><textarea name="mess_menu" rows="2">${esc(p.mess_menu)}</textarea></div>
        <div class="grid grid-cols-2 gap-2">
          <div class="field"><label>Monthly food budget (₹)</label><input name="monthly_food_budget" type="number" min="0" value="${esc(p.monthly_food_budget ?? '')}"></div>
          <div class="field"><label>Allergies</label><input name="allergies" value="${esc(list(p.allergies))}" placeholder="e.g. peanuts, lactose"></div>
        </div>
        <div class="field"><label>Medications (comma-separated)</label><input name="medications" value="${esc(list(p.medications))}" placeholder="e.g. metformin"></div>
        <button class="ai-banner w-full text-white rounded-full py-2.5 text-sm font-semibold">Save profile &amp; recalculate</button>
      </form>
      <div class="rounded-2xl border border-red-200 bg-red-50 p-3 text-xs text-red-800"><p class="font-semibold mb-1">⚕️ Clinical safeguard</p><p>${esc(disclaimer)}</p></div>`,
    after() {
      $('#signOutBtn').onclick = () => signOut();
      $('#syncBtn').onclick = syncHealth;
      $('#testEmailBtn').onclick = testEmail;
      $('#emailOptIn').onchange = async (e) => {
        try { await post('/api/profile', { email_opt_in: e.target.checked }, 'PUT'); toast(e.target.checked ? '📧 Daily emails on' : '🔕 Daily emails off'); } catch (err) { toast(`⚠️ ${err.message}`); }
      };
      $('#profileForm').addEventListener('submit', saveProfile);
    } };
  },

  // ---------------- AI CHAT ----------------
  async chat() {
    if (!chatLoaded) {
      try {
        const { messages } = await api('/api/chat/history');
        chatLog.splice(0, chatLog.length, ...messages.map((m) => ({ role: m.role, text: m.message })));
        chatLoaded = true;
      } catch { /* start empty */ }
    }
    return { title: 'AI Nutrition Assistant', html: '', after: renderChat };
  },
};

// ===================================================================
// Diet: AI meal generator, hostel menu (saved list), barcode scanner, AI vision, manual log
// ===================================================================
const mealGen = { seen: [], busy: false };
async function generateMeal() {
  if (mealGen.busy) return;
  const form = $('#mealGenForm');
  const box = $('#mealGenResult');
  if (!form || !box) return;
  mealGen.busy = true;
  const req = Object.fromEntries(new FormData(form));
  box.innerHTML = '<div class="box flex items-center gap-2 text-xs text-gray-500"><span class="spinner"></span> Planning your meal…</div>';
  $$('#mealGenBtn, #mealNextBtn').forEach((b) => { b.disabled = true; });
  try {
    const r = await post('/api/generate-meal', { ...req, exclude: mealGen.seen });
    const m = r.meal;
    mealGen.seen.push(m.name);
    box.innerHTML = `<div class="box meal-card">
      <div class="flex items-start justify-between gap-2">
        <div class="min-w-0"><p class="text-[0.7rem] font-bold text-teal-700 uppercase tracking-wide">${esc(r.request.meal_type)} · ${esc(r.request.cuisine)} · ${esc(r.request.diet)}</p>
        <p class="font-semibold text-gray-900 text-base leading-tight mt-0.5">${esc(m.name)}</p></div>
        ${r.source === 'gemini' ? pill('Gemini', 'bg-violet-50 text-violet-700') : pill('offline pick', 'bg-amber-50 text-amber-800')}
      </div>
      ${m.description ? `<p class="text-xs text-gray-500 mt-1">${esc(m.description)}</p>` : ''}
      <div class="grid grid-cols-4 gap-1.5 text-center mt-3">
        <div class="rounded-xl p-2 bg-emerald-50"><b class="tabular-nums">${fmt(m.kcal)}</b><div class="text-[0.65rem]">kcal</div></div>
        <div class="rounded-xl p-2 bg-emerald-50"><b class="tabular-nums">${Math.round(m.protein_g)} g</b><div class="text-[0.65rem]">Protein</div></div>
        <div class="rounded-xl p-2 bg-blue-50"><b class="tabular-nums">${Math.round(m.carbs_g)} g</b><div class="text-[0.65rem]">Carbs</div></div>
        <div class="rounded-xl p-2 bg-amber-50"><b class="tabular-nums">${Math.round(m.fat_g)} g</b><div class="text-[0.65rem]">Fat</div></div>
      </div>
      <p class="text-[0.7rem] text-gray-500 mt-1.5">Fibre ${m.fiber_g} g · ${esc(m.quantity)} · ~${m.prep_min} min · your target for this meal ≈ ${fmt(r.target.kcal)} kcal / ${r.target.protein_g} g protein</p>
      ${m.ingredients.length ? `<p class="text-xs font-semibold text-gray-700 mt-2">Ingredients</p><ul class="list-disc pl-5 text-xs space-y-0.5">${m.ingredients.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : ''}
      ${m.why ? `<p class="text-xs bg-teal-50 text-teal-900 rounded-lg p-2 mt-2">💡 ${esc(m.why)}</p>` : ''}
      <div class="flex gap-2 mt-3">
        <button type="button" id="mealNextBtn" class="btn-ghost flex-1">🔄 Next Suggestion</button>
        ${logBtn({ name: m.name, quantity: m.quantity, kcal: m.kcal, protein_g: m.protein_g, carbs_g: m.carbs_g, fat_g: m.fat_g, source: 'meal_plan' }, '+ Log meal')}
      </div></div>`;
    $('#mealNextBtn').onclick = generateMeal;
  } catch (e) {
    box.innerHTML = `<p class="text-xs text-red-600">${esc(e.message)}</p>`;
  } finally {
    mealGen.busy = false;
    $$('#mealGenBtn, #mealNextBtn').forEach((b) => { b.disabled = false; });
  }
}

const MEAL_ORDER = { breakfast: 0, lunch: 1, snacks: 2, dinner: 3, any: 4 };
function renderHostelMenu(items) {
  const box = $('#hostelMenu');
  if (!box) return;
  if (!items.length) {
    box.innerHTML = '<div class="box text-center text-xs text-gray-400 py-6">No saved menu yet — upload a photo of your mess menu above.</div>';
    return;
  }
  const sorted = [...items].sort((a, b) => (MEAL_ORDER[a.meal] ?? 4) - (MEAL_ORDER[b.meal] ?? 4) || a.id - b.id);
  box.innerHTML = `<div class="box">
    <div class="flex items-center justify-between gap-2 mb-1">
      <p class="font-semibold text-gray-900">🏫 My saved menu <span class="text-xs font-normal text-gray-400">· ${items.length} item(s)</span></p>
      <button type="button" id="menuClear" class="text-xs text-gray-400 underline">Clear all</button>
    </div>
    ${sorted.map((it) => `<div class="flex items-center gap-2 py-2 border-t border-gray-50">
      <input type="checkbox" class="menu-check" value="${it.id}" aria-label="Select ${esc(it.name)}">
      <div class="flex-1 min-w-0"><p class="font-medium text-gray-900 leading-tight">${esc(it.name)}
        <span class="text-xs font-normal text-gray-400">${esc(it.quantity || '')}${it.meal && it.meal !== 'any' ? ` · ${esc(it.meal)}` : ''}</span></p>
        <p class="text-[0.7rem] text-gray-500">${macroLine(it)}${it.tip ? ` · <span class="text-teal-700">${esc(it.tip)}</span>` : ''}</p></div>
      <button type="button" class="del-btn" data-menu-del="${it.id}" aria-label="Delete ${esc(it.name)}">Delete</button>
    </div>`).join('')}
    <button type="button" id="menuAdd" class="btn-primary w-full mt-2">+ Add to Dashboard</button>
  </div>`;
  $$('[data-menu-del]', box).forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      const r = await api(`/api/hostel-menu/${b.dataset.menuDel}`, { method: 'DELETE' });
      renderHostelMenu(r.items);
    } catch (e) { toast(`⚠️ ${e.message}`); b.disabled = false; }
  }));
  $('#menuClear').onclick = async () => {
    if (!confirm('Delete every saved menu item?')) return;
    try { renderHostelMenu((await api('/api/hostel-menu', { method: 'DELETE' })).items); } catch (e) { toast(`⚠️ ${e.message}`); }
  };
  $('#menuAdd').onclick = async (e) => {
    const ids = $$('.menu-check', box).filter((c) => c.checked).map((c) => Number(c.value));
    if (!ids.length) return toast('Tick the dishes you ate, then add them');
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const r = await post('/api/hostel-menu/log', { ids });
      toast(`✅ Added ${r.logged.length} item(s) — today ${fmt(r.totals.calories)} kcal`);
      $$('.menu-check', box).forEach((c) => { c.checked = false; });
      await loadDashboard();
    } catch (err) { toast(`⚠️ ${err.message}`); }
    btn.disabled = false;
  };
}
async function loadHostelMenu() {
  try { renderHostelMenu((await api('/api/hostel-menu')).items); } catch (e) {
    if ($('#hostelMenu')) $('#hostelMenu').innerHTML = `<p class="text-xs text-red-600">${esc(e.message)}</p>`;
  }
}
async function scanMenu(input) {
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  const status = $('#menuScanStatus');
  status.innerHTML = '<div class="flex items-center gap-2 text-xs text-gray-500"><span class="spinner"></span> AI is reading your menu…</div>';
  try {
    const r = await post('/api/hostel-menu/scan', { image: await fileToDataURL(file) });
    status.innerHTML = r.added.length
      ? `<p class="text-xs text-emerald-700 bg-emerald-50 rounded-lg p-2">✅ Saved ${r.added.length} dish(es) to your menu.${r.source === 'demo' ? ' (AI offline — sample menu.)' : ''}${r.notes ? ` ${esc(r.notes)}` : ''}</p>`
      : `<p class="text-xs text-gray-500">${esc(r.notes)}</p>`;
    renderHostelMenu(r.items);
  } catch (e) {
    status.innerHTML = `<p class="text-xs text-red-600">${esc(e.message)}</p>`;
  }
}

let scanner = null;
async function startScanner() {
  if (typeof Html5Qrcode === 'undefined') return toast('⚠️ Scanner library failed to load — type the barcode instead.');
  const reader = $('#reader');
  reader.hidden = false;
  $('#scanStart').hidden = true;
  $('#scanStop').hidden = false;
  try {
    const F = Html5QrcodeSupportedFormats;
    scanner = new Html5Qrcode('reader', { formatsToSupport: [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_128], verbose: false });
    await scanner.start({ facingMode: 'environment' }, { fps: 10, qrbox: { width: 260, height: 130 } }, async (code) => {
      await stopScanner();
      $('#barcodeInput').value = code;
      lookupBarcode(code);
    }, () => {});
  } catch (e) {
    toast(`⚠️ Camera unavailable (${String(e.message || e).slice(0, 60)}) — type the barcode instead.`, 4000);
    await stopScanner();
  }
}
async function stopScanner() {
  const s = scanner;
  scanner = null;
  if (s) { try { if (s.isScanning) await s.stop(); s.clear(); } catch { /* already stopped */ } }
  if ($('#reader')) { $('#reader').hidden = true; $('#scanStart').hidden = false; $('#scanStop').hidden = true; }
}

async function lookupBarcode(code) {
  const box = $('#barcodeResult');
  box.innerHTML = '<p class="text-xs text-gray-400">Looking up on Open Food Facts…</p>';
  try {
    const p = await api(`/api/barcode/${encodeURIComponent(code)}`);
    const grams = p.serving_g || 100;
    box.innerHTML = `<div class="flex gap-3 items-start bg-gray-50 rounded-xl p-3">
      ${p.image ? `<img src="${esc(p.image)}" alt="" class="w-14 h-14 object-contain rounded-lg bg-white">` : '<div class="w-14 h-14 rounded-lg bg-white grid place-items-center text-2xl">📦</div>'}
      <div class="flex-1 min-w-0">
        <p class="font-semibold text-gray-900 leading-tight">${esc(p.name)}</p>
        <p class="text-xs text-gray-500">${esc(p.brand)} ${p.package ? `· ${esc(p.package)}` : ''} · per 100 g: ${macroLine(p.per100)}</p>
        ${p.has_nutrition ? '' : '<p class="text-xs text-amber-700">No nutrition data on Open Food Facts — values may be 0.</p>'}
        <div class="flex items-center gap-2 mt-2">
          <input id="bcGrams" type="number" min="1" max="2000" value="${grams}" class="input w-20"> <span class="text-xs">g</span>
          <span id="bcCalc" class="text-xs text-gray-600 flex-1"></span>
          <button type="button" id="bcLog" class="log-btn">+ Log</button>
        </div>
      </div></div>`;
    const calc = () => {
      const g = Math.max(0, Number($('#bcGrams').value) || 0) / 100;
      const m = { kcal: p.per100.kcal * g, protein_g: p.per100.protein_g * g, carbs_g: p.per100.carbs_g * g, fat_g: p.per100.fat_g * g };
      $('#bcCalc').textContent = macroLine(m);
      return m;
    };
    calc();
    $('#bcGrams').oninput = calc;
    $('#bcLog').onclick = (e) => {
      const m = calc();
      logMeals([{ name: p.brand ? `${p.name} (${p.brand})` : p.name, quantity: `${$('#bcGrams').value} g`, ...m, source: 'barcode', barcode: p.barcode }], e.currentTarget);
    };
  } catch (e) {
    box.innerHTML = `<p class="text-xs text-red-600">${esc(e.message)}</p>`;
  }
}

async function runVision(input) {
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  const mode = input.dataset.vision;
  const box = mode === 'menu' ? $('#visionMenuResult') : $('#visionMealResult');
  box.innerHTML = `<div class="flex items-center gap-2 text-xs text-gray-500"><span class="spinner"></span> AI is reading your ${mode === 'menu' ? 'menu' : 'plate'}…</div>`;
  try {
    const image = await fileToDataURL(file);
    const r = await post('/api/vision', { image, mode });
    if (!r.items.length) { box.innerHTML = `<p class="text-xs text-gray-500">${esc(r.notes || 'Nothing recognised — try a clearer photo.')}</p>`; return; }
    const src = mode === 'menu' ? 'ai_menu' : 'ai_photo';
    const best = new Set((r.best_picks || []).map((b) => b.toLowerCase()));
    const rows = r.items.map((it, idx) => `<div class="flex items-center gap-2 py-1.5 border-t border-gray-100">
      <input type="checkbox" class="vis-check" data-idx="${idx}" ${mode === 'meal' ? 'checked' : ''}>
      <div class="flex-1 min-w-0"><p class="font-medium text-gray-900 leading-tight">${best.has(it.name.toLowerCase()) ? '⭐ ' : ''}${esc(it.name)}
        <span class="text-xs font-normal text-gray-400">${esc(it.quantity || '')}${it.meal && it.meal !== 'any' ? ` · ${esc(it.meal)}` : ''}</span></p>
        <p class="text-[0.7rem] text-gray-500">${macroLine(it)}${it.tip ? ` · <span class="text-teal-700">${esc(it.tip)}</span>` : ''}${it.confidence ? ` · ${esc(it.confidence)} confidence` : ''}</p></div>
      ${logBtn({ name: it.name, quantity: it.quantity, kcal: it.kcal, protein_g: it.protein_g, carbs_g: it.carbs_g, fat_g: it.fat_g, source: src })}
    </div>`).join('');
    box.innerHTML = `<div class="bg-gray-50 rounded-xl p-3">
      ${r.source === 'demo' ? '<p class="text-[0.7rem] text-amber-700 mb-1">⚠️ AI offline — showing a sample result.</p>' : ''}
      ${rows}
      ${r.notes ? `<p class="text-xs text-gray-500 mt-2">${esc(r.notes)}</p>` : ''}
      <button type="button" class="btn-primary w-full mt-2 vis-log-selected">Log selected items</button></div>`;
    box.querySelector('.vis-log-selected').onclick = (e) => {
      const picked = $$('.vis-check', box).filter((c) => c.checked).map((c) => ({ ...r.items[c.dataset.idx], source: src }));
      if (!picked.length) return toast('Tick at least one item to log');
      logMeals(picked, e.currentTarget);
    };
  } catch (e) {
    box.innerHTML = `<p class="text-xs text-red-600">${esc(e.message)}</p>`;
  }
}

// ===================================================================
// Fitness: live Mifflin–St Jeor calculator (client-side), save, food log
// ===================================================================
function readFitForm() {
  const fd = new FormData($('#fitForm'));
  return {
    weight: Number(fd.get('weight')), height: Number(fd.get('height')), age: Number(fd.get('age')),
    activity: state.fit.acts[Number(fd.get('activity'))], sex: fd.get('sex'), goal: fd.get('goal'),
  };
}
function calcTargets({ weight, height, age, sex, activity, goal }) {
  const bmr = 10 * weight + 6.25 * height - 5 * age + (sex === 'female' ? -161 : 5);
  const tdee = bmr * state.fit.mult[activity];
  const calories = Math.round({ lose: tdee - 500, maintain: tdee, recomp: tdee * 0.94, gain: tdee + 300 }[goal]);
  const protein_g = Math.round(weight * (goal === 'maintain' ? 1.4 : 1.8));
  const fat_g = Math.round((calories * 0.25) / 9);
  const carbs_g = Math.round((calories - protein_g * 4 - fat_g * 9) / 4);
  return { bmr: Math.round(bmr), tdee: Math.round(tdee), calories, protein_g, carbs_g, fat_g };
}
function renderFitness() {
  const i = readFitForm();
  $$('#fitForm input[type=range]').forEach((r) => {
    $(`#o-${r.name}`).textContent = r.name === 'activity' ? i.activity.replace('_', ' ') : `${r.value} ${r.dataset.unit}`;
    r.style.setProperty('--fill', `${((r.value - r.min) / (r.max - r.min)) * 100}%`);
  });
  const t = calcTargets(i);
  $('#fitResult').innerHTML = `
    <div class="grid grid-cols-3 gap-2 text-center">
      <div class="bg-gray-50 rounded-xl p-2"><div class="font-bold text-gray-900 tabular-nums">${fmt(t.bmr)}</div><div class="text-xs">BMR</div></div>
      <div class="bg-gray-50 rounded-xl p-2"><div class="font-bold text-gray-900 tabular-nums">${fmt(t.tdee)}</div><div class="text-xs">TDEE</div></div>
      <div class="bg-emerald-50 rounded-xl p-2"><div class="font-bold text-emerald-700 tabular-nums">${fmt(t.calories)}</div><div class="text-xs">Target kcal</div></div>
    </div>
    <div class="grid grid-cols-3 gap-2 text-center mt-2">
      <div class="rounded-xl p-2 bg-emerald-50"><b>${t.protein_g} g</b><div class="text-xs">Protein</div></div>
      <div class="rounded-xl p-2 bg-blue-50"><b>${t.carbs_g} g</b><div class="text-xs">Carbs</div></div>
      <div class="rounded-xl p-2 bg-amber-50"><b>${t.fat_g} g</b><div class="text-xs">Fat</div></div>
    </div>`;
}
async function saveFitness() {
  const i = readFitForm();
  try {
    const r = await post('/api/profile', { weight_kg: i.weight, height_cm: i.height, age: i.age, sex: i.sex, activity_level: i.activity, goal: i.goal }, 'PUT');
    toast(`✅ Saved — daily target ${fmt(r.profile.daily_calorie_target)} kcal`);
    loadDashboard();
  } catch (e) { toast(`⚠️ ${e.message}`); }
}

async function renderFoodLog() {
  const box = $('#foodLog');
  if (!box) return;
  try {
    const { meals, totals } = await api('/api/meals');
    const target = state.dash?.targets?.calories;
    const SRC = { barcode: '📷', ai_photo: '🤖', ai_menu: '📋', meal_plan: '🍱', recipe: '🫖', manual: '✍️' };
    box.innerHTML = `<div class="box">
      <div class="flex items-baseline justify-between"><p class="font-semibold text-gray-900">Today's food log</p>
      <p class="text-xs text-gray-500"><b class="text-gray-900">${fmt(totals.calories)}</b>${target ? ` / ${fmt(target)}` : ''} kcal</p></div>
      <p class="text-[0.7rem] text-gray-400">P ${totals.protein_g} g · C ${totals.carbs_g} g · F ${totals.fat_g} g · ${totals.items} item(s)</p>
      ${meals.length ? meals.map((m) => `<div class="flex items-center gap-2 py-2 border-t border-gray-50">
        <span class="text-lg">${SRC[m.source] || '🍽️'}</span>
        <div class="flex-1 min-w-0"><p class="font-medium text-gray-900 truncate">${esc(m.name)}</p><p class="text-[0.7rem] text-gray-500">${m.quantity ? `${esc(m.quantity)} · ` : ''}${macroLine(m)}</p></div>
        <button type="button" class="del-btn" data-del="${m.id}" aria-label="Delete ${esc(m.name)}">Delete</button></div>`).join('')
        : '<p class="text-xs text-gray-400 py-3">Nothing logged yet today. Use <button type="button" data-view="diet" class="text-teal-700 underline">Diet Planner → Scan &amp; Log</button>.</p>'}
    </div>`;
    $$('[data-del]', box).forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        await api(`/api/log-meal/${b.dataset.del}`, { method: 'DELETE' });
        toast('🗑️ Removed from log');
        await loadDashboard();
        renderFoodLog();
      } catch (e) { toast(`⚠️ ${e.message}`); b.disabled = false; }
    }));
  } catch (e) {
    box.innerHTML = `<p class="text-xs text-red-600">${esc(e.message)}</p>`;
  }
}

// ===================================================================
// Health & Recovery: lab report upload, illness roadmap checklists, condition toggles
// ===================================================================
async function uploadLabReport(input) {
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  const box = $('#labResult');
  box.innerHTML = '<div class="box flex items-center gap-2 text-xs text-gray-500"><span class="spinner"></span> AI is reading your lab report…</div>';
  try {
    const r = await post('/api/lab-report', { image: await fileToDataURL(file, 1800) });
    box.innerHTML = `<div class="box">
        <div class="flex items-center justify-between gap-2"><p class="font-semibold text-gray-900">📄 Extracted from your report</p>
        ${r.source === 'demo' ? pill('AI offline — sample', 'bg-amber-50 text-amber-800') : pill('Gemini Vision', 'bg-violet-50 text-violet-700')}</div>
        <div class="overflow-x-auto mt-1"><table class="tbl"><tr><th>Test</th><th>As printed</th><th>Normalised</th><th>Status</th></tr>
        ${r.results.map((x, i) => `<tr><td>${esc(r.extracted[i]?.test || x.metric)}</td><td>${esc(r.extracted[i]?.as_printed || '')}</td><td>${esc(x.value)} ${esc(x.unit)}</td><td>${pill(x.status, STATUS_CLS[x.status])}</td></tr>`).join('')}</table></div>
        ${r.report_date ? `<p class="text-[0.7rem] text-gray-400 mt-1">Report date: ${esc(r.report_date)}</p>` : ''}
        ${r.notes ? `<p class="text-[0.7rem] text-gray-500 mt-1">${esc(r.notes)}</p>` : ''}
        <p class="text-[0.7rem] text-gray-400 mt-1">Check these against your report — saved to your history.</p>
      </div>`
      + r.results.map((x) => `<div class="box">
      <div class="flex items-center justify-between gap-2"><p class="font-semibold text-gray-900">${esc(x.metric)}</p>${pill(x.status, STATUS_CLS[x.status])}</div>
      <p class="text-xs text-gray-500">${esc(x.value)} ${esc(x.unit)} · reference ${esc(x.reference_range)}</p>
      <p class="text-xs font-semibold text-gray-700 mt-2">🍽️ Food fix (${esc(r.diet_type)})</p>
      <ul class="list-disc pl-5 text-xs space-y-0.5">${x.fixes.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
      ${x.top_foods.length ? `<div class="mt-2">${x.top_foods.map((f) => pill(f, 'bg-gray-50 text-gray-600')).join('')}</div>` : ''}
      ${x.status !== 'normal' ? `<p class="text-xs bg-amber-50 text-amber-800 rounded-lg p-2 mt-2">${esc(x.note)}</p>` : ''}
    </div>`).join('');
  } catch (err) {
    box.innerHTML = `<p class="text-xs text-red-600">${esc(err.message)}</p>`;
  }
}

const roadmapState = { plan: 'viral_cold', data: null };
async function loadRoadmap(plan) {
  roadmapState.plan = plan;
  const box = $('#roadmap');
  if (!box) return;
  box.innerHTML = '<p class="text-xs text-gray-400">Loading…</p>';
  try {
    roadmapState.data = await api(`/api/recovery/${plan}`);
    renderRoadmap();
  } catch (e) { box.innerHTML = `<p class="text-xs text-red-600">${esc(e.message)}</p>`; }
}
function renderRoadmap() {
  const d = roadmapState.data;
  const done = new Set(d.checks.map((c) => `${c.day}:${c.item}`));
  const total = d.phases.reduce((s, p) => s + p.items.length, 0);
  const pct = Math.round((done.size / total) * 100);
  const tex = { liquid: '💧', 'semi-solid': '🥣', solid: '🍛' };
  $('#roadmap').innerHTML = `
    <p class="text-xs bg-red-50 text-red-700 rounded-lg p-2">⚠️ ${esc(d.warning)}</p>
    <div class="flex items-center gap-2 mt-3"><div class="flex-1 h-2 rounded-full bg-gray-100 overflow-hidden"><div class="h-full bg-teal-500 rounded-full" style="width:${pct}%"></div></div><span class="text-xs font-semibold text-gray-700">${pct}%</span></div>
    ${d.phases.map((p) => {
      const n = p.items.filter((_, i) => done.has(`${p.from}:${i}`)).length;
      return `<div class="box mt-3 phase-card">
        <div class="flex items-center justify-between gap-2">
          <p class="font-semibold text-gray-900">${tex[p.texture] || ''} Day ${p.from}–${p.to} · ${esc(p.name)}</p>
          <span class="text-[0.7rem] font-semibold ${n === p.items.length ? 'text-emerald-700' : 'text-gray-400'}">${n}/${p.items.length}</span>
        </div>
        <p class="text-xs text-gray-500 mb-1">${esc(p.goal)}</p>
        ${p.items.map((it, i) => `<label class="check-row"><input type="checkbox" data-phase="${p.from}" data-item="${i}" ${done.has(`${p.from}:${i}`) ? 'checked' : ''}><span>${esc(it)}</span></label>`).join('')}
      </div>`;
    }).join('')}
    <button type="button" id="roadReset" class="text-xs text-gray-400 underline mt-2">Reset ${esc(d.condition)} progress</button>`;
  $$('#roadmap [data-item]').forEach((c) => c.addEventListener('change', async () => {
    try {
      const r = await post(`/api/recovery/${roadmapState.plan}/check`, { day: Number(c.dataset.phase), item: Number(c.dataset.item), done: c.checked });
      roadmapState.data.checks = r.checks;
      renderRoadmap();
    } catch (e) { toast(`⚠️ ${e.message}`); c.checked = !c.checked; }
  }));
  $('#roadReset').onclick = async () => {
    try {
      roadmapState.data.checks = (await post(`/api/recovery/${roadmapState.plan}/check`, { reset: true })).checks;
      renderRoadmap();
    } catch (e) { toast(`⚠️ ${e.message}`); }
  };
}

let condState = null;
async function loadConditions() {
  try { condState = await api('/api/conditions'); renderConditions(); } catch (e) { $('#condBox').innerHTML = `<p class="text-xs text-red-600">${esc(e.message)}</p>`; }
}
function renderConditions() {
  const active = new Set(condState.active);
  $('#condBox').innerHTML = `<p class="text-xs text-gray-500 mb-2">Toggle a condition ON to see food warnings. Saved to your profile — the AI assistant uses them too.</p>`
    + Object.entries(condState.conditions).map(([k, c]) => `<div class="box ${active.has(k) ? 'box-on' : ''}">
      <label class="flex items-center justify-between gap-3 cursor-pointer">
        <span class="font-semibold text-gray-900">${c.icon} ${esc(c.condition)}</span>
        <span class="switch"><input type="checkbox" data-cond="${k}" ${active.has(k) ? 'checked' : ''}><i></i></span>
      </label>
      ${active.has(k) ? `<p class="text-xs bg-teal-50 text-teal-800 rounded-lg p-2 my-2">${esc(c.principle)}</p>
        <p class="text-xs font-semibold text-red-700">⚠️ Food warnings</p>
        <ul class="text-xs space-y-1 mt-1">${c.warnings.map((w) => `<li class="warn-row"><b>${esc(w.food)}</b> — ${esc(w.why)}</li>`).join('')}</ul>
        <div class="overflow-x-auto mt-2"><table class="tbl"><tr><th>Instead of</th><th>Choose</th></tr>${c.swaps.map((s) => `<tr><td class="text-gray-400">${esc(s.from)}</td><td>✅ ${esc(s.to)}</td></tr>`).join('')}</table></div>
        <ul class="list-disc pl-5 mt-2 space-y-0.5 text-xs">${c.rules.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
    </div>`).join('');
  $$('[data-cond]').forEach((t) => t.addEventListener('change', async () => {
    const next = $$('[data-cond]').filter((x) => x.checked).map((x) => x.dataset.cond);
    try { condState.active = (await post('/api/conditions', { active: next }, 'PUT')).active; renderConditions(); } catch (e) { toast(`⚠️ ${e.message}`); t.checked = !t.checked; }
  }));
}

// ===================================================================
// Supplements: interaction checker + quiz
// ===================================================================
async function checkInteractions(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const qs = new URLSearchParams({ medications: fd.get('med') });
  if (fd.get('supp')) qs.set('supplement', fd.get('supp'));
  const box = $('#interactionResult');
  try {
    const r = await api(`/api/supplements?${qs}`);
    const color = { high: 'bg-red-50 text-red-700', moderate: 'bg-amber-50 text-amber-800', low: 'bg-gray-50 text-gray-600' };
    box.innerHTML = r.safe
      ? `<p class="bg-emerald-50 text-emerald-700 rounded-xl p-2 text-xs">✅ No known interactions between <b>${esc(fd.get('med'))}</b> and ${fd.get('supp') ? esc(fd.get('supp')) : 'our supplement list'}. ${esc(r.disclaimer)}</p>`
      : r.warnings.map((w) => `<p class="${color[w.severity]} rounded-xl p-2 text-xs mb-1"><b>${esc(w.supplement)} + ${esc(w.medication)}</b> · ${w.severity.toUpperCase()}: ${esc(w.note)}</p>`).join('')
        + `<p class="text-[0.7rem] text-gray-400">${esc(r.disclaimer)}</p>`;
  } catch (err) { box.innerHTML = `<p class="text-xs text-red-600">${esc(err.message)}</p>`; }
}

async function runQuiz(e) {
  e.preventDefault();
  const box = $('#quizResult');
  box.innerHTML = '<div class="flex items-center gap-2 text-xs text-gray-500"><span class="spinner"></span> Building your recommendations…</div>';
  try {
    const r = await post('/api/supplements/quiz', Object.fromEntries(new FormData(e.target)));
    const prio = { essential: 'bg-red-50 text-red-700', recommended: 'bg-emerald-50 text-emerald-700', consider: 'bg-amber-50 text-amber-800', optional: 'bg-gray-100 text-gray-600', doctor: 'bg-violet-50 text-violet-700' };
    box.innerHTML = (r.ai_note ? `<p class="text-xs bg-teal-50 text-teal-900 rounded-xl p-3">🤖 ${esc(r.ai_note)}</p>` : '')
      + (r.recommendations.length ? r.recommendations.map((s) => `<div class="border border-gray-100 rounded-xl p-3">
        <div class="flex justify-between gap-2"><p class="font-semibold text-gray-900">${esc(s.name)}</p>${pill(s.priority, prio[s.priority])}</div>
        <p class="text-xs text-gray-600 mt-0.5">${esc(s.reason)}</p>
        <p class="text-[0.7rem] text-gray-500 mt-1">Dose: ${esc(s.typical_dose)} · Evidence: ${esc(s.evidence_level)}</p>
        <p class="text-[0.7rem] mt-1">🇮🇳 Food-first: ${esc(s.local_alternative)}</p>
        ${s.interactions.length ? `<p class="text-[0.7rem] bg-red-50 text-red-700 rounded-lg p-1.5 mt-1">⚠️ With your meds: ${s.interactions.map(esc).join('; ')}</p>` : ''}
      </div>`).join('') : '<p class="text-xs text-emerald-700 bg-emerald-50 rounded-xl p-2">✅ Your diet and lifestyle likely cover your needs — no supplements recommended.</p>')
      + `<p class="text-[0.7rem] text-gray-400">${esc(r.disclaimer)}</p>`;
  } catch (err) { box.innerHTML = `<p class="text-xs text-red-600">${esc(err.message)}</p>`; }
}

// ===================================================================
// Profile actions
// ===================================================================
async function syncHealth() {
  const btn = $('#syncBtn');
  btn.disabled = true;
  btn.textContent = 'Syncing…';
  try {
    const r = await post('/api/health-sync', { source: $('#syncSource').value });
    toast(`🔄 Synced ${SOURCE_LABEL[r.source]}: ${fmt(r.steps)} steps · ${fmt(r.calories_burned)} kcal burned`);
    await loadDashboard();
  } catch (e) { toast(`⚠️ ${e.message}`); }
  btn.disabled = false;
  btn.textContent = 'Sync Health App';
}

async function testEmail() {
  const btn = $('#testEmailBtn');
  btn.disabled = true;
  try {
    const r = await post('/api/email/test');
    toast(r.delivered ? `📧 Test email sent to ${r.to}` : '📝 Email rendered & written to the server log (SMTP not configured)', 4000);
  } catch (e) { toast(`⚠️ ${e.message}`, 4000); }
  btn.disabled = false;
}

async function saveProfile(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const body = Object.fromEntries([...fd.entries()].filter(([k]) => k !== 'appliances'));
  body.appliances = fd.getAll('appliances');
  try {
    const r = await post('/api/profile', body, 'PUT');
    $('#profTarget').textContent = fmt(r.profile.daily_calorie_target);
    toast(`✅ Profile saved — new target ${fmt(r.profile.daily_calorie_target)} kcal`);
    loadDashboard();
  } catch (err) { toast(`⚠️ ${err.message}`); }
}

// ===================================================================
// Forms routed globally
// ===================================================================
document.addEventListener('submit', async (e) => {
  const id = e.target.id;
  if (id === 'fitForm') e.preventDefault();
  if (id === 'barcodeForm') {
    e.preventDefault();
    const code = $('#barcodeInput').value.replace(/\D/g, '');
    if (code) lookupBarcode(code);
  }
  if (id === 'manualForm') {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const r = await logMeals([{ ...f, kcal: Number(f.kcal), protein_g: Number(f.protein_g), carbs_g: Number(f.carbs_g), fat_g: Number(f.fat_g), source: 'manual' }]);
    if (r) e.target.reset();
  }
  if (id === 'searchForm') {
    e.preventDefault();
    const q = $('#searchInput').value.trim();
    if (!q) return;
    $('#searchInput').value = '';
    await showView('chat');
    sendChat(q);
  }
});

// ===================================================================
// Chat
// ===================================================================
const chatLog = [];
let chatLoaded = false;
function renderChat() {
  if (state.view !== 'chat') return;
  $('#sheetBody').innerHTML = chatLog.length
    ? chatLog.map((m) => `<div class="flex ${m.role === 'user' ? 'justify-end' : ''}"><div class="${m.role === 'user' ? 'chat-bubble-user' : 'chat-bubble-ai'} rounded-2xl px-3 py-2 max-w-[85%] whitespace-pre-wrap">${esc(m.text)}</div></div>`).join('')
    : `<p class="text-gray-400">Try one of these:</p>
       ${['I live in a hostel with only a kettle — how do I get 80g protein?', 'Why am I still anaemic even though I eat palak?', 'What should I eat on day 2 of food poisoning?']
        .map((q) => `<button type="button" class="chat-suggest block w-full text-left bg-gray-50 hover:bg-teal-50 rounded-xl px-3 py-2 text-gray-700">${esc(q)}</button>`).join('')}`;
  $('#sheetBody').scrollTop = $('#sheetBody').scrollHeight;
}
document.addEventListener('click', (e) => { const s = e.target.closest('.chat-suggest'); if (s) sendChat(s.textContent); });

async function sendChat(text) {
  chatLog.push({ role: 'user', text }, { role: 'model', text: 'Thinking…' });
  const slot = chatLog[chatLog.length - 1];
  renderChat();
  try {
    const r = await post('/api/chat', { message: text });
    slot.text = r.reply || r.error || 'No reply.';
  } catch (e) {
    slot.text = `⚠️ ${e.message}`;
  }
  renderChat();
}
$('#chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('#chatInput').value.trim();
  if (!text) return;
  $('#chatInput').value = '';
  sendChat(text);
});

// ===================================================================
// Boot
// ===================================================================
// Reject if a promise takes longer than `ms` (stops a hung network call from freezing boot)
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out`)), ms))]);
const screenShown = () => !$('#authScreen').hidden || !$('#app').hidden;

async function boot() {
  try { applyLayout(); } catch (e) { console.error('Layout init failed', e); }
  try {
    state.config = await withTimeout(fetch('/api/config').then((r) => r.json()), 5000, '/api/config');
  } catch (e) {
    console.error('Config load failed', e);
    state.config = { firebase: null, demoLogin: false };
  }
  // Firebase SDK is loaded with `defer`; give it a moment, but never block on it
  if (state.config.firebase) {
    try {
      if (!window.firebase && !window.__firebaseLoadFailed && document.readyState === 'loading') {
        await withTimeout(new Promise((r) => document.addEventListener('DOMContentLoaded', r, { once: true })), 4000, 'Firebase SDK');
      }
      if (!window.firebase) throw new Error('Firebase SDK not available');
      firebase.initializeApp(state.config.firebase);
      fbAuth = firebase.auth();
      const redirect = await withTimeout(fbAuth.getRedirectResult(), 5000, 'Firebase redirect');
      if (redirect?.user) return await exchangeFirebaseUser(redirect.user);
    } catch (e) {
      console.error('Firebase init failed — continuing without Google sign-in', e);
      fbAuth = null;
    }
  }
  if (state.token) {
    try {
      const me = await withTimeout(api('/api/me'), 5000, '/api/me');
      return await enterApp(me.user, me.needsOnboarding);
    } catch (e) { console.warn('Session restore failed', e); }
  }
  showAuth();
}

// Watchdog: whatever happens above, never leave the user on a blank/loading screen
setTimeout(() => { if (!screenShown()) { console.warn('Boot stalled — showing login'); showAuth(); } }, 8000);

fetch('/api/health').then((r) => r.json()).then((h) => {
  $('#statusLine').innerHTML = `DB: ${h.status === 'ok' ? 'Postgres (Neon)' : 'unreachable'}<br>AI: ${h.ai === 'gemini' ? 'Gemini' : 'offline demo'}<br>Auth: ${h.auth === 'firebase' ? 'Google' : 'demo'} · Mail: ${h.email === 'smtp' ? 'SMTP' : 'log only'}`;
}).catch(() => { $('#statusLine').textContent = 'Server unreachable'; });

boot().catch((e) => { console.error('Boot failed', e); showAuth(); });
