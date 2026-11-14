require('./loadEnv');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const db = require('./db');
const auth = require('./auth');
const mailer = require('./mailer');
const { FOODS, SUPPLEMENTS, SUPPLEMENT_WARNINGS } = require('./data');
// Clinical knowledge base grounding the AI chat (synergies, blockers, hostel constraints)
const NUTRITION_KB = require('./data/nutrition_kb.json');

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

// Inserts/updates the users row (plus health_profiles + journey_progress). A database failure
// is logged with the real Postgres reason and returned as a readable 503, never a bare 500.
async function upsertForLogin(res, fields) {
  try {
    return await db.upsertUser(fields);
  } catch (err) {
    console.error('[login] user upsert failed:', db.describeError(err), err.code ? `(pg ${err.code})` : '');
    res.status(503).json({ error: 'Could not save your account — the database is unavailable. Try again shortly.' });
    return null;
  }
}

async function googleLogin(req, res) {
  let claims;
  try {
    claims = await auth.verifyFirebaseIdToken(req.body?.idToken);
  } catch (err) {
    return res.status(401).json({ error: `Sign-in failed: ${err.message}` });
  }
  const result = await upsertForLogin(res, {
    firebase_uid: claims.sub, email: claims.email || null, name: claims.name || claims.email?.split('@')[0] || 'Friend',
    photo_url: claims.picture || null, provider: 'google',
  });
  if (result) res.json(sessionPayload(result.user, result.isNew));
}

// Google sign-in: exchange a Firebase ID token for an app session; upserts the users row
app.post('/api/auth/login', h(googleLogin));

// Demo sign-in (only when Firebase is not configured, or ALLOW_DEMO_LOGIN=true)
async function demoLogin(req, res) {
  if (!auth.demoLoginEnabled) return res.status(403).json({ error: 'Demo sign-in is disabled — use Google sign-in.' });
  const name = String(req.body?.name || '').trim().slice(0, 60);
  const email = String(req.body?.email || '').trim().toLowerCase().slice(0, 200);
  if (!name && !email) return res.status(400).json({ error: 'Name is required' });
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Email looks invalid' });
  const result = await upsertForLogin(res, {
    firebase_uid: `demo:${email || name.toLowerCase()}`, email: email || null, name: name || email.split('@')[0], photo_url: null, provider: 'demo',
  });
  if (result) res.json(sessionPayload(result.user, result.isNew));
}
app.post('/api/auth/demo', h(demoLogin));

// Unified login: { idToken } → Google/Firebase sign-in, otherwise { name, email } → demo sign-in.
// Inserts the users row on first login and returns { token, user, isNew, needsOnboarding }.
app.post('/api/login', h((req, res) => (req.body?.idToken ? googleLogin(req, res) : demoLogin(req, res))));

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
  });
});

// ===========================================================================
// MODULE 2. DIET PLANNER — AI meal generator · smart local swaps · hostel menu · scan & log
// ===========================================================================
// Gemini helper: prompt (+ optional image) → parsed JSON object
async function geminiJSON(prompt, image = null, temperature = 0.2) {
  const model = genAI.getGenerativeModel({ model: image ? VISION_MODEL : CHAT_MODEL, generationConfig: { responseMimeType: 'application/json', temperature } }, AI_TIMEOUT);
  const parts = image ? [{ text: prompt }, { inlineData: image }] : [{ text: prompt }];
  const result = await model.generateContent(parts);
  return JSON.parse(result.response.text().replace(/^```(?:json)?|```$/g, '').trim());
}

// Validates a base64 image data URL from the client → { mimeType, data } or { error, status }
function parseImage(body) {
  const raw = String(body?.image || '');
  const m = /^data:(image\/(?:jpeg|png|webp|heic|heif));base64,(.+)$/i.exec(raw);
  const mimeType = m ? m[1].toLowerCase() : String(body?.mimeType || 'image/jpeg');
  const data = m ? m[2] : raw;
  if (!data || data.length < 100 || !/^[A-Za-z0-9+/=\s]+$/.test(data.slice(0, 200))) return { error: 'image must be a base64 data URL', status: 400 };
  if (!/^image\/(jpeg|png|webp|heic|heif)$/.test(mimeType)) return { error: 'Unsupported image type', status: 400 };
  if (data.length > 7_000_000) return { error: 'Image too large (max ~5 MB)', status: 413 };
  return { mimeType, data };
}

// --- Smart local swaps (reference table) ---
const SUBSTITUTION_PAIRS = [
  { from: 'Quinoa', to: ['Foxtail Millet', 'Soy Chunks'], why: 'Millets match quinoa\'s fibre and low GI at a fraction of the cost; soy chunks have ~3.5× the protein.' },
  { from: 'Whey Protein', to: ['Sattu (Roasted Chana Flour)', 'Paneer'], why: 'Sattu gives protein + fibre for ~₹6 a glass; paneer adds casein, calcium and B12.' },
  { from: 'Blueberries', to: ['Amla (Indian Gooseberry)', 'Guava'], why: 'One amla has more Vitamin C than a punnet of imported berries — and boosts iron absorption.' },
  { from: 'Walnuts', to: ['Flaxseed'], why: 'Ground flaxseed has ~2.5× the ALA omega-3 of walnuts at a quarter of the price.' },
];

function buildSubstitutions() {
  const byName = Object.fromEntries(FOODS.map((f) => [f.name, f]));
  return SUBSTITUTION_PAIRS.map((p) => {
    const from = byName[p.from];
    const to = p.to.map((n) => byName[n]).filter(Boolean);
    const cheapest = Math.min(...to.map((t) => t.cost_inr_per_kg));
    return { from, to, why: p.why, savings_pct: from ? Math.round((1 - cheapest / from.cost_inr_per_kg) * 100) : null };
  });
}

// --- AI single-meal generator ---
const MEAL_OPTIONS = {
  meal_type: ['Breakfast', 'Lunch', 'Snack', 'Dinner'],
  cuisine: ['North Indian', 'South Indian', 'Continental'],
  diet: ['Veg', 'Non-Veg'],
};
const MEAL_SHARE = { Breakfast: 0.25, Lunch: 0.35, Snack: 0.1, Dinner: 0.3 };

app.get('/api/diet-planner', (req, res) => res.json({ substitutions: buildSubstitutions(), generator: MEAL_OPTIONS }));

