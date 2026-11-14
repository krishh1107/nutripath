require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const db = require('./db');
const auth = require('./auth');
const mailer = require('./mailer');
const { FOODS, RECIPES, SUPPLEMENTS, SUPPLEMENT_WARNINGS } = require('./data');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '8mb' })); // meal / menu photos arrive as base64
app.use(express.static(path.join(__dirname, 'public')));

const num = (v) => (v === null || v === undefined || v === '' ? undefined : Number(v));
const toList = (v) => (Array.isArray(v) ? v : String(v ?? '').split(','))
  .map((s) => String(s).trim()).filter(Boolean);
const clampNum = (v, min, max) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
};
const round1 = (n) => Math.round(Number(n) * 10) / 10;
// Wrap async handlers so a thrown error becomes a JSON 500 instead of a hung request
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------------------------------------------------------------------------
// Gemini (chat, vision, supplement quiz). Offline fallbacks when no key is set.
// ---------------------------------------------------------------------------
let genAI = null;
const apiKey = process.env.GEMINI_API_KEY;
if (apiKey && apiKey !== 'your_gemini_api_key_here') genAI = new GoogleGenerativeAI(apiKey);
const CHAT_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
// Gemini 1.5 Flash (and 2.5 Flash for new keys) has been retired by Google; 3.5 Flash is the multimodal successor.
const VISION_MODEL = process.env.GEMINI_VISION_MODEL || CHAT_MODEL;
const AI_TIMEOUT = { timeout: Number(process.env.GEMINI_TIMEOUT_MS || 30000) }; // never let a slow model hang a request

// ===========================================================================
// PUBLIC ROUTES (no session required)
// ===========================================================================
app.get('/api/health', async (req, res) => {
  let stats = null;
  let dbError = null;
  try { stats = await db.stats(); } catch (err) { dbError = db.describeError(err); }
  res.status(dbError ? 503 : 200).json({
    status: dbError ? 'degraded' : 'ok', db: 'postgres', db_host: db.getPath(), ...(dbError ? { db_error: dbError } : {}),
    ai: genAI ? 'gemini' : 'offline', auth: auth.firebaseEnabled ? 'firebase' : 'demo',
    email: mailer.smtpConfigured ? 'smtp' : 'console', stats,
  });
});

app.get('/api/config', (req, res) => res.json({
  firebase: auth.firebaseEnabled ? auth.FIREBASE : null,
  demoLogin: auth.demoLoginEnabled,
}));

function sessionPayload(user, isNew) {
  return { token: auth.signSession(user.id), user, isNew, needsOnboarding: !user.onboarded };
}

// Google sign-in: exchange a Firebase ID token for an app session; upserts the users row
app.post('/api/auth/login', h(async (req, res) => {
  let claims;
  try {
    claims = await auth.verifyFirebaseIdToken(req.body?.idToken);
  } catch (err) {
    return res.status(401).json({ error: `Sign-in failed: ${err.message}` });
  }
  const { user, isNew } = await db.upsertUser({
    firebase_uid: claims.sub, email: claims.email, name: claims.name || claims.email?.split('@')[0],
    photo_url: claims.picture, provider: 'google',
  });
  res.json(sessionPayload(user, isNew));
}));

// Demo sign-in (only when Firebase is not configured, or ALLOW_DEMO_LOGIN=true)
app.post('/api/auth/demo', async (req, res) => {
  if (!auth.demoLoginEnabled) return res.status(403).json({ error: 'Demo sign-in is disabled — use Google sign-in.' });
  const name = String(req.body?.name || '').trim().slice(0, 60);
  const email = String(req.body?.email || '').trim().toLowerCase().slice(0, 200);
  if (!name) return res.status(400).json({ error: 'Name is required' });
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Email looks invalid' });
  const { user, isNew } = await db.upsertUser({
    firebase_uid: `demo:${email || name.toLowerCase()}`, email: email || null, name, provider: 'demo',
  });
  res.json(sessionPayload(user, isNew));
});

// Everything below requires a session
app.use('/api', auth.requireAuth(db));

// ===========================================================================
// MODULE 1. FITNESS — Mifflin–St Jeor BMR → TDEE → goal-adjusted macro targets
// ===========================================================================
const ACTIVITY = { sedentary: 1.2, light: 1.375, moderate: 1.55, active: 1.725, very_active: 1.9 };
const GOAL_ADJ = {
  lose: (tdee) => tdee - 500,
  maintain: (tdee) => tdee,
  recomp: (tdee) => tdee * 0.94, // small deficit + high protein
  gain: (tdee) => tdee + 300,
};
const DIET_TYPES = ['vegetarian', 'eggetarian', 'non-veg', 'vegan'];

function calcTargets({ weight, height, age, sex, activity = 'moderate', goal = 'maintain' }) {
  const bmr = 10 * weight + 6.25 * height - 5 * age + (sex === 'female' ? -161 : 5);
  const tdee = bmr * (ACTIVITY[activity] || ACTIVITY.moderate);
  const calories = Math.round((GOAL_ADJ[goal] || GOAL_ADJ.maintain)(tdee));
  const protein_g = Math.round(weight * (goal === 'maintain' ? 1.4 : 1.8));
  const fat_g = Math.round((calories * 0.25) / 9);
  const carbs_g = Math.round((calories - protein_g * 4 - fat_g * 9) / 4);
  return {
    bmr: Math.round(bmr), tdee: Math.round(tdee), calories,
    macros: { protein_g, carbs_g, fat_g },
    split_pct: {
      protein: Math.round((protein_g * 4 / calories) * 100),
      carbs: Math.round((carbs_g * 4 / calories) * 100),
      fat: Math.round((fat_g * 9 / calories) * 100),
    },
  };
}

const profileToInput = (p = {}) => ({
  weight: Number(p.weight_kg ?? 65), height: Number(p.height_cm ?? 170), age: Number(p.age ?? 25),
  sex: p.sex ?? 'male', activity: p.activity_level ?? 'light', goal: p.goal ?? 'maintain',
});

function validateBody(update) {
  for (const [k, lo, hi] of [['age', 10, 110], ['height_cm', 100, 250], ['weight_kg', 20, 300], ['monthly_food_budget', 0, 1e6], ['daily_water_target', 1, 30]]) {
    if (update[k] !== undefined && (!Number.isFinite(update[k]) || update[k] < lo || update[k] > hi)) return `${k} must be between ${lo} and ${hi}`;
  }
  if (update.sex && !['male', 'female'].includes(update.sex)) return 'sex must be male or female';
  if (update.activity_level && !ACTIVITY[update.activity_level]) return `activity_level must be one of: ${Object.keys(ACTIVITY).join(', ')}`;
  if (update.goal && !GOAL_ADJ[update.goal]) return `goal must be one of: ${Object.keys(GOAL_ADJ).join(', ')}`;
  if (update.diet_type && !DIET_TYPES.includes(update.diet_type)) return `diet_type must be one of: ${DIET_TYPES.join(', ')}`;
  return null;
}

// Updates the profile and keeps daily_calorie_target in sync with the Mifflin–St Jeor result
async function saveProfile(userId, update) {
  const clean = Object.fromEntries(Object.entries(update).filter(([, v]) => v !== undefined));
  const merged = { ...(await db.getHealthProfile(userId)), ...clean };
  const targets = calcTargets(profileToInput(merged));
  clean.daily_calorie_target = targets.calories;
  return { profile: await db.updateHealthProfile(userId, clean), targets };
}

app.get('/api/fitness', async (req, res) => {
  const base = profileToInput(await db.getHealthProfile(req.user.id));
  const q = req.query;
  const input = {
    weight: num(q.weight) ?? base.weight, height: num(q.height) ?? base.height, age: num(q.age) ?? base.age,
    sex: q.sex ?? base.sex, activity: q.activity ?? base.activity, goal: q.goal ?? base.goal,
  };
  if ([input.weight, input.height, input.age].some((n) => !Number.isFinite(n) || n <= 0)) {
    return res.status(400).json({ error: 'weight, height and age must be positive numbers' });
  }
  if (!ACTIVITY[input.activity]) return res.status(400).json({ error: `activity must be one of: ${Object.keys(ACTIVITY).join(', ')}` });
  if (!GOAL_ADJ[input.goal]) return res.status(400).json({ error: `goal must be one of: ${Object.keys(GOAL_ADJ).join(', ')}` });
  if (!['male', 'female'].includes(input.sex)) return res.status(400).json({ error: 'sex must be male or female' });
  res.json({
    algorithm: 'Mifflin-St Jeor', input, targets: calcTargets(input),
    options: { activity: ACTIVITY, goals: Object.keys(GOAL_ADJ) },
    workout_fuel: buildWorkoutFuel(input),
  });
});