// Offline fallback pool (used only when Gemini is not configured or fails)
const OFFLINE_MEALS = [
  ['Breakfast', 'North Indian', 'Veg', 'Paneer-stuffed moong dal chilla', ['2 moong dal chillas', '50 g paneer', 'Mint chutney'], 380, 24, 38, 14, 6],
  ['Breakfast', 'South Indian', 'Veg', 'Ragi dosa with sambar', ['2 ragi dosas', '1 katori sambar', 'Coconut chutney (1 tbsp)'], 360, 13, 58, 9, 9],
  ['Breakfast', 'Continental', 'Veg', 'Overnight oats with curd, chia & banana', ['40 g oats', '150 g curd', '1 tbsp chia', '1 banana'], 390, 16, 60, 10, 9],
  ['Breakfast', 'North Indian', 'Non-Veg', 'Masala egg bhurji with 2 multigrain roti', ['3 eggs', '2 multigrain roti', 'Onion-tomato'], 470, 27, 40, 21, 6],
  ['Breakfast', 'South Indian', 'Non-Veg', 'Egg appam with vegetable stew', ['2 appams', '2 eggs', '1 katori veg stew'], 430, 20, 52, 15, 5],
  ['Breakfast', 'Continental', 'Non-Veg', 'Spinach omelette on wholewheat toast', ['3-egg omelette', 'Palak', '2 slices wholewheat toast'], 420, 28, 30, 20, 5],
  ['Lunch', 'North Indian', 'Veg', 'Rajma, jeera rice & cucumber raita', ['1.5 katori rajma', '1 katori rice', '1 katori raita', 'Lemon wedge'], 560, 22, 88, 11, 14],
  ['Lunch', 'South Indian', 'Veg', 'Sambar rice with beans poriyal & curd', ['1.5 katori sambar rice', '1 katori beans poriyal', '1 katori curd'], 540, 18, 84, 13, 11],
  ['Lunch', 'Continental', 'Veg', 'Chickpea & paneer grain bowl', ['1 katori chickpeas', '60 g grilled paneer', '1 katori millet', 'Salad greens'], 590, 30, 66, 21, 13],
  ['Lunch', 'North Indian', 'Non-Veg', 'Chicken curry with 2 roti & salad', ['150 g chicken curry', '2 roti', 'Kachumber salad'], 590, 40, 52, 22, 7],
  ['Lunch', 'South Indian', 'Non-Veg', 'Kerala fish curry with red rice', ['150 g fish curry', '1 katori red rice', 'Thoran'], 560, 36, 62, 16, 6],
  ['Lunch', 'Continental', 'Non-Veg', 'Grilled chicken, brown rice & sautéed veg', ['150 g grilled chicken', '1 katori brown rice', 'Sautéed broccoli & beans'], 570, 45, 55, 16, 7],
  ['Snack', 'North Indian', 'Veg', 'Sprouts chaat with lemon', ['1 katori moong sprouts', 'Onion-tomato', 'Lemon', 'Chaat masala'], 180, 12, 28, 2, 7],
  ['Snack', 'South Indian', 'Veg', 'Sundal (chickpea stir-fry)', ['1 katori boiled chana', 'Coconut', 'Mustard-curry leaf tadka'], 210, 10, 30, 6, 8],
  ['Snack', 'Continental', 'Veg', 'Greek-style curd with flaxseed & fruit', ['150 g hung curd', '1 tbsp ground flaxseed', '1 apple'], 220, 12, 26, 8, 6],
  ['Snack', 'North Indian', 'Non-Veg', 'Boiled egg chaat', ['2 boiled eggs', 'Onion-tomato', 'Lemon'], 170, 13, 6, 10, 1],
  ['Dinner', 'North Indian', 'Veg', 'Palak paneer with 2 bajra roti', ['1 katori palak paneer', '2 bajra roti', 'Lemon'], 520, 24, 52, 23, 9],
  ['Dinner', 'South Indian', 'Veg', 'Pesarattu with ginger chutney & curd', ['2 pesarattu', 'Ginger chutney', '1 katori curd'], 450, 22, 56, 13, 9],
  ['Dinner', 'Continental', 'Veg', 'Lentil-vegetable soup with paneer toast', ['2 bowls masoor-veg soup', '2 slices wholewheat toast', '40 g paneer'], 470, 26, 54, 15, 12],
  ['Dinner', 'North Indian', 'Non-Veg', 'Tandoori fish with dal & 1 roti', ['150 g tandoori fish', '1 katori dal', '1 roti', 'Salad'], 500, 44, 40, 16, 8],
  ['Dinner', 'South Indian', 'Non-Veg', 'Chettinad egg curry with 2 ragi dosa', ['2-egg curry', '2 ragi dosas'], 480, 22, 52, 19, 7],
  ['Dinner', 'Continental', 'Non-Veg', 'Herb chicken with quinoa-free millet pilaf', ['150 g herb chicken', '1 katori millet pilaf', 'Steamed veg'], 520, 42, 48, 16, 7],
].map(([meal_type, cuisine, diet, name, ingredients, kcal, protein_g, carbs_g, fat_g, fiber_g]) => ({
  meal_type, cuisine, diet, name, ingredients, kcal, protein_g, carbs_g, fat_g, fiber_g,
  quantity: '1 plate', prep_min: 20, description: `A balanced ${cuisine} ${meal_type.toLowerCase()}.`,
  why: 'Pairs a protein source with fibre-rich carbs for steady energy.',
}));

function offlineMeal(meal_type, cuisine, diet, exclude) {
  const seen = new Set(exclude.map((e) => e.toLowerCase()));
  const pool = OFFLINE_MEALS.filter((m) => m.meal_type === meal_type && m.cuisine === cuisine && (m.diet === diet || diet === 'Non-Veg'));
  const fresh = pool.filter((m) => !seen.has(m.name.toLowerCase()));
  const list = fresh.length ? fresh : pool;
  return list[Math.floor(Math.random() * list.length)];
}

function cleanMeal(m = {}) {
  return {
    name: String(m.name || 'Suggested meal').slice(0, 120),
    description: String(m.description || '').slice(0, 300),
    ingredients: (Array.isArray(m.ingredients) ? m.ingredients : []).slice(0, 12).map((s) => String(s).slice(0, 80)),
    quantity: String(m.quantity || '1 serving').slice(0, 40),
    kcal: Math.round(clampNum(m.kcal, 0, 3000)),
    protein_g: round1(clampNum(m.protein_g, 0, 300)),
    carbs_g: round1(clampNum(m.carbs_g, 0, 500)),
    fat_g: round1(clampNum(m.fat_g, 0, 300)),
    fiber_g: round1(clampNum(m.fiber_g, 0, 100)),
    prep_min: Math.round(clampNum(m.prep_min ?? 20, 0, 240)),
    why: String(m.why || '').slice(0, 300),
  };
}

app.post('/api/generate-meal', h(async (req, res) => {
  const b = req.body || {};
  const pick = (v, list) => list.find((x) => x.toLowerCase() === String(v || '').toLowerCase());
  const meal_type = pick(b.meal_type, MEAL_OPTIONS.meal_type);
  const cuisine = pick(b.cuisine, MEAL_OPTIONS.cuisine);
  const diet = pick(b.diet, MEAL_OPTIONS.diet);
  if (!meal_type || !cuisine || !diet) {
    return res.status(400).json({ error: `Choose meal_type (${MEAL_OPTIONS.meal_type.join('/')}), cuisine (${MEAL_OPTIONS.cuisine.join('/')}) and diet (${MEAL_OPTIONS.diet.join('/')})` });
  }
  const exclude = toList(b.exclude).map((s) => s.slice(0, 80)).slice(-15);
  const profile = (await db.getHealthProfile(req.user.id)) || {};
  const t = calcTargets(profileToInput(profile));
  const target = { kcal: Math.round((t.calories * MEAL_SHARE[meal_type]) / 10) * 10, protein_g: Math.round(t.macros.protein_g * MEAL_SHARE[meal_type]) };
  const allergies = (profile.allergies || []).join(', ');

  let meal = null;
  let source = 'offline';
  if (genAI) {
    const prompt = `You are a clinical nutritionist for Indian students and young professionals.
Suggest EXACTLY ONE ${diet === 'Veg' ? 'vegetarian (no meat, fish or eggs; dairy is fine)' : 'non-vegetarian (built around egg, chicken, fish or mutton)'} ${cuisine} ${meal_type.toLowerCase()}.
User: ${profile.age ?? 25}-year-old ${profile.sex ?? 'male'}, ${profile.weight_kg ?? 65} kg, goal "${profile.goal ?? 'maintain'}".
Aim for about ${target.kcal} kcal and at least ${target.protein_g} g protein, with good fibre. Use ingredients easily bought in India; keep it practical to cook or order.
${allergies ? `Strictly exclude these allergens: ${allergies}.` : ''}
${exclude.length ? `Do NOT suggest any of these meals (already shown): ${exclude.join('; ')}.` : ''}
Return ONLY JSON: {"name":string,"description":string (one sentence),"ingredients":[string] (with Indian household quantities),"quantity":string (serving size),"kcal":number,"protein_g":number,"carbs_g":number,"fat_g":number,"fiber_g":number,"prep_min":number,"why":string (one sentence: the nutritional reason this is a good pick)}`;
    try {
      meal = await geminiJSON(prompt, null, 0.9);
      source = 'gemini';
    } catch (err) {
      console.error('[generate-meal] Gemini error:', err.message);
    }
  }
  if (!meal) meal = offlineMeal(meal_type, cuisine, diet, exclude);
  const clean = cleanMeal(meal);
  await db.saveMealPlan(req.user.id, `${meal_type} · ${cuisine} · ${diet}`, [clean], clean.kcal);
  res.json({ meal: clean, source, request: { meal_type, cuisine, diet }, target });
}));

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
  const img = parseImage(req.body);
  if (img.error) return res.status(img.status).json({ error: img.error });

  if (!genAI) return res.json({ mode, source: 'demo', ...DEMO_VISION[mode] });
  try {
    const parsed = await geminiJSON(VISION_PROMPTS[mode], img);
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
// Hostel Menu — mess-menu photo → Gemini Vision → saved list (hostel_menus) → log to food log
// ---------------------------------------------------------------------------
app.get('/api/hostel-menu', async (req, res) => res.json({ items: await db.listHostelMenu(req.user.id) }));

app.post('/api/hostel-menu/scan', h(async (req, res) => {
  const img = parseImage(req.body);
  if (img.error) return res.status(img.status).json({ error: img.error });
  let parsed;
  let source = 'gemini';
  if (!genAI) {
    parsed = DEMO_VISION.menu;
    source = 'demo';
  } else {
    try {
      parsed = await geminiJSON(VISION_PROMPTS.menu, img);
    } catch (err) {
      console.error('[hostel-menu] Gemini error:', err.message);
      return res.status(502).json({ error: `AI menu reading failed: ${err.message.slice(0, 200)}` });
    }
  }
  const found = cleanVisionItems(parsed.items);
  const added = found.length ? await db.addHostelMenuItems(req.user.id, found) : [];
  res.status(added.length ? 201 : 200).json({
    source, added, items: await db.listHostelMenu(req.user.id),
    notes: String(parsed.notes || (found.length ? '' : 'No menu items found — try a clearer, well-lit photo.')).slice(0, 400),
  });
}));

app.delete('/api/hostel-menu/:id', async (req, res) => {
  if (!(await db.deleteHostelMenuItem(req.user.id, Number(req.params.id)))) return res.status(404).json({ error: 'Menu item not found' });
  res.json({ deleted: Number(req.params.id), items: await db.listHostelMenu(req.user.id) });
});

app.delete('/api/hostel-menu', async (req, res) => res.json({ deleted: await db.clearHostelMenu(req.user.id), items: [] }));

// "+ Add to Dashboard": copy the selected saved menu items into today's food log
app.post('/api/hostel-menu/log', async (req, res) => {
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Number.isInteger).slice(0, 25);
  if (!ids.length) return res.status(400).json({ error: 'Select at least one menu item' });
  const rows = await db.getHostelMenuItems(req.user.id, ids);
  if (!rows.length) return res.status(404).json({ error: 'Menu items not found' });
  const logged = [];
  for (const r of rows) {
    logged.push(await db.addMeal(req.user.id, {
      name: r.name, quantity: r.quantity, kcal: r.kcal, protein_g: r.protein_g, carbs_g: r.carbs_g, fat_g: r.fat_g, source: 'ai_menu',
    }));
  }
  res.status(201).json({ logged, totals: await db.mealTotals(req.user.id) });
});

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