// Pre/Post-workout fuel timeline, scaled to body weight (ISSN timing guidance)
function buildWorkoutFuel({ weight }) {
  const preCarb = Math.round(weight * 1); // ~1 g/kg 1–3 h before
  const postProtein = Math.round(Math.min(40, Math.max(20, weight * 0.3)));
  const postCarb = Math.round(weight * 0.8);
  return [
    { when: '−3 to −2 h', title: 'Pre-workout meal', target: `~${preCarb} g carbs + 20 g protein, low fat & fibre`,
      foods: ['Poha with peanuts + curd', '2 roti + dal + sabzi', 'Idli (3) + sambar'], icon: '🍛' },
    { when: '−45 to −30 min', title: 'Top-up snack (optional)', target: 'Quick carbs, easy to digest',
      foods: ['1 banana', '3–4 dates', 'Black coffee if you tolerate it'], icon: '🍌' },
    { when: 'During', title: 'Hydrate', target: '150–250 ml water every 15–20 min; ORS / nimbu-pani with salt if > 60 min or very hot',
      foods: ['Water', 'Nimbu-pani with pinch of salt', 'Coconut water'], icon: '💧' },
    { when: '0 to +1 h', title: 'Post-workout recovery', target: `${postProtein} g protein + ~${postCarb} g carbs`,
      foods: ['Sattu shake + banana', 'Paneer bhurji + 2 roti', '3 eggs + toast', 'Soya chunk bhel'], icon: '💪' },
    { when: '+2 to +3 h', title: 'Balanced meal', target: 'Protein again + vegetables + complex carbs',
      foods: ['Rajma/chole + rice + salad', 'Dal + millet roti + curd'], icon: '🥗' },
  ];
}

// ===========================================================================
// MODULE 2. DIET PLANNER — meal plans, hostel optimizer, local swaps, chai timer
// ===========================================================================
// Rough carb/fat split for plan items that only list kcal + protein (fat ≈ 28% kcal)
const estimateMacros = (kcal, protein_g) => {
  const fat_g = Math.round((kcal * 0.28) / 9);
  return { kcal, protein_g, fat_g, carbs_g: Math.max(0, Math.round((kcal - protein_g * 4 - fat_g * 9) / 4)) };
};

const MEAL_PLANS = {
  protein_balance: {
    title: 'Fix the 80% Carb Plate',
    problem: 'Typical Indian thali is ~80% carbs (rice/roti) with very little protein.',
    rule: 'Half plate sabzi, quarter dal/paneer/egg, quarter rice/roti.',
    meals: [
      { slot: 'Breakfast', items: ['Moong dal chilla (2) with paneer stuffing', 'Curd (1 bowl)'], kcal: 420, protein_g: 26 },
      { slot: 'Lunch', items: ['2 roti (not 4)', 'Rajma (1.5 katori)', 'Cucumber raita', 'Salad'], kcal: 560, protein_g: 24 },
      { slot: 'Snack', items: ['Roasted chana (40g)', 'Buttermilk'], kcal: 220, protein_g: 12 },
      { slot: 'Dinner', items: ['Small rice portion', 'Soya chunk curry', 'Palak sabzi'], kcal: 520, protein_g: 30 },
    ],
  },
  iron_lemon_hack: {
    title: 'Iron + Vitamin C (Lemon Hack)',
    problem: 'Non-heme iron from plants absorbs poorly; Vitamin C boosts absorption 2–3×.',
    rule: 'Squeeze lemon on dal/sabzi; pair iron foods with amla, guava or tomato. Keep chai/coffee 45–60 min away from meals.',
    meals: [
      { slot: 'Breakfast', items: ['Poha with peanuts + lemon squeeze', 'Guava (1)'], kcal: 380, protein_g: 10 },
      { slot: 'Lunch', items: ['Palak dal + lemon', 'Bajra roti (2)', 'Kachumber salad with tomato'], kcal: 540, protein_g: 20 },
      { slot: 'Snack', items: ['Til chikki + roasted chana', 'Amla (1) or amla juice'], kcal: 200, protein_g: 8 },
      { slot: 'Dinner', items: ['Rajma/chole with lemon & onion', 'Rice (small)', 'Methi sabzi'], kcal: 560, protein_g: 20 },
    ],
  },
  b12_omega3: {
    title: 'Vitamin B12 & Omega-3 Repair',
    problem: 'Vegetarians commonly lack B12 (animal-only nutrient) and EPA/DHA omega-3.',
    rule: 'Daily dairy/eggs for B12; flaxseed/walnut/chia for ALA omega-3. Consider supplementing B12 if deficient (doctor-tested).',
    meals: [
      { slot: 'Breakfast', items: ['2 boiled eggs or paneer bhurji', 'Toast with flaxseed chutney'], kcal: 400, protein_g: 22 },
      { slot: 'Lunch', items: ['Curd rice with tempering', 'Sprouts salad + walnuts'], kcal: 520, protein_g: 18 },
      { slot: 'Snack', items: ['Milk (1 glass) with 1 tbsp chia seeds'], kcal: 220, protein_g: 10 },
      { slot: 'Dinner', items: ['Fish curry (non-veg) OR paneer tikka', '2 roti', 'Mixed veg'], kcal: 560, protein_g: 30 },
    ],
  },
};
for (const plan of Object.values(MEAL_PLANS)) plan.meals = plan.meals.map((m) => ({ ...m, ...estimateMacros(m.kcal, m.protein_g) }));

const SUBSTITUTION_PAIRS = [
  { from: 'Quinoa', to: ['Soy Chunks', 'Foxtail Millet'], why: 'Soy chunks have ~3.5× the protein of quinoa; millets match its fibre and low GI at a fraction of the cost.' },
  { from: 'Whey Protein', to: ['Sattu (Roasted Chana Flour)', 'Paneer'], why: 'Sattu gives protein + fibre for ~₹6 a glass; paneer adds casein, calcium and B12.' },
  { from: 'Blueberries', to: ['Amla (Indian Gooseberry)', 'Guava'], why: 'One amla has more Vitamin C than a whole punnet of imported berries — and boosts iron absorption.' },
  { from: 'Walnuts', to: ['Flaxseed'], why: 'Ground flaxseed has ~2.5× the ALA omega-3 of walnuts at a quarter of the price.' },
];
const CHAI_BLOCKER = {
  title: 'Chai-Time Iron Blocker', minutes: 45,
  explanation: 'Tannins (polyphenols) in tea and coffee bind non-heme iron in the gut. Chai with or right after a meal can cut iron absorption by more than half.',
  rule: 'Wait at least 45 minutes after an iron-rich meal before chai/coffee — or have it 1 hour before eating.',
};

function buildSubstitutions() {
  const byName = Object.fromEntries(FOODS.map((f) => [f.name, f]));
  return SUBSTITUTION_PAIRS.map((p) => {
    const from = byName[p.from];
    const to = p.to.map((n) => byName[n]).filter(Boolean);
    const cheapest = Math.min(...to.map((t) => t.cost_inr_per_kg));
    return { from, to, why: p.why, savings_pct: from ? Math.round((1 - cheapest / from.cost_inr_per_kg) * 100) : null };
  });
}

app.get('/api/diet-planner', async (req, res) => {
  const { focus } = req.query;
  if (focus) {
    const plan = MEAL_PLANS[focus];
    if (!plan) return res.status(404).json({ error: `Unknown focus. Use one of: ${Object.keys(MEAL_PLANS).join(', ')}` });
    const total_kcal = plan.meals.reduce((s, m) => s + m.kcal, 0);
    const total_protein_g = plan.meals.reduce((s, m) => s + m.protein_g, 0);
    await db.saveMealPlan(req.user.id, focus, plan.meals, total_kcal);
    return res.json({ focus, ...plan, total_kcal, total_protein_g });
  }
  const profile = (await db.getHealthProfile(req.user.id)) || {};
  const kettleOnly = ['1', 'true', 'yes'].includes(String(req.query.kettle_only ?? '').toLowerCase());
  let appliances;
  if (kettleOnly) appliances = ['kettle'];
  else if (req.query.appliances !== undefined) appliances = toList(req.query.appliances).filter((a) => a !== 'none');
  else appliances = profile.appliances?.length ? profile.appliances : null;

  const recipes = RECIPES
    .filter((r) => !appliances || r.appliance === 'none' || appliances.includes(r.appliance))
    .sort((a, b) => b.protein_g - a.protein_g)
    .map((r) => ({ ...r, ...estimateMacros(r.kcal, r.protein_g) }));
  res.json({
    plans: Object.fromEntries(Object.entries(MEAL_PLANS).map(([k, p]) => [k, {
      ...p, focus: k, total_kcal: p.meals.reduce((s, m) => s + m.kcal, 0), total_protein_g: p.meals.reduce((s, m) => s + m.protein_g, 0),
    }])),
    hostel_optimizer: {
      kettle_only: kettleOnly, appliances: appliances || ['none', 'kettle', 'induction'], recipes,
      daily_protein_if_all: recipes.reduce((s, r) => s + Number(r.protein_g), 0),
    },
    mess_menu: profile.mess_menu || '',
    substitutions: buildSubstitutions(),
    chai_blocker: CHAI_BLOCKER,
  });
});