// --- Tab 2: Illness recovery roadmap — Day 1–3 / 4–7 / 8–14 checklists (state in recovery_checks) ---
// A check is stored with day = the phase's first day (1, 4 or 8) and item = index within that phase.
const RECOVERY = {
  viral_cold: {
    condition: 'Viral Fever & Common Cold', icon: '🤒',
    warning: 'See a doctor if fever is above 103°F (39.4°C), lasts more than 3 days, or comes with breathlessness, chest pain, a stiff neck, a rash or confusion. Use paracetamol only as advised; antibiotics do not treat viral infections.',
    phases: [
      { from: 1, to: 3, name: 'Hydrate & Rest', texture: 'liquid', goal: 'Replace fluid lost to fever and sweating; let the immune system work',
        items: [
          'Drink 2.5–3 L of fluids a day: warm water, ORS, coconut water, clear soups',
          '1 glass ORS or nimbu-pani with a pinch of salt & sugar, twice a day',
          'Warm rasam, dal water or vegetable soup at least twice',
          'Small, soft meals every 3 hours if hungry: rice kanji, soft khichdi',
          'Tulsi-ginger warm water with 1 tsp honey for sore throat & cough',
          'Steam inhalation and warm salt-water gargle, 2–3 times a day',
          'Record temperature morning and evening',
          'Avoid cold drinks, ice cream, fried food and alcohol',
        ] },
      { from: 4, to: 7, name: 'Gentle Nutrition', texture: 'semi-solid', goal: 'Restore energy and protein without straining digestion',
        items: [
          '3 soft meals + 2 snacks: moong dal khichdi, curd rice, idli, dalia',
          'Protein at every meal: dal, curd, paneer or 2 eggs (non-veg)',
          'One vitamin C food daily: amla, guava, orange or lemon water',
          'Zinc foods for immune recovery: roasted chana, pumpkin seeds, curd',
          'Keep fluids at 2.5 L a day',
          'Sleep 8+ hours; only light walking indoors',
          'Fever still present on day 5? Get a CBC / doctor review',
        ] },
      { from: 8, to: 14, name: 'Rebuild', texture: 'solid', goal: 'Rebuild muscle and iron lost during illness',
        items: [
          'Back to a normal thali with ¼ plate protein',
          'Protein about 1.2 g per kg body weight a day',
          'Pair iron foods with vitamin C (rajma / palak with lemon)',
          'Curd or buttermilk daily to restore gut health',
          'Resume exercise at ~50% intensity, building up over the week',
          'Cough lasting beyond 2 weeks → see a doctor',
        ] },
    ],
  },
  food_poisoning: {
    condition: 'Food Poisoning', icon: '🤢',
    warning: 'Seek care immediately for blood in stool, fever above 101.5°F (38.6°C), signs of dehydration (very little urine, dizziness, dry mouth), vomiting that stops you keeping fluids down for 24 hours, or diarrhoea lasting more than 3 days. Don\'t take anti-diarrhoeal medicine unless a doctor prescribes it.',
    phases: [
      { from: 1, to: 3, name: 'Rehydrate', texture: 'liquid', goal: 'Replace water and electrolytes; rest the gut',
        items: [
          'Sip ORS: 200–400 ml after every loose stool',
          'If vomiting: small sips every 5–10 min; wait 30 min after vomiting, then restart',
          'Rice kanji, dal water, coconut water, clear soup',
          'Once vomiting settles: banana, plain rice, toast, stewed apple',
          'Check urine is pale yellow; count loose stools',
          'Avoid milk, spicy, oily food, caffeine, alcohol, raw salads and street food',
        ] },
      { from: 4, to: 7, name: 'Gut-Soothing Foods', texture: 'semi-solid', goal: 'Reintroduce easy-to-digest food and good bacteria',
        items: [
          'Curd rice or buttermilk daily (probiotic)',
          'Moong dal khichdi, idli, steamed vegetables',
          '5–6 small meals instead of 3 large ones',
          'Reintroduce soft protein: moong dal, soft paneer, boiled egg',
          'Keep fluids at 2.5–3 L a day',
          'Still avoid raw, fried and outside food',
        ] },
      { from: 8, to: 14, name: 'Restore', texture: 'solid', goal: 'Return to a normal, fibre-rich diet safely',
        items: [
          'Add fibre back gradually: oats, whole fruit, roti, millets',
          'Probiotic + prebiotic daily: curd with banana or onion',
          'Lactose intolerance can last ~2 weeks — cut back milk if bloated',
          'Freshly cooked food and safe drinking water only',
          'Wash hands before eating; avoid the vendor or dish that caused it',
        ] },
    ],
  },
};

const recoveryRoadmap = (key) => {
  const p = RECOVERY[key];
  return { key, condition: p.condition, icon: p.icon, warning: p.warning, phases: p.phases };
};
const PLAN_LABELS = Object.fromEntries(Object.entries(RECOVERY).map(([k, p]) => [k, `${p.icon} ${p.condition}`]));

app.get('/api/recovery/:plan', async (req, res) => {
  if (!RECOVERY[req.params.plan]) return res.status(404).json({ error: `Unknown plan. Use: ${Object.keys(RECOVERY).join(', ')}` });
  res.json({ ...recoveryRoadmap(req.params.plan), checks: await db.getRecoveryChecks(req.user.id, req.params.plan), plans: PLAN_LABELS, disclaimer: DISCLAIMER });
});

app.post('/api/recovery/:plan/check', async (req, res) => {
  const { plan } = req.params;
  if (!RECOVERY[plan]) return res.status(404).json({ error: 'Unknown plan' });
  if (req.body?.reset) { await db.resetRecovery(req.user.id, plan); return res.json({ checks: [] }); }
  const day = Number(req.body?.day);
  const item = Number(req.body?.item);
  const phase = RECOVERY[plan].phases.find((p) => p.from === day);
  if (!phase) return res.status(400).json({ error: `day must be the start of a phase: ${RECOVERY[plan].phases.map((p) => p.from).join(', ')}` });
  if (!Number.isInteger(item) || item < 0 || item >= phase.items.length) return res.status(400).json({ error: 'invalid item' });
  await db.setRecoveryCheck(req.user.id, plan, day, item, Boolean(req.body?.done));
  res.json({ checks: await db.getRecoveryChecks(req.user.id, plan) });
});

// --- Tab 1: Lab Analyzer (lab report photo → Gemini Vision → values → status + food fixes) ---
const IRON_FIXES = {
  veg: ['Rajma / chole + lemon (Vitamin C doubles uptake)', 'Bajra or ragi roti', 'Soy chunks 50 g', 'Til + jaggery chikki', 'Amla or guava with meals'],
  egg: ['Eggs + plant iron sources with lemon'],
  nonveg: ['Chicken liver / mutton (heme iron absorbs 2–3× better)', 'Fish 2–3×/week'],
  vegan: ['Soy chunks, rajma, methi with lemon', 'Cook in a cast-iron kadhai'],
};
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
  vitamin_d: { metric: 'Vitamin D (25-OH)', unit: 'ng/mL', ref: '30–100',
    bands: [[20, 'deficient'], [30, 'insufficient'], [100, 'normal'], [Infinity, 'high']], nutrient: 'vitamin_d_iu',
    fixes: {
      veg: ['15–20 min midday sun on arms & legs, 4–5×/week', 'Vitamin D-fortified milk', 'Sun-dried mushrooms'],
      egg: ['Egg yolks (2/day)', 'Midday sun 15–20 min'],
      nonveg: ['Fatty fish (mackerel/salmon) 2×/week', 'Egg yolks', 'Midday sun'],
      vegan: ['Midday sun', 'Fortified plant milk', 'UV-exposed mushrooms'],
    },
    note: 'Below 20 ng/mL, doctors typically prescribe a D3 loading dose (e.g. 60,000 IU weekly). Food alone cannot fix a true deficiency. Above 100 can be toxic — stop supplements and consult.' },
  ferritin: { metric: 'Serum Ferritin', unit: 'ng/mL', ref: '30–300',
    bands: [[15, 'deficient'], [30, 'low'], [300, 'normal'], [Infinity, 'high']], nutrient: 'iron_mg', fixes: IRON_FIXES,
    note: 'Keep chai/coffee 45+ min away from meals (tannins block iron). Below 15 ng/mL usually needs a doctor-prescribed iron supplement.' },
  serum_iron: { metric: 'Serum Iron', unit: 'µg/dL', ref: '60–170',
    bands: [[40, 'deficient'], [60, 'low'], [170, 'normal'], [Infinity, 'high']], nutrient: 'iron_mg', fixes: IRON_FIXES,
    note: 'Serum iron swings through the day — ferritin is the better measure of iron stores. Ask for ferritin + CBC if this is low.' },
  hemoglobin: { metric: 'Hemoglobin', unit: 'g/dL', ref: null, bands: null, nutrient: 'iron_mg',
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

// Classify each { key: value } reading, save it to health_observations and build diet-specific food fixes
async function analyzeLabValues(userId, profile, values) {
  const results = [];
  for (const [key, value] of Object.entries(values)) {
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
    await db.addObservation(userId, { metric: m.metric, value, unit: m.unit, reference_range: ref, status });
    results.push({ key, metric: m.metric, value, unit: m.unit, reference_range: ref, status, fixes, top_foods, note: m.note });
  }
  return results;
}

app.get('/api/labs', async (req, res) => res.json({ observations: await db.getHealthObservations(req.user.id), metrics: Object.fromEntries(
  Object.entries(LAB_METRICS).map(([k, m]) => [k, { metric: m.metric, unit: m.unit }]),
) }));

// JSON API (manual values) — kept for integrations; the UI uploads a report photo instead
app.post('/api/lab-analyze', async (req, res) => {
  const profile = (await db.getHealthProfile(req.user.id)) || {};
  const values = {};
  for (const key of Object.keys(LAB_METRICS)) {
    const raw = req.body?.[key];
    if (raw === undefined || raw === null || raw === '') continue;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0 || value > 5000) return res.status(400).json({ error: `${LAB_METRICS[key].metric}: enter a positive number` });
    values[key] = value;
  }
  if (!Object.keys(values).length) return res.status(400).json({ error: 'Enter at least one lab value' });
  res.json({ results: await analyzeLabValues(req.user.id, profile, values), diet_type: profile.diet_type, disclaimer: DISCLAIMER });
});

const LAB_PROMPT = `You are reading a photo of a blood test / lab report. Extract Vitamin B12, Vitamin D, and Iron levels. Return strictly JSON.
Use exactly this shape, with null for any test that is not on the report:
{"vitamin_b12":{"value":number,"unit":string}|null,
 "vitamin_d":{"value":number,"unit":string}|null,
 "iron":{"test":"ferritin"|"serum_iron"|"hemoglobin","value":number,"unit":string}|null,
 "report_date":string|null,
 "notes":string}
For iron, prefer Serum Ferritin; if absent use Serum Iron; if neither is present use Hemoglobin.
Copy values and units exactly as printed. Never guess a value that is not visible. If the image is not a lab report, return all nulls and say so in notes.`;

const DEMO_LAB = {
  vitamin_b12: { value: 186, unit: 'pg/mL' }, vitamin_d: { value: 14.2, unit: 'ng/mL' },
  iron: { test: 'ferritin', value: 22, unit: 'ng/mL' }, report_date: null,
  notes: 'Demo values — AI is offline (set GEMINI_API_KEY to read real reports).',
};

// Normalise to the units LAB_METRICS uses (pg/mL, ng/mL, µg/dL, g/dL)
function normaliseLab(parsed) {
  const out = {};
  const extracted = [];
  const val = (x) => (x && Number.isFinite(Number(x.value)) && Number(x.value) > 0 ? Number(x.value) : null);
  const unitOf = (x) => String(x?.unit || '').toLowerCase().replace(/\s/g, '');
  let v = val(parsed.vitamin_b12);
  if (v) {
    const u = unitOf(parsed.vitamin_b12);
    out.b12 = round1(u.includes('pmol') ? v * 1.355 : v);
    extracted.push({ test: 'Vitamin B12', as_printed: `${v} ${parsed.vitamin_b12.unit || ''}`.trim() });
  }
  v = val(parsed.vitamin_d);
  if (v) {
    const u = unitOf(parsed.vitamin_d);
    out.vitamin_d = round1(u.includes('nmol') ? v / 2.496 : v);
    extracted.push({ test: 'Vitamin D', as_printed: `${v} ${parsed.vitamin_d.unit || ''}`.trim() });
  }
  v = val(parsed.iron);
  if (v) {
    const test = ['ferritin', 'serum_iron', 'hemoglobin'].includes(parsed.iron.test) ? parsed.iron.test : 'ferritin';
    const u = unitOf(parsed.iron);
    if (test === 'serum_iron') out.serum_iron = round1(u.includes('µmol') || u.includes('umol') ? v * 5.585 : v);
    else if (test === 'hemoglobin') out.hemoglobin = round1(u === 'g/l' ? v / 10 : v);
    else out.ferritin = round1(v); // ng/mL == µg/L
    extracted.push({ test: { ferritin: 'Iron (Ferritin)', serum_iron: 'Iron (Serum Iron)', hemoglobin: 'Iron (Hemoglobin)' }[test], as_printed: `${v} ${parsed.iron.unit || ''}`.trim() });
  }
  return { values: out, extracted };
}