// ---------------------------------------------------------------------------
// Barcode → Open Food Facts (proxied so the client never depends on a 3rd-party CORS policy)
// ---------------------------------------------------------------------------
app.get('/api/barcode/:code', h(async (req, res) => {
  const code = String(req.params.code || '').replace(/\D/g, '');
  if (code.length < 6 || code.length > 14) return res.status(400).json({ error: 'Barcode must be 6–14 digits' });
  const fields = 'product_name,product_name_en,brands,nutriments,serving_size,serving_quantity,image_front_small_url,quantity';
  let r;
  try {
    r = await fetch(`https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=${fields}`, {
      headers: { 'User-Agent': 'NutriPath/2.0 (nutrition tracking app)' }, signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    return res.status(502).json({ error: `Open Food Facts unreachable: ${err.message}` });
  }
  if (r.status === 404) return res.status(404).json({ error: `No product found for barcode ${code}` });
  if (!r.ok) return res.status(502).json({ error: `Open Food Facts returned HTTP ${r.status}` });
  const body = await r.json();
  if (body.status !== 1 || !body.product) return res.status(404).json({ error: `No product found for barcode ${code}` });
  const p = body.product;
  const n = p.nutriments || {};
  const kcal = n['energy-kcal_100g'] ?? (n.energy_100g != null ? n.energy_100g / 4.184 : null);
  res.json({
    barcode: code,
    name: p.product_name || p.product_name_en || `Product ${code}`,
    brand: (p.brands || '').split(',')[0].trim(),
    image: p.image_front_small_url || null,
    package: p.quantity || null,
    serving_g: Number(p.serving_quantity) || null,
    serving_size: p.serving_size || null,
    per100: {
      kcal: round1(kcal ?? 0), protein_g: round1(n.proteins_100g ?? 0),
      carbs_g: round1(n.carbohydrates_100g ?? 0), fat_g: round1(n.fat_100g ?? 0),
    },
    has_nutrition: kcal != null,
  });
}));

// ---------------------------------------------------------------------------
// AI Vision — meal photo or mess-menu photo → structured items with macros
// ---------------------------------------------------------------------------
const VISION_PROMPTS = {
  meal: `Identify each food on this plate/photo (Indian context: roti, dal, sabzi, rice, etc.), estimate portion and macros, return JSON.
Return ONLY JSON of the form:
{"items":[{"name":string,"quantity":string (household measure e.g. "2 roti","1 katori"),"kcal":number,"protein_g":number,"carbs_g":number,"fat_g":number,"confidence":"high"|"medium"|"low"}],"notes":string}
If no food is visible return {"items":[],"notes":"No food detected"}.`,
  menu: `This is a hostel/mess/canteen menu (printed, handwritten or a board). Identify each dish, estimate macros for one standard serving, return JSON.
Return ONLY JSON of the form:
{"items":[{"name":string,"meal":"breakfast"|"lunch"|"snacks"|"dinner"|"any","quantity":string,"kcal":number,"protein_g":number,"carbs_g":number,"fat_g":number,"tip":string (short advice e.g. "best protein pick","limit — fried")}],"best_picks":[string],"notes":string}
If no menu is visible return {"items":[],"best_picks":[],"notes":"No menu detected"}.`,
};

const DEMO_VISION = {
  meal: { items: [
    { name: 'Roti', quantity: '2 medium', kcal: 240, protein_g: 7, carbs_g: 46, fat_g: 3, confidence: 'medium' },
    { name: 'Dal tadka', quantity: '1 katori', kcal: 180, protein_g: 9, carbs_g: 22, fat_g: 6, confidence: 'medium' },
    { name: 'Aloo sabzi', quantity: '1 katori', kcal: 160, protein_g: 3, carbs_g: 22, fat_g: 7, confidence: 'low' },
  ], notes: 'Demo estimate — AI is offline (set GEMINI_API_KEY for real photo analysis).' },
  menu: { items: [
    { name: 'Poha', meal: 'breakfast', quantity: '1 plate', kcal: 270, protein_g: 6, carbs_g: 45, fat_g: 7, tip: 'Add peanuts + lemon' },
    { name: 'Rajma chawal', meal: 'lunch', quantity: '1 plate', kcal: 480, protein_g: 16, carbs_g: 82, fat_g: 8, tip: 'Best protein pick at lunch' },
    { name: 'Samosa', meal: 'snacks', quantity: '1 piece', kcal: 260, protein_g: 4, carbs_g: 28, fat_g: 15, tip: 'Limit — deep fried' },
    { name: 'Paneer butter masala + 2 roti', meal: 'dinner', quantity: '1 katori + 2 roti', kcal: 560, protein_g: 20, carbs_g: 52, fat_g: 30, tip: 'Good protein, heavy gravy — skip extra butter' },
  ], best_picks: ['Rajma chawal', 'Paneer butter masala + 2 roti'], notes: 'Demo menu — AI is offline (set GEMINI_API_KEY for real menu reading).' },
};

function cleanVisionItems(items = []) {
  return (Array.isArray(items) ? items : []).slice(0, 25).map((it) => ({
    name: String(it.name || 'Unknown food').slice(0, 120),
    quantity: it.quantity ? String(it.quantity).slice(0, 40) : null,
    meal: it.meal ? String(it.meal).slice(0, 20) : undefined,
    tip: it.tip ? String(it.tip).slice(0, 140) : undefined,
    confidence: it.confidence ? String(it.confidence).slice(0, 10) : undefined,
    kcal: Math.round(clampNum(it.kcal, 0, 5000)),
    protein_g: round1(clampNum(it.protein_g, 0, 500)),
    carbs_g: round1(clampNum(it.carbs_g, 0, 1000)),
    fat_g: round1(clampNum(it.fat_g, 0, 500)),
  }));
}

app.post('/api/vision', h(async (req, res) => {
  const mode = req.body?.mode === 'menu' ? 'menu' : 'meal';
  const raw = String(req.body?.image || '');
  const m = /^data:(image\/(?:jpeg|png|webp|heic|heif));base64,(.+)$/i.exec(raw);
  const mimeType = m ? m[1].toLowerCase() : String(req.body?.mimeType || 'image/jpeg');
  const data = m ? m[2] : raw;
  if (!data || !/^[A-Za-z0-9+/=\s]+$/.test(data.slice(0, 200))) return res.status(400).json({ error: 'image must be a base64 data URL' });
  if (!/^image\/(jpeg|png|webp|heic|heif)$/.test(mimeType)) return res.status(400).json({ error: 'Unsupported image type' });
  if (data.length > 7_000_000) return res.status(413).json({ error: 'Image too large (max ~5 MB)' });

  if (!genAI) return res.json({ mode, source: 'demo', ...DEMO_VISION[mode] });
  try {
    const model = genAI.getGenerativeModel({ model: VISION_MODEL, generationConfig: { responseMimeType: 'application/json', temperature: 0.2 } }, AI_TIMEOUT);
    const result = await model.generateContent([{ text: VISION_PROMPTS[mode] }, { inlineData: { mimeType, data } }]);
    const parsed = JSON.parse(result.response.text().replace(/^```(?:json)?|```$/g, '').trim());
    res.json({
      mode, source: 'gemini', model: VISION_MODEL,
      items: cleanVisionItems(parsed.items),
      best_picks: Array.isArray(parsed.best_picks) ? parsed.best_picks.slice(0, 10).map(String) : [],
      notes: String(parsed.notes || '').slice(0, 400),
    });
  } catch (err) {
    console.error('[vision] Gemini error:', err.message);
    res.status(502).json({ error: `AI vision failed: ${err.message.slice(0, 200)}` });
  }
}));

// ---------------------------------------------------------------------------
// Meal logging — every log path ends here; the client then re-fetches /api/dashboard
// ---------------------------------------------------------------------------
const LOG_SOURCES = ['manual', 'barcode', 'ai_photo', 'ai_menu', 'meal_plan', 'recipe'];

app.post('/api/log-meal', async (req, res) => {
  const b = req.body || {};
  const items = Array.isArray(b.items) ? b.items : [b];
  if (!items.length || items.length > 25) return res.status(400).json({ error: 'Send 1–25 items' });
  const clean = [];
  for (const it of items) {
    const name = String(it.name || '').trim().slice(0, 120);
    if (!name) return res.status(400).json({ error: 'Each item needs a name' });
    const vals = { kcal: Number(it.kcal), protein_g: Number(it.protein_g ?? 0), carbs_g: Number(it.carbs_g ?? 0), fat_g: Number(it.fat_g ?? 0) };
    if (Object.values(vals).some((v) => !Number.isFinite(v) || v < 0) || vals.kcal > 5000) {
      return res.status(400).json({ error: `Invalid nutrition values for "${name}"` });
    }
    clean.push({
      name, ...vals, quantity: it.quantity ? String(it.quantity).slice(0, 40) : null,
      source: LOG_SOURCES.includes(it.source ?? b.source) ? (it.source ?? b.source) : 'manual',
      barcode: it.barcode ? String(it.barcode).replace(/\D/g, '').slice(0, 14) : null,
    });
  }
  const logged = [];
  for (const m of clean) logged.push(await db.addMeal(req.user.id, m)); // sequential: keeps insertion order
  res.status(201).json({ logged, totals: await db.mealTotals(req.user.id) });
});

app.get('/api/meals', async (req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : db.today();
  res.json({ date, meals: await db.listMeals(req.user.id, date), totals: await db.mealTotals(req.user.id, date) });
});

app.delete('/api/log-meal/:id', async (req, res) => {
  if (!(await db.deleteMeal(req.user.id, Number(req.params.id)))) return res.status(404).json({ error: 'Log entry not found' });
  res.json({ deleted: Number(req.params.id), totals: await db.mealTotals(req.user.id) });
});

// ===========================================================================
// MODULE 3. HEALTH & RECOVERY — Lab Analyzer · Recovery Roadmap · Condition Toggles
// ===========================================================================
const DISCLAIMER = 'General dietary guidance only — not a substitute for medical diagnosis or treatment.';

// --- Tab 3: condition toggles (stored in health_profiles.conditions) ---
const CONDITIONS = {
  diabetes: {
    condition: 'Diabetes / Prediabetes', icon: '🩸',
    principle: 'Lower the glycemic load: low-GI, high-fibre carbs and always pair carbs with protein or fat.',
    warnings: [
      { food: 'White rice, maida naan, white bread', why: 'High GI (70+) — fast glucose spike' },
      { food: 'Sugary chai, cold drinks, packaged juice', why: 'Liquid sugar — no fibre to slow absorption' },
      { food: 'Mithai, jalebi, biscuits', why: 'Refined sugar + fat' },
      { food: 'Mango, chikoo, grapes in large portions', why: 'High-sugar fruits — keep to a small bowl with nuts' },
    ],
    swaps: [
      { from: 'White rice (GI ~73)', to: 'Foxtail millet or parboiled rice (GI ~50)' },
      { from: 'Aloo poha with sugar', to: 'Vegetable oats upma or moong dal chilla' },
      { from: 'Packaged juice', to: 'Whole guava or amla (fibre intact)' },
    ],
    rules: ['Plate: ½ non-starchy sabzi, ¼ dal/paneer/egg, ¼ millet or roti.', 'Soak 1 tsp methi seeds overnight.', 'Walk 10–15 min after main meals.'],
  },
  hypertension: {
    condition: 'Hypertension (High BP)', icon: '🫀',
    principle: 'Cut sodium, raise potassium — the DASH pattern adapted to Indian food.',
    warnings: [
      { food: 'Achaar, papad', why: 'Very high hidden salt' },
      { food: 'Namkeen, chips, bhujia', why: 'Salt + refined oil' },
      { food: 'Instant noodles, soup packets', why: '1,500+ mg sodium per pack' },
      { food: 'Bakery bread, pav, sauces', why: 'Hidden sodium adds up' },
    ],
    swaps: [
      { from: 'Achaar with every meal', to: 'Fresh mint-coriander chutney with lemon' },
      { from: 'Namkeen / chips', to: 'Unsalted roasted chana or peanuts' },
    ],
    rules: ['Under 5 g salt/day (1 level tsp) including hidden salt.', 'Labels: > 600 mg sodium per 100 g = high-salt.', 'Raise potassium: banana, coconut water, rajma, curd (skip if kidney disease).'],
  },
  pcos: {
    condition: 'PCOS / PCOD', icon: '🌸',
    principle: 'Improve insulin sensitivity: low-GI carbs, protein at every meal, anti-inflammatory fats and regular strength training.',
    warnings: [
      { food: 'Sugary drinks, bakery items, mithai', why: 'Spike insulin, which worsens androgen symptoms' },
      { food: 'Maida (white flour) snacks', why: 'High GI, low fibre' },
      { food: 'Deep-fried street food (samosa, pakora)', why: 'Trans/oxidised fats drive inflammation' },
      { food: 'Skipping breakfast', why: 'Leads to larger glucose swings later in the day' },
    ],
    swaps: [
      { from: 'White bread toast', to: 'Besan chilla or moong dal chilla' },
      { from: 'Fruit juice', to: 'Whole fruit + handful of nuts' },
      { from: 'Refined oil frying', to: 'Mustard oil, flaxseed, walnuts (omega-3)' },
    ],
    rules: ['Protein 20–30 g each meal (paneer, dal, eggs, soy).', '1 tbsp ground flaxseed or 2 tsp methi daily.', 'Strength training 3×/week improves insulin sensitivity.'],
  },
  cholesterol: {
    condition: 'High Cholesterol', icon: '🧈',
    principle: 'Aim for 5–10 g of soluble fibre a day — it binds bile acids and lowers LDL.',
    warnings: [
      { food: 'Vanaspati / dalda', why: 'Trans fat — raises LDL, lowers HDL' },
      { food: 'Fried snacks more than once a week', why: 'Reheated oil + saturated fat' },
      { food: 'Excess ghee/butter (> 2 tsp/day)', why: 'Saturated fat' },
    ],
    swaps: [
      { from: 'Maida paratha', to: 'Oats / jau (barley) dalia' },
      { from: 'Butter on roti', to: 'Plain roti + 1 tsp ghee max' },
    ],
    rules: ['Isabgol 1 tbsp in water (~3.5 g soluble fibre).', 'Measure oil: 3–4 tsp/day, rotate mustard/groundnut.'],
  },
  senior: {
    condition: 'Age 40+ (Bone & Muscle)', icon: '🦴',
    principle: 'Protect bone density and muscle mass: calcium + Vitamin D, 25–30 g protein per meal, avoid mineral blockers.',
    warnings: [
      { food: 'Counting palak as a calcium source', why: 'Oxalates bind its calcium — blanch & drain greens' },
      { food: 'Chai/coffee with meals', why: 'Tannins block iron absorption — keep 45+ min apart' },
      { food: 'Calcium + iron tablets together', why: 'They compete — take at different times' },
      { food: 'Unsoaked bran / raw legumes in bulk', why: 'Phytates bind calcium, iron, zinc — soak, sprout or ferment' },
    ],
    swaps: [
      { from: 'Palak for calcium', to: 'Ragi (344 mg/100 g), til, paneer, curd' },
      { from: 'Low-protein breakfast', to: 'Paneer/egg/curd breakfast (25 g protein)' },
    ],
    rules: ['Calcium 1,000–1,200 mg/day; 15–20 min midday sun.', 'Resistance training at least 2×/week.'],
  },
};

app.get('/api/conditions', async (req, res) => {
  const active = ((await db.getHealthProfile(req.user.id))?.conditions || []).filter((c) => CONDITIONS[c]);
  res.json({ conditions: CONDITIONS, active, disclaimer: DISCLAIMER });
});

app.put('/api/conditions', async (req, res) => {
  const wanted = toList(req.body?.active).filter((c) => CONDITIONS[c]);
  const current = (await db.getHealthProfile(req.user.id))?.conditions || [];
  // Keep non-toggle entries (e.g. lab-derived flags) and replace the toggleable ones
  const conditions = [...new Set([...current.filter((c) => !CONDITIONS[c]), ...wanted])];
  await db.updateHealthProfile(req.user.id, { conditions });
  res.json({ active: wanted });
});

// --- Tab 2: Day 1–14 recovery roadmap (checklist state in recovery_checks) ---
const RECOVERY = {
  dengue: {
    condition: 'Dengue', icon: '🦟',
    warning: 'Seek medical care immediately for bleeding, severe abdominal pain, persistent vomiting, or drowsiness. Avoid NSAIDs (ibuprofen/aspirin) unless prescribed.',
    phases: [
      { from: 1, to: 3, name: 'Hydration Phase', texture: 'liquid', fluids_l: '3–4', goal: 'Prevent dehydration, support platelets',
        foods: ['ORS every 1–2 hrs', 'Coconut water (2 glasses)', 'Rice kanji / dal water', 'Pomegranate juice', 'Papaya (1 bowl)', 'Kiwi (1–2)'],
        avoid: ['Oily/spicy food', 'Caffeine', 'Cold drinks'], extra: ['Record temperature 3× today', 'Check for warning signs: bleeding gums, black stools, severe belly pain'] },
      { from: 4, to: 7, name: 'Soft Food Phase', texture: 'semi-solid', fluids_l: '3', goal: 'Easy digestion, rebuild strength',
        foods: ['Moong dal khichdi', 'Curd rice', 'Steamed idli (2–3)', 'Boiled vegetables', 'Clear vegetable soup', 'Banana'],
        avoid: ['Fried snacks', 'Street food', 'Heavy non-veg'], extra: ['Platelet count as advised by doctor', 'Rest — no exertion'] },
      { from: 8, to: 14, name: 'Rebuild Phase', texture: 'solid', fluids_l: '2.5–3', goal: 'Restore protein & iron stores',
        foods: ['Paneer or 2 eggs', 'Dal + 2 roti', 'Leafy greens with lemon', 'Beetroot salad', 'Dates (3–4)', 'Sprouts chaat'],
        avoid: ['Alcohol', 'Intense workouts'], extra: ['Light 10-min walk', '8 hours of sleep'] },
    ],
  },
  viral_fever: {
    condition: 'Viral Fever', icon: '🤒',
    warning: 'Consult a doctor if fever exceeds 103°F (39.4°C) or lasts beyond 3 days.',
    phases: [
      { from: 1, to: 3, name: 'Liquid Phase', texture: 'liquid', fluids_l: '3', goal: 'Hydrate and reduce fever load',
        foods: ['ORS (2–3 glasses)', 'Warm tulsi-ginger water', 'Clear vegetable soup', 'Coconut water', 'Rice kanji'],
        avoid: ['Dairy if nauseous', 'Fried food', 'Cold drinks'], extra: ['Record temperature 3× today', 'Rest in a cool, ventilated room'] },
      { from: 4, to: 7, name: 'Khichdi Phase', texture: 'semi-solid', fluids_l: '2.5–3', goal: 'Gentle energy and protein',
        foods: ['Moong dal khichdi with ghee', 'Curd rice', 'Banana', 'Dalia', 'Steamed idli'],
        avoid: ['Spicy curries', 'Packaged snacks'], extra: ['Short walk inside the room', 'Note appetite: poor / ok / good'] },
      { from: 8, to: 14, name: 'Back-to-Normal Phase', texture: 'solid', fluids_l: '2.5', goal: 'Rebuild muscle lost during fever',
        foods: ['Roti + dal + sabzi', 'Paneer / eggs', 'Sprouts chaat with lemon', 'Seasonal fruit', 'Curd'],
        avoid: ['Skipping meals', 'Heavy gym sessions'], extra: ['Protein at every meal', 'Ease back into normal activity'] },
    ],
  },
};

function recoveryRoadmap(planKey) {
  const plan = RECOVERY[planKey];
  const days = Array.from({ length: 14 }, (_, i) => {
    const day = i + 1;
    const ph = plan.phases.find((p) => day >= p.from && day <= p.to);
    const k = day - ph.from; // rotate foods so each day differs
    const foods = [0, 1, 2].map((j) => ph.foods[(k + j) % ph.foods.length]);
    return {
      day, phase: ph.name, texture: ph.texture, goal: ph.goal,
      items: [`💧 Drink ${ph.fluids_l} L fluids`, ...foods.map((f) => `🍽️ ${f}`), `🚫 Avoid: ${ph.avoid.join(', ')}`, ...ph.extra.map((e) => `✅ ${e}`)],
    };
  });
  return { key: planKey, condition: plan.condition, icon: plan.icon, warning: plan.warning,
    phases: plan.phases.map(({ from, to, name, texture }) => ({ from, to, name, texture })), days };
}

app.get('/api/recovery/:plan', async (req, res) => {
  if (!RECOVERY[req.params.plan]) return res.status(404).json({ error: `Unknown plan. Use: ${Object.keys(RECOVERY).join(', ')}` });
  res.json({ ...recoveryRoadmap(req.params.plan), checks: await db.getRecoveryChecks(req.user.id, req.params.plan), plans: Object.keys(RECOVERY), disclaimer: DISCLAIMER });
});

app.post('/api/recovery/:plan/check', async (req, res) => {
  const { plan } = req.params;
  if (!RECOVERY[plan]) return res.status(404).json({ error: 'Unknown plan' });
  if (req.body?.reset) { await db.resetRecovery(req.user.id, plan); return res.json({ checks: [] }); }
  const day = Number(req.body?.day);
  const item = Number(req.body?.item);
  const roadmap = recoveryRoadmap(plan);
  if (!Number.isInteger(day) || day < 1 || day > 14) return res.status(400).json({ error: 'day must be 1–14' });
  if (!Number.isInteger(item) || item < 0 || item >= roadmap.days[day - 1].items.length) return res.status(400).json({ error: 'invalid item' });
  await db.setRecoveryCheck(req.user.id, plan, day, item, Boolean(req.body?.done));
  res.json({ checks: await db.getRecoveryChecks(req.user.id, plan) });
});

// --- Tab 1: Lab Analyzer ---
const LAB_METRICS = {
  b12: { metric: 'Vitamin B12', unit: 'pg/mL', ref: '200–900',
    bands: [[200, 'deficient'], [300, 'borderline'], [900, 'normal'], [Infinity, 'high']], nutrient: 'b12_mcg',
    fixes: {
      veg: ['Curd 2 bowls/day (~0.8 mcg)', 'Toned milk 2 glasses (~1 mcg)', 'Paneer 100 g (~0.8 mcg)', 'B12-fortified cereal or nutritional yeast'],
      egg: ['2 eggs daily (~1.1 mcg)', 'Curd + milk daily'],
      nonveg: ['Fish (rohu, mackerel) 2–3×/week', 'Chicken/eggs daily', 'Liver once a week (very high B12)'],
      vegan: ['B12 supplement is essentially required for vegans', 'Fortified soy milk', 'Nutritional yeast'],
    },
    note: 'Deficiency causes fatigue, tingling, poor memory. If < 200 pg/mL, a doctor will usually prescribe B12 supplements or injections — food alone rarely corrects it.' },
  ferritin: { metric: 'Serum Ferritin', unit: 'ng/mL', ref: '30–300',
    bands: [[15, 'deficient'], [30, 'low'], [300, 'normal'], [Infinity, 'high']], nutrient: 'iron_mg',
    fixes: {
      veg: ['Rajma / chole + lemon (Vitamin C doubles uptake)', 'Bajra or ragi roti', 'Soy chunks 50 g', 'Til + jaggery chikki', 'Amla or guava with meals'],
      egg: ['Eggs + plant iron sources with lemon'],
      nonveg: ['Chicken liver / mutton (heme iron absorbs 2–3× better)', 'Fish 2–3×/week'],
      vegan: ['Soy chunks, rajma, methi with lemon', 'Cook in a cast-iron kadhai'],
    },
    note: 'Keep chai/coffee 45+ min away from meals (tannins block iron). Below 15 ng/mL usually needs a doctor-prescribed iron supplement.' },
  vitamin_d: { metric: 'Vitamin D (25-OH)', unit: 'ng/mL', ref: '30–100',
    bands: [[20, 'deficient'], [30, 'insufficient'], [100, 'normal'], [Infinity, 'high']], nutrient: 'vitamin_d_iu',
    fixes: {
      veg: ['15–20 min midday sun on arms & legs, 4–5×/week', 'Vitamin D-fortified milk', 'Sun-dried mushrooms'],
      egg: ['Egg yolks (2/day)', 'Midday sun 15–20 min'],
      nonveg: ['Fatty fish (mackerel/salmon) 2×/week', 'Egg yolks', 'Midday sun'],
      vegan: ['Midday sun', 'Fortified plant milk', 'UV-exposed mushrooms'],
    },
    note: 'Below 20 ng/mL, doctors typically prescribe a D3 loading dose (e.g. 60,000 IU weekly). Food alone cannot fix a true deficiency. Above 100 can be toxic — stop supplements and consult.' },
  hemoglobin: { metric: 'Hemoglobin', unit: 'g/dL', ref: null,
    bands: null, nutrient: 'iron_mg',
    fixes: {
      veg: ['Iron foods + Vitamin C (lemon, amla) at every meal', 'Jaggery + roasted chana snack', 'Beetroot & pomegranate'],
      egg: ['Eggs + iron-rich dal with lemon'], nonveg: ['Lean red meat / liver once a week'], vegan: ['Soy, rajma, methi with lemon'],
    },
    note: 'Low haemoglobin (anaemia) has several causes — iron, B12 or folate deficiency. Get a CBC + ferritin + B12 together.' },
};

function classify(key, value, sex) {
  const m = LAB_METRICS[key];
  if (key === 'hemoglobin') {
    const [lo, hi] = sex === 'female' ? [12, 15.5] : [13, 17];
    return { status: value < lo - 2 ? 'deficient' : value < lo ? 'low' : value > hi ? 'high' : 'normal', ref: `${lo}–${hi}` };
  }
  return { status: m.bands.find(([max]) => value < max)[1], ref: m.ref };
}

const dietKey = (d) => ({ vegetarian: 'veg', eggetarian: 'egg', 'non-veg': 'nonveg', vegan: 'vegan' }[d] || 'veg');

app.get('/api/labs', async (req, res) => res.json({ observations: await db.getHealthObservations(req.user.id), metrics: Object.fromEntries(
  Object.entries(LAB_METRICS).map(([k, m]) => [k, { metric: m.metric, unit: m.unit }]),
) }));

app.post('/api/lab-analyze', async (req, res) => {
  const profile = (await db.getHealthProfile(req.user.id)) || {};
  const results = [];
  for (const key of Object.keys(LAB_METRICS)) {
    const raw = req.body?.[key];
    if (raw === undefined || raw === null || raw === '') continue;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0 || value > 5000) return res.status(400).json({ error: `${LAB_METRICS[key].metric}: enter a positive number` });
    const m = LAB_METRICS[key];
    const { status, ref } = classify(key, value, profile.sex);
    const d = dietKey(profile.diet_type);
    const fixes = status === 'normal' ? ['You are in range — keep your current intake steady.']
      : status === 'high' ? ['Reading is above range — stop any supplement of this nutrient and discuss with your doctor.']
        : [...(m.fixes[d] || []), ...(d === 'egg' ? m.fixes.veg : [])].slice(0, 5);
    const top_foods = status === 'normal' || status === 'high' ? []
      : [...FOODS].filter((f) => d !== 'vegan' || !['dairy', 'animal'].includes(f.category))
        .filter((f) => !['vegetarian', 'vegan'].includes(profile.diet_type) || f.category !== 'animal')
        .sort((a, b) => b[m.nutrient] - a[m.nutrient]).slice(0, 4)
        .map((f) => `${f.name} (${f[m.nutrient]}${m.nutrient.endsWith('_mcg') ? ' mcg' : m.nutrient.endsWith('_iu') ? ' IU' : ' mg'}/100 g)`);
    await db.addObservation(req.user.id, { metric: m.metric, value, unit: m.unit, reference_range: ref, status });
    results.push({ key, metric: m.metric, value, unit: m.unit, reference_range: ref, status, fixes, top_foods, note: m.note });
  }
  if (!results.length) return res.status(400).json({ error: 'Enter at least one lab value' });
  res.json({ results, diet_type: profile.diet_type, disclaimer: DISCLAIMER });
});

// ===========================================================================
// MODULE 4. SUPPLEMENTS — interaction checker, quiz, sponsored partners
// ===========================================================================
const SAFE_MEDS = ['paracetamol', 'atorvastatin', 'amlodipine', 'cetirizine'];

app.get('/api/supplements', (req, res) => {
  const meds = toList(req.query.medications).map((m) => m.toLowerCase());
  const supplement = String(req.query.supplement || '').toLowerCase();
  let list = SUPPLEMENTS;
  if (supplement) list = list.filter((s) => s.name.toLowerCase().includes(supplement));
  const options = {
    medications: [...new Set([...SUPPLEMENT_WARNINGS.map((w) => w.medication), ...SAFE_MEDS])].sort(),
    supplements: SUPPLEMENTS.map((s) => s.name),
  };
  if (!meds.length) return res.json({ supplements: list, options });

  const names = new Set(list.map((s) => s.name));
  const order = { high: 0, moderate: 1, low: 2 };
  const warnings = SUPPLEMENT_WARNINGS
    .filter((w) => names.has(w.supplement_name))
    .filter((w) => meds.some((m) => w.medication.includes(m) || m.includes(w.medication)))
    .map((w) => ({ supplement: w.supplement_name, medication: w.medication, severity: w.severity, note: w.note }))
    .sort((a, b) => order[a.severity] - order[b.severity]);
  res.json({
    checked_medications: meds, checked_supplements: list.map((s) => s.name), safe: warnings.length === 0, warnings,
    disclaimer: 'Always confirm with your doctor or pharmacist before combining supplements with medication.',
  });
});

// 3-question quiz → evidence-based recommendations (+ Gemini personal note when available)
const QUIZ = [
  { id: 'diet', q: 'How do you eat?', options: [['vegan', '🌱 Vegan'], ['vegetarian', '🥛 Vegetarian'], ['eggetarian', '🥚 Eggetarian'], ['non-veg', '🍗 Non-veg']] },
  { id: 'sun', q: 'Daily sun on your skin?', options: [['low', '< 15 min (indoors)'], ['mid', '15–30 min'], ['high', '30+ min outdoors']] },
  { id: 'training', q: 'Strength training per week?', options: [['none', 'None'], ['some', '1–3 sessions'], ['lots', '4+ sessions']] },
];

app.get('/api/supplements/quiz', (req, res) => res.json({ questions: QUIZ }));

app.post('/api/supplements/quiz', h(async (req, res) => {
  const a = req.body || {};
  for (const q of QUIZ) if (!q.options.some(([v]) => v === a[q.id])) return res.status(400).json({ error: `Answer "${q.q}"` });
  const byName = Object.fromEntries(SUPPLEMENTS.map((s) => [s.name, s]));
  const recs = [];
  const add = (name, priority, reason) => recs.push({ ...byName[name], priority, reason });

  if (a.diet === 'vegan') add('Vitamin B12', 'essential', 'B12 is found almost only in animal foods — vegans need a supplement or fortified foods.');
  else if (a.diet === 'vegetarian') add('Vitamin B12', 'recommended', 'Most Indian vegetarians test low in B12; dairy alone often falls short. Test first, then supplement.');
  if (a.sun === 'low') add('Vitamin D3', 'recommended', 'Under 15 min of sun daily makes deficiency very likely. Get 25-OH Vitamin D tested.');
  else if (a.sun === 'mid') add('Vitamin D3', 'consider', 'Borderline sun exposure — test before supplementing.');
  if (a.training === 'lots') {
    add('Creatine Monohydrate', 'recommended', 'Strongest evidence of any performance supplement for 4+ weekly strength sessions.');
    add('Whey Protein', 'consider', 'Only if food (dal, paneer, eggs, sattu) cannot reach ~1.6–2 g/kg protein.');
  } else if (a.training === 'some') {
    add('Whey Protein', 'optional', 'Food usually covers your needs — try a sattu shake first (₹8 vs ₹60 a scoop).');
  }
  if (a.diet === 'vegan' || a.diet === 'vegetarian') add('Omega-3 (Fish Oil)', 'consider', 'No fish in the diet — use algal oil (vegan) or daily ground flaxseed.');
  const ferritin = (await db.getHealthObservations(req.user.id)).find((o) => o.metric === 'Serum Ferritin');
  if (ferritin && ['low', 'deficient'].includes(ferritin.status)) add('Iron (Ferrous Sulfate)', 'doctor', `Your ferritin was ${ferritin.value} ng/mL — iron dosing must be prescribed after a blood test.`);

  // Flag interactions with the user's saved medications
  const meds = ((await db.getHealthProfile(req.user.id))?.medications || []).map((m) => m.toLowerCase());
  for (const r of recs) {
    r.interactions = SUPPLEMENT_WARNINGS.filter((w) => w.supplement_name === r.name && meds.some((m) => w.medication.includes(m) || m.includes(w.medication)))
      .map((w) => `${w.medication} (${w.severity}): ${w.note}`);
  }

  let ai_note = null;
  if (genAI) {
    try {
      const model = genAI.getGenerativeModel({ model: CHAT_MODEL }, AI_TIMEOUT);
      const prompt = `You are an Indian nutritionist. In 2–3 short sentences, personalise this supplement advice for a user who is ${a.diet}, gets ${a.sun} sun exposure and does ${a.training} strength training. Recommendations: ${recs.map((r) => `${r.name} (${r.priority})`).join(', ') || 'none'}. Emphasise food-first, affordable Indian options and testing before supplementing. No markdown.`;
      ai_note = (await model.generateContent(prompt)).response.text().trim().slice(0, 600);
    } catch (err) {
      console.error('[quiz] Gemini error:', err.message);
    }
  }
  res.json({ answers: a, recommendations: recs, ai_note, source: ai_note ? 'gemini' : 'rules',
    disclaimer: 'Educational only — check with a doctor before starting supplements, especially with medication.' });
}));

// Sponsored partner products — placeholder listings until real partner deals exist
const SPONSORED = [
  { id: 'on-whey', brand: 'Optimum Nutrition', product: 'Gold Standard 100% Whey', tagline: '24 g protein per scoop', price_inr: 3299, badge: 'Best seller', theme: 'gold', emoji: '🥛', cta: 'Buy Now' },
  { id: 'desi-sattu', brand: 'DesiFuel', product: 'Chocolate Sattu Shake Mix', tagline: '20 g plant protein · ₹15 a glass', price_inr: 449, badge: 'Budget pick', theme: 'emerald', emoji: '🌾', cta: 'Buy Now' },
  { id: 'sunvita-d3', brand: 'SunVita', product: 'Vitamin D3 2000 IU + K2', tagline: '90 softgels · 3-month supply', price_inr: 599, badge: 'Doctor trusted', theme: 'sky', emoji: '☀️', cta: 'Buy Now' },
  { id: 'algae-omega', brand: 'OceanLeaf', product: 'Vegan Algal Omega-3', tagline: '250 mg DHA · fish-free', price_inr: 899, badge: 'Vegan', theme: 'violet', emoji: '🌊', cta: 'Buy Now' },
];
app.get('/api/sponsored', (req, res) => res.json({ products: SPONSORED, placeholder: true, label: 'Sponsored' }));

// ===========================================================================
// ANALYTICS — nutrient gaps + real 7-day calorie history
// ===========================================================================
const DIARY_7DAY = { b12_mcg: 0.7, vitamin_d_iu: 170, iron_mg: 13, iron_absorption_pct: 5, ala_g: 0.6, la_g: 12, fiber_g: 17 };

app.get('/api/analytics', async (req, res) => {
  const uid = req.user.id;
  const profile = await db.getHealthProfile(uid);
  const totals = await db.mealTotals(uid);
  const t = calcTargets(profileToInput(profile));
  const top = (key, n = 3) => [...FOODS].sort((a, b) => b[key] - a[key]).slice(0, n)
    .map((f) => `${f.name} (${f[key]}${key.endsWith('_mcg') ? ' mcg' : key.endsWith('_iu') ? ' IU' : key.endsWith('_mg') ? ' mg' : ' g'})`);
  const pct = (a, b) => Math.min(100, Math.round((a / b) * 100));
  const d = DIARY_7DAY;
  const absorbedIron = +(d.iron_mg * d.iron_absorption_pct / 100).toFixed(2);
  const omegaRatio = Math.round(d.la_g / d.ala_g);
  const pcTarget = t.macros.protein_g / t.macros.carbs_g;
  const pcActual = totals.carbs_g > 0 ? totals.protein_g / totals.carbs_g : null;

  const gaps = [
    { key: 'b12', label: 'Vitamin B12', actual: d.b12_mcg, target: 2.2, unit: 'mcg/day', pct: pct(d.b12_mcg, 2.2),
      why: 'B12 is found almost only in animal foods; vegetarian diets with little dairy fall short.', fix: 'Curd/milk twice daily, eggs if eggetarian; test B12.', sources: top('b12_mcg') },
    { key: 'vitamin_d', label: 'Vitamin D', actual: d.vitamin_d_iu, target: 600, unit: 'IU/day', pct: pct(d.vitamin_d_iu, 600),
      why: 'Indoor lifestyles and few fortified foods despite abundant sunlight.', fix: '15–20 min midday sun; fortified milk; test 25-OH Vitamin D.', sources: top('vitamin_d_iu') },
    { key: 'iron', label: 'Bioavailable Iron', actual: absorbedIron, target: 1.0, unit: 'mg absorbed/day', pct: pct(absorbedIron, 1.0),
      why: `Plant iron absorbs poorly — ~${d.iron_absorption_pct}% when chai is taken with meals.`, fix: 'Lemon/amla with iron foods; chai 45+ min away.', sources: top('iron_mg') },
    { key: 'omega', label: 'Omega-3 vs Omega-6', actual: `1:${omegaRatio}`, target: '1:4', unit: 'ALA:LA ratio', pct: pct(4, omegaRatio),
      why: 'Sunflower/soybean oils push omega-6 high while omega-3 sources are rare.', fix: '1 tbsp ground flaxseed daily; mustard oil.', sources: top('omega3_g') },
    { key: 'protein_carb', label: 'Protein : Carb Ratio',
      actual: pcActual ? `1:${(1 / pcActual).toFixed(1)}` : 'no meals yet', target: `1:${(1 / pcTarget).toFixed(1)}`,
      unit: 'today vs target', pct: pcActual ? pct(pcActual, pcTarget) : 0,
      why: 'The rice/roti-heavy thali makes carbs ~75–80% of the plate.', fix: 'Quarter plate protein at every meal.', sources: top('protein_g') },
    { key: 'fiber', label: 'Fiber', actual: d.fiber_g, target: 30, unit: 'g/day', pct: pct(d.fiber_g, 30),
      why: 'Polished rice and maida strip out fibre.', fix: 'Millets 3×/week, sprouts, whole fruit.', sources: top('fiber_g') },
  ];
  res.json({
    gaps, observations: await db.getHealthObservations(uid), weekly: await db.weeklyCalories(uid), target_kcal: profile.daily_calorie_target || t.calories,
    note: 'Micronutrients use a typical-diet baseline; the protein:carb ratio and weekly chart use your own logged meals.',
  });
});

// ===========================================================================
// PROFILE, ONBOARDING, DASHBOARD, WATER, HEALTH SYNC, EMAIL
// ===========================================================================
const CLINICAL_DISCLAIMER = 'NutriPath provides general nutrition education, not medical advice. It does not diagnose, treat or prescribe. '
  + 'Always consult a qualified doctor or registered dietitian before changing your diet, starting supplements, or if you have a medical condition, '
  + 'are pregnant, or take prescription medication. In an emergency, call 112.';

app.get('/api/me', (req, res) => res.json({ user: req.user, needsOnboarding: !req.user.onboarded }));

// 3-step onboarding: Goal → Diet → Allergies (+ optional body stats from step 1)
app.post('/api/users/setup', async (req, res) => {
  const b = req.body || {};
  const update = {
    goal: b.goal, diet_type: b.diet_type, allergies: toList(b.allergies).map((a) => a.toLowerCase().slice(0, 40)).slice(0, 20),
    age: num(b.age), sex: b.sex || undefined, height_cm: num(b.height_cm), weight_kg: num(b.weight_kg), activity_level: b.activity_level || undefined,
  };
  if (!GOAL_ADJ[update.goal]) return res.status(400).json({ error: 'Pick a goal' });
  if (!DIET_TYPES.includes(update.diet_type)) return res.status(400).json({ error: 'Pick a diet type' });
  const err = validateBody(update);
  if (err) return res.status(400).json({ error: err });
  const { profile, targets } = await saveProfile(req.user.id, update);
  const user = await db.updateUser(req.user.id, { onboarded: 1 });
  res.json({ user, profile, targets });
});

app.get('/api/profile', async (req, res) => {
  const profile = await db.getHealthProfile(req.user.id);
  res.json({ user: req.user, profile, targets: calcTargets(profileToInput(profile)), disclaimer: CLINICAL_DISCLAIMER,
    email: { smtp: mailer.smtpConfigured },
    options: { activity: Object.keys(ACTIVITY), goals: Object.keys(GOAL_ADJ), appliances: ['kettle', 'induction'], diet_types: DIET_TYPES } });
});

app.put('/api/profile', async (req, res) => {
  const b = req.body || {};
  const update = {
    age: num(b.age), height_cm: num(b.height_cm), weight_kg: num(b.weight_kg),
    sex: b.sex || undefined, activity_level: b.activity_level || undefined, goal: b.goal || undefined, diet_type: b.diet_type || undefined,
    living_setup: b.living_setup || undefined, mess_menu: b.mess_menu !== undefined ? String(b.mess_menu).slice(0, 1000) : undefined,
    monthly_food_budget: num(b.monthly_food_budget), daily_water_target: num(b.daily_water_target),
    appliances: b.appliances !== undefined ? toList(b.appliances).filter((a) => ['kettle', 'induction'].includes(a)) : undefined,
    allergies: b.allergies !== undefined ? toList(b.allergies) : undefined,
    medications: b.medications !== undefined ? toList(b.medications) : undefined,
  };
  const err = validateBody(update);
  if (err) return res.status(400).json({ error: err });
  const { profile, targets } = await saveProfile(req.user.id, update);
  const userFields = {};
  if (typeof b.name === 'string' && b.name.trim()) userFields.name = b.name.trim().slice(0, 100);
  if (b.email_opt_in !== undefined) userFields.email_opt_in = b.email_opt_in ? 1 : 0;
  const user = await db.updateUser(req.user.id, userFields);
  res.json({ user, profile, targets, disclaimer: CLINICAL_DISCLAIMER });
});

async function buildDashboard(userId, date = db.today()) {
  const profile = await db.getHealthProfile(userId);
  const fitness = calcTargets(profileToInput(profile));
  const totals = await db.mealTotals(userId, date);
  const log = (await db.getDailyLog(userId, date)) || {};
  return {
    date, profile,
    today: {
      ...totals, water_glasses: log.water_glasses ?? 0,
      steps: log.steps ?? null, calories_burned: log.calories_burned ?? null, active_minutes: log.active_minutes ?? null,
      sync_source: log.sync_source ?? null, synced_at: log.synced_at ?? null,
    },
    targets: { calories: profile.daily_calorie_target || fitness.calories, macros: fitness.macros, water_glasses: profile.daily_water_target || 8, steps: 8000 },
  };
}

app.get('/api/dashboard', async (req, res) => res.json({ user: req.user, ...(await buildDashboard(req.user.id)) }));

app.post('/api/water', async (req, res) => {
  const glasses = Number(req.body?.glasses);
  if (!Number.isInteger(glasses) || glasses < 0 || glasses > 30) return res.status(400).json({ error: 'glasses must be an integer 0–30' });
  res.json({ water_glasses: (await db.setWater(req.user.id, glasses)).water_glasses });
});

// Mock Google Fit / Apple Health sync: plausible activity for the time of day, never decreasing
app.post('/api/health-sync', async (req, res) => {
  const source = ['google_fit', 'apple_health'].includes(req.body?.source) ? req.body.source : 'google_fit';
  const profile = await db.getHealthProfile(req.user.id);
  const prev = (await db.getDailyLog(req.user.id)) || {};
  const [hh, mm] = new Intl.DateTimeFormat('en-GB', { timeZone: db.APP_TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(new Date()).split(':').map(Number);
  const dayFraction = Math.min(1, Math.max(0.05, (hh * 60 + mm - 6 * 60) / (16 * 60))); // waking hours 06:00–22:00
  const dailyGoalish = { sedentary: 4500, light: 7000, moderate: 9000, active: 11000, very_active: 13000 }[profile.activity_level] || 7000;
  const fresh = Math.round(dailyGoalish * dayFraction * (0.85 + Math.random() * 0.3));
  const steps = Math.max(prev.steps || 0, fresh);
  const active_minutes = Math.round(steps / 110);
  // ~0.5 kcal per kg per 1,000 steps (walking) — active calories, excludes BMR
  const calories_burned = Math.round(steps / 1000 * 0.5 * Number(profile.weight_kg || 65));
  const log = await db.setActivity(req.user.id, { steps, calories_burned, active_minutes, sync_source: source });
  res.json({ source, mock: true, steps: log.steps, calories_burned: log.calories_burned, active_minutes: log.active_minutes, synced_at: log.synced_at });
});

async function buildSummary(userId, date) {
  const dash = await buildDashboard(userId, date);
  return {
    date, totals: dash.today, targets: dash.targets, water: dash.today.water_glasses, water_target: dash.targets.water_glasses,
    steps: dash.today.steps, burned: dash.today.calories_burned, meals: await db.listMeals(userId, date),
  };
}

app.post('/api/email/test', h(async (req, res) => {
  if (!req.user.email) return res.status(400).json({ error: 'Your account has no email address — sign in with Google (or add an email at demo sign-in).' });
  try {
    const r = await mailer.sendSummary(db, req.user, await buildSummary(req.user.id, db.today()), 'test');
    res.json(r);
  } catch (err) {
    res.status(502).json({ error: `Email failed: ${err.message}` });
  }
}));

// ===========================================================================
// AI CHAT — Gemini-powered Indian nutritionist
// ===========================================================================
const SYSTEM_PROMPT = `You are NutriPath AI, a clinical-adjacent Indian nutritionist assistant.

Expertise and context:
- You understand Indian food culture deeply: regional cuisines, thalis, vegetarian/Jain/eggetarian diets, festivals and fasting.
- Many users are students living in hostels/PGs with only a kettle or no kitchen. Suggest no-cook or kettle-friendly options (sattu drinks, overnight oats, instant poha, boiled eggs in kettle, soaked soya chunks, sprouts, peanut chikki, curd, roasted chana).
- Always prefer affordable, local substitutions: sattu/paneer instead of whey, soy chunks/millets instead of quinoa, amla/guava instead of imported berries, flaxseed instead of walnuts.
- Flag cultural habits that harm nutrition, e.g. the "Chai-Time Iron Blocker": tannins in tea/coffee block non-heme iron absorption — advise keeping chai at least 45 minutes away from meals. Also: the 80%-carb plate, skipping breakfast, and pairing iron foods with lemon (the "Lemon Hack").
- Common gaps to watch for: protein, bioavailable iron, Vitamin B12, Vitamin D, omega-3 vs omega-6 balance, fibre.
- Condition-aware: low-GI swaps for diabetes, <5 g salt for hypertension, insulin-friendly eating for PCOS, soluble fibre for cholesterol, phased liquid-to-solid recovery for dengue/viral fever, and bone/muscle preservation for adults over 40.

Safety rules:
- You are NOT a doctor. For red-flag symptoms (chest pain, bleeding, fainting, high fever > 3 days, severe dehydration, signs of dengue warning) tell the user to seek medical care immediately.
- Do not diagnose or prescribe medication doses. Recommend blood tests (CBC, B12, Vitamin D, ferritin) where relevant.
- Mention supplement–medication interactions when the user names a medicine.
- Respect the user's allergies strictly.

Style: warm, concise, practical. Use short bullet points, give quantities in Indian household measures (katori, roti, glass) and approximate rupee cost when helpful.`;

function offlineReply(message) {
  const m = message.toLowerCase();
  if (/iron|chai|tea|anaem|anem/.test(m)) return 'Chai-Time Iron Blocker: tannins in tea cut iron absorption. Keep chai at least 45 minutes away from meals, and add lemon to your dal/sabzi (the Lemon Hack) to boost iron uptake.';
  if (/protein|whey|kettle|hostel/.test(m)) return 'Kettle-only protein: soak 50 g soya chunks in kettle-hot water for 10 min (~26 g protein, ₹12), boil 3 eggs in the kettle (~19 g), and drink a sattu shake (40 g sattu ≈ 8 g protein for ₹8).';
  if (/fever|dengue/.test(m)) return 'For fever: days 1–3 focus on ORS, coconut water and kanji; days 4–7 move to moong dal khichdi and curd rice; days 8–14 rebuild with dal-roti, paneer/eggs. See a doctor if fever lasts beyond 3 days or you notice bleeding.';
  if (/sugar|diabet|pcos/.test(m)) return 'Low-GI swaps: foxtail millet for white rice, bajra/besan roti for maida, whole guava instead of juice. Protein at every meal and a 10–15 minute walk after meals.';
  return 'I\'m running in offline demo mode (no Gemini API key configured). Try asking about protein, iron, chai, diabetes or fever recovery!';
}

app.post('/api/chat', h(async (req, res) => {
  const message = String(req.body?.message || '').trim().slice(0, 2000);
  if (!message) return res.status(400).json({ error: 'message is required' });
  const uid = req.user.id;
  await db.addChatMessage(uid, 'user', message);
  let reply;
  let source = 'offline';
  if (genAI) {
    try {
      const p = await db.getHealthProfile(uid);
      const t = await db.mealTotals(uid);
      const context = `\n\nCurrent user: ${req.user.name}, ${p.age}y ${p.sex}, ${p.weight_kg} kg, ${p.diet_type}, goal ${p.goal}, lives in ${p.living_setup} with appliances: ${p.appliances.join(', ') || 'none'}; `
        + `budget ₹${p.monthly_food_budget || '?'}/month; allergies: ${p.allergies.join(', ') || 'none'}; conditions: ${p.conditions.join(', ') || 'none'}; `
        + `daily target ${p.daily_calorie_target} kcal; eaten today ${t.calories} kcal (${t.protein_g} g protein).`;
      const model = genAI.getGenerativeModel({ model: CHAT_MODEL, systemInstruction: SYSTEM_PROMPT + context }, AI_TIMEOUT);
      const history = (await db.getChatHistory(uid, 20)).slice(0, -1).map((x) => ({ role: x.role, parts: [{ text: x.message }] }));
      while (history.length && history[0].role !== 'user') history.shift();
      reply = (await model.startChat({ history }).sendMessage(message)).response.text();
      source = 'gemini';
    } catch (err) {
      console.error('[chat] Gemini error:', err.message);
      reply = offlineReply(message);
    }
  } else {
    reply = offlineReply(message);
  }
  await db.addChatMessage(uid, 'model', reply);
  res.json({ reply, source });
}));

app.get('/api/chat/history', async (req, res) => res.json({ messages: await db.getChatHistory(req.user.id, 40) }));

// ---------------------------------------------------------------------------
app.use('/api', (req, res) => res.status(404).json({ error: `No route for ${req.method} ${req.originalUrl}` }));
// JSON error handler (bad JSON bodies, oversized payloads, unexpected errors)
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error('[server]', err);
  res.status(status).json({ error: status === 413 ? 'Upload too large' : status >= 500 ? 'Internal server error' : err.message });
});

// Bind first so Render's port scan succeeds; then confirm Postgres is reachable (schema is applied by initDB.js)
app.listen(PORT, () => console.log(`NutriPath running at http://localhost:${PORT} (auth: ${auth.firebaseEnabled ? 'Firebase Google' : 'demo'}, AI: ${genAI ? VISION_MODEL : 'offline'})`));
db.ping()
  .then(() => console.log(`[db] PostgreSQL connected (${db.getPath()})`))
  .catch((err) => console.error(`[db] PostgreSQL connection failed: ${db.describeError(err)}`));
mailer.startDailyJob(db, buildSummary);