app.post('/api/lab-report', h(async (req, res) => {
  const img = parseImage(req.body);
  if (img.error) return res.status(img.status).json({ error: img.error });
  let parsed;
  let source = 'gemini';
  if (!genAI) {
    parsed = DEMO_LAB;
    source = 'demo';
  } else {
    try {
      parsed = await geminiJSON(LAB_PROMPT, img, 0);
    } catch (err) {
      console.error('[lab-report] Gemini error:', err.message);
      return res.status(502).json({ error: `AI could not read the report: ${err.message.slice(0, 200)}` });
    }
  }
  const { values, extracted } = normaliseLab(parsed || {});
  const notes = String(parsed?.notes || '').slice(0, 400);
  if (!Object.keys(values).length) {
    return res.status(422).json({ error: notes || 'No Vitamin B12, Vitamin D or iron values found on this image — try a sharper, well-lit photo of the report.' });
  }
  const profile = (await db.getHealthProfile(req.user.id)) || {};
  res.json({
    source, extracted, report_date: parsed.report_date || null, notes,
    results: await analyzeLabValues(req.user.id, profile, values), diet_type: profile.diet_type, disclaimer: DISCLAIMER,
  });
}));

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
// ANALYTICS — Micronutrient Gap Dashboard (computed from the user's logged food)
// ===========================================================================
// Micronutrient estimates per typical serving, matched on the logged food's name.
// Approximate IFCT 2017 / USDA values — a mock layer until a full micronutrient DB exists.
// Fields: b12 mcg · vd IU · fe_h heme iron mg · fe nonheme iron mg · zn mg · o3 omega-3 g (ALA+EPA/DHA) · o6 omega-6 (LA) g · fib g
// Flags: vc = vitamin C source (enhances non-heme iron) · blk = tannin source (blocks non-heme iron)
const MICRO_DB = [
  [/liver|kaleji/, { b12: 30, vd: 40, fe_h: 6, zn: 4, o3: 0.1, o6: 0.4 }],
  [/fish|rohu|mackerel|bangda|salmon|pomfret|surmai|sardine|tuna|prawn|shrimp/, { b12: 3, vd: 400, fe_h: 0.8, zn: 0.8, o3: 1.0, o6: 0.3 }],
  [/mutton|lamb|goat|keema|rogan josh/, { b12: 2.5, vd: 5, fe_h: 2.5, zn: 5, o3: 0.05, o6: 0.4 }],
  [/chicken|murgh/, { b12: 0.3, vd: 5, fe_h: 1, zn: 2, o3: 0.05, o6: 2.5 }],
  [/egg|omelet|anda/, { b12: 1.1, vd: 82, fe: 1.8, zn: 1.3, o3: 0.05, o6: 1.1 }],
  [/paneer/, { b12: 0.8, vd: 10, fe: 0.2, zn: 1.5, o3: 0.1, o6: 0.5 }],
  [/cheese|pizza/, { b12: 0.5, vd: 6, zn: 1.2, fe: 1.5, o6: 2, fib: 2 }],
  [/curd|dahi|yog(h)?urt|raita|lassi|buttermilk|chaas/, { b12: 0.4, vd: 2, fe: 0.1, zn: 0.6, o6: 0.1 }],
  [/(?<!butter)milk|doodh|shake/, { b12: 0.9, vd: 80, zn: 0.9 }],
  [/soy|soya|tofu/, { fe: 5, zn: 2.5, o3: 0.6, o6: 4.5, fib: 6 }],
  [/rajma|chole|chana|chickpea|kidney bean|sundal|lobia/, { fe: 3, zn: 1.7, o3: 0.1, o6: 0.4, fib: 8 }],
  [/dal|daal|lentil|moong|masoor|toor|arhar|sambar|chilla|pesarattu/, { fe: 2.5, zn: 1.3, o3: 0.05, o6: 0.3, fib: 5 }],
  [/sprout/, { fe: 1.5, zn: 1, fib: 4, vc: 1 }],
  [/sattu/, { fe: 2, zn: 1.2, fib: 7 }],
  [/palak|spinach|methi|saag|sarson/, { fe: 2.5, zn: 0.5, o3: 0.1, fib: 2.5 }],
  [/ragi|bajra|jowar|millet|nachni/, { fe: 3, zn: 1.5, o6: 0.5, fib: 6 }],
  [/oats?|dalia|upma/, { fe: 2, zn: 1.5, o6: 0.8, fib: 4 }],
  [/poha/, { fe: 2.6, zn: 0.5, fib: 1.5 }],
  [/roti|chapati|chapatti|phulka|paratha|naan|kulcha/, { fe: 2, zn: 1.2, o6: 0.4, fib: 4 }],
  [/idli|dosa|uttapam|appam/, { fe: 1, zn: 0.8, o6: 0.3, fib: 2 }],
  [/rice|chawal|biryani|pulao|khichdi|kanji/, { fe: 0.6, zn: 1, o6: 0.2, fib: 0.6 }],
  [/bread|toast|sandwich|burger|pasta|noodle|maggi/, { fe: 1.5, zn: 0.8, o6: 2.5, fib: 2 }],
  [/flax|alsi/, { o3: 2.3, o6: 0.6, fib: 2.7 }],
  [/chia/, { o3: 2.5, o6: 0.8, fib: 4 }],
  [/walnut|akhrot/, { o3: 2.5, o6: 10, zn: 0.9, fib: 2 }],
  [/pumpkin seed/, { zn: 2.2, fe: 2.5, o6: 5.8, fib: 1.8 }],
  [/peanut|groundnut|chikki|moongphali/, { fe: 1, zn: 1, o6: 6, fib: 2.5 }],
  [/almond|badam|cashew|kaju/, { fe: 1, zn: 0.9, o6: 3.5, fib: 3 }],
  [/til|sesame/, { fe: 1.5, zn: 0.8, o6: 2.3, fib: 1.2 }],
  [/mushroom/, { vd: 20, zn: 0.5, fib: 1 }],
  [/samosa|pakora|pakoda|bhaji|puri|poori|bhatura|vada|fries|chips|namkeen|bhujia|kachori|fried/, { o6: 6, fib: 1 }],
  [/amla|guava|orange|lemon|nimbu|kiwi|tomato|kachumber|capsicum/, { vc: 1, fib: 2 }],
  [/banana|apple|papaya|fruit|pomegranate|mango/, { fib: 3 }],
  [/salad|sabzi|subzi|vegetable|veg |bhindi|gobi|beans|carrot|broccoli|poriyal|thoran|avial|stew/, { fe: 0.8, zn: 0.3, fib: 3, vc: 1 }],
  [/chai|tea|coffee/, { blk: 1 }],
];
const MICRO_KEYS = ['b12', 'vd', 'fe_h', 'fe', 'zn', 'o3', 'o6', 'fib'];

function estimateMicros(name, kcal) {
  const n = ` ${String(name).toLowerCase()} `;
  const out = Object.fromEntries(MICRO_KEYS.map((k) => [k, 0]));
  let matched = false;
  out.vc = 0; out.blk = 0;
  for (const [re, v] of MICRO_DB) {
    if (!re.test(n)) continue;
    matched = true;
    for (const k of [...MICRO_KEYS, 'vc', 'blk']) out[k] += v[k] || 0;
  }
  // Unrecognised dish: generic mixed Indian food density per 100 kcal
  if (!matched) {
    const per100 = Number(kcal || 0) / 100;
    out.fe += 0.6 * per100; out.zn += 0.4 * per100; out.fib += 1.2 * per100; out.o6 += 1 * per100; out.o3 += 0.03 * per100;
  }
  return out;
}

// Targets: ICMR-NIN 2020 RDAs (B12, zinc), IOM (vitamin D, fibre 14 g / 1,000 kcal), physiological absorbed-iron need
function microTargets(profile, kcalTarget) {
  const female = profile.sex === 'female';
  return {
    b12: 2.5, vd: 600, iron_abs: female ? 1.8 : 1.1, zn: female ? 13.2 : 17,
    ratio: 5, fib: Math.max(25, Math.round((14 * kcalTarget) / 1000)),
  };
}

const riskOf = (pct) => (pct >= 80 ? 'Low' : pct >= 50 ? 'Moderate' : 'High');
const RISK_RANK = { Low: 0, Moderate: 1, High: 2 };

function microRecommendation(key, risk, ctx) {
  const veg = ['vegetarian', 'vegan'].includes(ctx.diet);
  const vegan = ctx.diet === 'vegan';
  const R = {
    b12: {
      High: vegan ? 'Intake is under half the RDA and B12 is absent from plant foods. Get serum B12 (± homocysteine) tested; vegans almost always need a B12 supplement — dose to be set by your doctor.'
        : veg ? 'Intake is under half the RDA. Get serum B12 tested; add 2 dairy servings daily (curd 200 g ≈ 0.8 mcg, milk 250 ml ≈ 1 mcg). Most Indian vegetarians need a doctor-advised supplement.'
          : 'Intake is under half the RDA. Add eggs daily and fish 2–3×/week; get serum B12 tested if you have fatigue or tingling.',
      Moderate: veg ? 'Add one more dairy serving daily (a bowl of curd or a glass of milk) — or fortified cereal.' : 'Add 2 eggs or a fish meal a few times a week to close the gap.',
      Low: 'Intake meets the RDA — keep your current dairy/animal-protein pattern.',
    },
    vd: {
      High: 'Diet supplies under half the requirement (typical for Indian diets). Get 15–30 min of midday sun on arms and legs 4–5×/week and test 25-OH vitamin D; if < 20 ng/mL a physician-supervised D3 course is standard.',
      Moderate: `Add fortified milk (2 glasses)${veg ? '' : ', egg yolks or fatty fish weekly'} and keep regular midday sun exposure.`,
      Low: 'Dietary vitamin D is adequate — sun exposure still matters for blood levels.',
    },
    iron: {
      High: `Absorbed iron is under half your physiological need.${ctx.blocker ? ' Tea/coffee in your log is cutting non-heme iron absorption by up to half — keep it 60 min away from meals.' : ''} Pair every iron food with vitamin C (lemon, amla, guava) and check CBC + ferritin; a confirmed deficiency usually needs prescribed iron.`,
      Moderate: `Add one iron-dense serving daily (rajma/chana, bajra roti, soy chunks${veg ? '' : ', chicken/mutton'}) with a squeeze of lemon${ctx.blocker ? '; move chai/coffee away from meals' : ''}.`,
      Low: 'Bioavailable iron meets your need — keep pairing iron foods with vitamin C.',
    },
    zn: {
      High: `Zinc is under half the RDA, and phytates in cereals and dals cut absorption further. Soak, sprout or ferment grains and legumes; add pumpkin seeds (30 g ≈ 2.2 mg), chana and paneer${veg ? '' : ', chicken or mutton'}.`,
      Moderate: 'Add a handful of pumpkin or sesame seeds, or a katori of sprouts, daily.',
      Low: 'Zinc intake meets the RDA.',
    },
    ratio: {
      High: `Omega-6:omega-3 ratio ≈ ${ctx.ratioText} — strongly pro-inflammatory (aim ≤ 5:1). Swap sunflower/soybean oil for mustard oil, cut fried snacks, add 1 tbsp ground flaxseed daily (≈ 2.3 g ALA)${veg ? '' : ' and fatty fish twice a week'}.`,
      Moderate: `Ratio ≈ ${ctx.ratioText}. Add 1 tbsp flax or chia seeds daily and use mustard oil for half your cooking.`,
      Low: `Ratio ≈ ${ctx.ratioText} — within the anti-inflammatory range.`,
    },
    fib: {
      High: 'Fibre is under half of target (14 g per 1,000 kcal). Swap polished rice for millets or brown rice 3×/week, add a katori of rajma/sprouts daily, and eat fruit whole — increase gradually with plenty of water.',
      Moderate: 'Add one more serving of whole fruit or salad and a whole-grain roti or millet daily.',
      Low: 'Fibre intake meets target — good for gut health, glucose and cholesterol.',
    },
  };
  return R[key][risk];
}

// Lab readings override diet-based risk when they show a deficiency
const LAB_LINK = { b12: ['Vitamin B12'], vd: ['Vitamin D (25-OH)'], iron: ['Serum Ferritin', 'Serum Iron', 'Hemoglobin'] };
const LAB_RISK = { deficient: 'High', low: 'Moderate', borderline: 'Moderate', insufficient: 'Moderate' };

app.get('/api/analytics', async (req, res) => {
  const uid = req.user.id;
  const profile = (await db.getHealthProfile(uid)) || {};
  const t = calcTargets(profileToInput(profile));
  const kcalTarget = profile.daily_calorie_target || t.calories;
  const T = microTargets(profile, kcalTarget);
  const WINDOW = 7;
  const meals = await db.mealsSince(uid, db.daysAgo(WINDOW - 1));
  const observations = await db.getHealthObservations(uid);

  // Per-day totals, with iron absorption adjusted for enhancers / blockers eaten that day
  const days = {};
  const contrib = { b12: {}, vd: {}, iron: {}, zn: {}, o3: {}, fib: {} };
  for (const m of meals) {
    const mi = estimateMicros(m.name, m.kcal);
    const d = days[m.log_date] ||= { b12: 0, vd: 0, fe_h: 0, fe: 0, zn: 0, o3: 0, o6: 0, fib: 0, vc: 0, blk: 0 };
    for (const k of Object.keys(d)) d[k] += mi[k] || 0;
    const add = (key, v) => { if (v > 0) contrib[key][m.name] = (contrib[key][m.name] || 0) + v; };
    add('b12', mi.b12); add('vd', mi.vd); add('iron', mi.fe_h + mi.fe); add('zn', mi.zn); add('o3', mi.o3); add('fib', mi.fib);
  }
  const dates = Object.keys(days);
  const n = dates.length;
  let blockerDays = 0;
  const avg = { b12: 0, vd: 0, iron_total: 0, iron_abs: 0, zn: 0, o3: 0, o6: 0, fib: 0 };
  for (const d of Object.values(days)) {
    // Heme ~25% absorbed; non-heme ~5%, doubled with vitamin C, ~halved by tannins (tea/coffee)
    const nonhemeRate = 0.05 * (d.vc ? 2 : 1) * (d.blk ? 0.5 : 1);
    if (d.blk) blockerDays += 1;
    avg.b12 += d.b12; avg.vd += d.vd; avg.zn += d.zn; avg.o3 += d.o3; avg.o6 += d.o6; avg.fib += d.fib;
    avg.iron_total += d.fe_h + d.fe;
    avg.iron_abs += d.fe_h * 0.25 + d.fe * nonhemeRate;
  }
  if (n) for (const k of Object.keys(avg)) avg[k] /= n;

  const ratio = avg.o3 > 0 ? avg.o6 / avg.o3 : (avg.o6 > 0 ? Infinity : null);
  const ratioText = ratio === null ? '—' : ratio === Infinity ? 'no omega-3' : `${ratio.toFixed(1)} : 1`;
  const pct = (a, b) => Math.round((a / b) * 100);
  const top = (key) => Object.entries(contrib[key]).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name]) => name);
  const ctx = { diet: profile.diet_type, blocker: blockerDays > 0, ratioText };

  const metrics = [
    { key: 'b12', label: 'Vitamin B12', value: round1(avg.b12), unit: 'mcg/day', target: T.b12, target_text: `${T.b12} mcg (ICMR RDA)`, pct: pct(avg.b12, T.b12), sources: top('b12') },
    { key: 'vd', label: 'Vitamin D', value: Math.round(avg.vd), unit: 'IU/day', target: T.vd, target_text: `${T.vd} IU`, pct: pct(avg.vd, T.vd), sources: top('vd') },
    { key: 'iron', label: 'Iron (Bioavailable)', value: Math.round(avg.iron_abs * 100) / 100, unit: 'mg absorbed/day', target: T.iron_abs,
      target_text: `${T.iron_abs} mg absorbed`, pct: pct(avg.iron_abs, T.iron_abs), sources: top('iron'),
      detail: `${round1(avg.iron_total)} mg eaten → ${(Math.round(avg.iron_abs * 100) / 100)} mg absorbed${blockerDays ? ` · tea/coffee on ${blockerDays} of ${n} days` : ''}` },
    { key: 'zn', label: 'Zinc', value: round1(avg.zn), unit: 'mg/day', target: T.zn, target_text: `${T.zn} mg (ICMR RDA)`, pct: pct(avg.zn, T.zn), sources: top('zn') },
    { key: 'ratio', label: 'Omega-3 : Omega-6', value: ratioText, unit: 'omega-6 : omega-3', target: T.ratio, target_text: '≤ 5 : 1',
      pct: ratio === null ? 0 : ratio === Infinity ? 0 : Math.round(Math.min(150, (T.ratio / Math.max(ratio, 0.1)) * 100)), sources: top('o3'),
      detail: `${round1(avg.o3)} g omega-3 · ${round1(avg.o6)} g omega-6 per day` },
    { key: 'fib', label: 'Dietary Fiber', value: round1(avg.fib), unit: 'g/day', target: T.fib, target_text: `${T.fib} g (14 g/1,000 kcal)`, pct: pct(avg.fib, T.fib), sources: top('fib') },
  ];

  for (const m of metrics) {
    if (!n) { m.risk = 'No data'; m.recommendation = 'Log at least one day of meals to calculate this gap.'; continue; }
    m.risk = m.key === 'ratio'
      ? (ratio === Infinity || ratio > 10 ? 'High' : ratio > T.ratio ? 'Moderate' : 'Low')
      : riskOf(m.pct);
    const lab = observations.find((o) => (LAB_LINK[m.key] || []).includes(o.metric) && LAB_RISK[o.status]);
    if (lab) {
      m.lab = `${lab.metric} ${lab.value} ${lab.unit} (${lab.status}) on ${lab.observed_on}`;
      if (RISK_RANK[LAB_RISK[lab.status]] > RISK_RANK[m.risk]) m.risk = LAB_RISK[lab.status];
    }
    m.recommendation = microRecommendation(m.key, m.risk, ctx);
  }

  res.json({
    window_days: WINDOW, days_logged: n, items_logged: meals.length, metrics,
    summary: { high: metrics.filter((m) => m.risk === 'High').length, moderate: metrics.filter((m) => m.risk === 'Moderate').length },
    note: `Daily averages over the ${n} day(s) you logged in the last ${WINDOW} days. Micronutrients are estimated per serving from food names (approximate IFCT/USDA values); lab results override risk when they show a deficiency.`,
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

// Grounding prompt for Gemini: the whole knowledge base (it is small) is injected as context
const KB_PROMPT = 'You are NutriPath AI. Base ALL answers strictly on this JSON context. Always point out food synergies and blockers.\n'
  + 'If the JSON context does not cover a question, say so briefly and give only general, safe guidance. '
  + 'Never mention the JSON itself or its ids/keys to the user; just apply the rules.\n\n'
  + `<nutrition_kb>\n${JSON.stringify(NUTRITION_KB)}\n</nutrition_kb>\n\n`;

// Offline retrieval: KB entries whose keywords appear in the message, best matches first
const KB_ENTRIES = [
  ...NUTRITION_KB.synergies.map((e) => ({ ...e, kind: 'Synergy', text: `${e.rule} ${e.how}` })),
  ...NUTRITION_KB.blockers.map((e) => ({ ...e, kind: 'Blocker', text: `${e.rule} Fix: ${e.fix}` })),
  ...NUTRITION_KB.hostel_constraints.map((e) => ({ ...e, kind: 'Hostel', text: `${e.constraint}: ${e.rule}` })),
  ...NUTRITION_KB.condition_rules.map((e) => ({ ...e, kind: 'Condition', text: e.rule })),
];
function kbMatches(message, limit = 3) {
  const m = message.toLowerCase();
  return KB_ENTRIES.map((e) => ({ e, score: e.keywords.filter((k) => m.includes(k)).length }))
    .filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map((x) => x.e);
}

function offlineReply(message) {
  const hits = kbMatches(message);
  if (hits.length) {
    return `Here's what the NutriPath knowledge base says:\n\n${hits.map((e) => `- **${e.kind}:** ${e.text}`).join('\n')}\n\n_Offline mode — answers come straight from the clinical rules._`;
  }
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
      const model = genAI.getGenerativeModel({ model: CHAT_MODEL, systemInstruction: KB_PROMPT + SYSTEM_PROMPT + context }, AI_TIMEOUT);
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

// ===========================================================================
// MY JOURNEY — gamified 7-day roadmap (journey_progress.current_day; 8 = finished)
// ===========================================================================
const JOURNEY_DAYS = [
  { day: 1, title: 'Fix your plate', emoji: '🌱', meals: { Morning: 'Poha with peanuts + lemon', Lunch: 'Dal & Roti + salad', Dinner: 'Moong dal Khichdi + curd' }, tip: 'Squeeze lemon on poha — Vitamin C triples iron absorption.' },
  { day: 2, title: 'Protein power', emoji: '💪', meals: { Morning: 'Sattu shake + banana', Lunch: 'Rajma chawal + cucumber', Dinner: 'Paneer bhurji + 2 roti' }, tip: 'Dal + rice together make a complete protein.' },
  { day: 3, title: 'Iron day', emoji: '🩸', meals: { Morning: 'Sprouted moong chaat', Lunch: 'Chana masala + roti + lemon', Dinner: 'Palak dal + jeera rice' }, tip: 'Keep chai 45 minutes away from meals — tannins block iron.' },
  { day: 4, title: 'Kettle hacks', emoji: '☕', meals: { Morning: 'Instant oats + peanuts', Lunch: 'Mess thali: double dal, single rice', Dinner: 'Soaked soya chunk chaat' }, tip: 'Soya chunks in kettle-hot water: ~26 g protein for ₹12.' },
  { day: 5, title: 'Gut reset', emoji: '🥣', meals: { Morning: 'Idli + sambar', Lunch: 'Curd rice + sabzi', Dinner: 'Vegetable daliya' }, tip: 'Fermented foods cut phytates and add B-vitamins.' },
  { day: 6, title: 'Smart snacking', emoji: '🥜', meals: { Morning: 'Besan chilla + mint chutney', Lunch: 'Dal, sabzi, 2 roti + guava', Dinner: 'Egg or paneer curry + roti' }, tip: 'Swap namkeen for roasted chana or makhana.' },
  { day: 7, title: 'Make it a habit', emoji: '🏆', meals: { Morning: 'Ragi dosa + chutney', Lunch: 'Rajma + brown rice', Dinner: 'Moong dal khichdi + haldi doodh' }, tip: 'A pinch of black pepper boosts haldi absorption ~20x.' },
];
const journeyPayload = (row) => ({
  current_day: row.current_day, completed: row.current_day > JOURNEY_DAYS.length, updated_at: row.updated_at, days: JOURNEY_DAYS,
});

app.get('/api/journey', h(async (req, res) => res.json(journeyPayload(await db.getJourney(req.user.id)))));

// Body { day } (optional): the day being completed; defaults to the current day.
// Only the current day can be completed, so a double tap never skips ahead.
app.post('/api/journey/complete', h(async (req, res) => {
  const current = (await db.getJourney(req.user.id)).current_day;
  if (current > JOURNEY_DAYS.length) return res.json({ ...journeyPayload({ current_day: current }), advanced: false });
  const day = req.body?.day === undefined ? current : Number(req.body.day);
  if (!Number.isInteger(day) || day < 1 || day > JOURNEY_DAYS.length) return res.status(400).json({ error: 'day must be 1–7' });
  if (day !== current) return res.status(409).json({ error: `Day ${current} is your current day — complete it first.`, current_day: current });
  const row = await db.completeJourneyDay(req.user.id, day);
  res.json({ ...journeyPayload(row), advanced: row.advanced });
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
