// Database layer: PostgreSQL via `pg` (Neon.tech in production, any Postgres locally).
// Connects to $DATABASE_URL. Every method is async — callers must `await` them.
// Schema + seed data are applied by initDB.js (`npm start` runs it before server.js).
const { Pool } = require('pg');

const APP_TZ = process.env.APP_TZ || 'Asia/Kolkata';
const DATABASE_URL = process.env.DATABASE_URL;

// YYYY-MM-DD for "today" (or another instant) in the app's timezone
const dateIn = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: APP_TZ }).format(d);
const today = () => dateIn();
const daysAgo = (n) => dateIn(new Date(Date.now() - n * 86400000));

// Cloud Postgres (Neon, Render, Supabase…) requires TLS. Local servers usually don't speak it,
// so skip SSL for localhost or when PGSSLMODE=disable.
function sslConfig(url) {
  if (process.env.PGSSLMODE === 'disable') return false;
  try {
    if (['localhost', '127.0.0.1', '::1'].includes(new URL(url).hostname)) return false;
  } catch { /* fall through */ }
  return { rejectUnauthorized: false };
}

let pool = null;
function getPool() {
  if (pool) return pool;
  if (!DATABASE_URL) {
    throw new Error('DATABASE_URL is not set. Add your Neon connection string to .env (see .env.example).');
  }
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: sslConfig(DATABASE_URL),
    max: Number(process.env.PG_POOL_MAX || 5), // Neon free tier has a small connection budget
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });
  // An idle client erroring (e.g. Neon suspending the compute) must not crash the process
  pool.on('error', (err) => console.error('[db] idle client error:', err.message));
  return pool;
}

// Readable error text: connection failures (ECONNREFUSED on ::1 and 127.0.0.1) arrive as an
// AggregateError whose .message is empty
function describeError(err) {
  if (err?.errors?.length) return err.errors.map(describeError).join('; ');
  const msg = err?.message || err?.code || String(err);
  if (err?.code === 'ECONNREFUSED') return `${msg} — is Postgres running at DATABASE_URL? (${err.address}:${err.port})`;
  return msg;
}

// Run a query; returns all rows
const query = async (text, params = []) => (await getPool().query(text, params)).rows;
const one = async (text, params = []) => (await query(text, params))[0];

// Postgres equivalent of SQLite's datetime('now') as stored by this app (UTC text)
const NOW = "to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')";

const JSON_COLS = ['conditions', 'medications', 'allergies', 'appliances'];
const parseJSON = (v, fallback) => { try { return JSON.parse(v); } catch { return fallback; } };

function hydrateProfile(row) {
  if (!row) return row;
  const out = { ...row };
  for (const c of JSON_COLS) out[c] = parseJSON(out[c], []);
  return out;
}

// Columns the app may write on health_profiles
const PROFILE_FIELDS = ['age', 'sex', 'height_cm', 'weight_kg', 'activity_level', 'goal', 'diet_type', 'conditions',
  'medications', 'allergies', 'appliances', 'living_setup', 'mess_menu', 'monthly_food_budget',
  'daily_calorie_target', 'daily_water_target'];

// Builds "a = $1, b = $2" and the matching values array, starting at $start
const setClause = (entries, start = 1) => ({
  sql: entries.map(([k], i) => `${k} = $${start + i}`).join(', '),
  values: entries.map(([, v]) => v),
});

const db = {
  today,
  daysAgo,
  dateIn,
  APP_TZ,
  query,
  getPool,
  describeError,
  async close() { if (pool) { await pool.end(); pool = null; } },
  // Host of the database (never the credentials), for /api/health
  getPath() {
    try { return new URL(DATABASE_URL).host; } catch { return '(DATABASE_URL not set)'; }
  },
  async ping() { await query('SELECT 1'); },

  // ----- users -----
  async upsertUser({ firebase_uid, email, name, photo_url, provider }) {
    // Single atomic upsert; xmax = 0 means the row was inserted rather than updated
    const row = await one(
      `INSERT INTO users (firebase_uid, email, name, photo_url, provider) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (firebase_uid) DO UPDATE SET email = COALESCE(EXCLUDED.email, users.email),
         photo_url = COALESCE(EXCLUDED.photo_url, users.photo_url), last_login_at = ${NOW}
       RETURNING *, (xmax = 0) AS inserted`,
      [firebase_uid, email ?? null, name || 'Friend', photo_url ?? null, provider || 'google'],
    );
    await query('INSERT INTO health_profiles (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [row.id]);
    const { inserted, ...user } = row;
    return { user, isNew: inserted };
  },

  getUser: (id) => one('SELECT * FROM users WHERE id = $1', [id]),
  listEmailableUsers: () => query("SELECT * FROM users WHERE email IS NOT NULL AND email <> '' AND email_opt_in = 1"),
  async updateUser(id, fields) {
    const allowed = Object.entries(fields).filter(([k, v]) => ['name', 'onboarded', 'email_opt_in'].includes(k) && v !== undefined);
    if (allowed.length) {
      const { sql, values } = setClause(allowed);
      await query(`UPDATE users SET ${sql} WHERE id = $${values.length + 1}`, [...values, id]);
    }
    return db.getUser(id);
  },

  // ----- health_profiles -----
  getHealthProfile: async (userId) => hydrateProfile(await one('SELECT * FROM health_profiles WHERE user_id = $1', [userId])),
  async updateHealthProfile(userId, fields) {
    const entries = Object.entries(fields)
      .filter(([k, v]) => PROFILE_FIELDS.includes(k) && v !== undefined)
      .map(([k, v]) => [k, JSON_COLS.includes(k) ? JSON.stringify(v) : v]);
    if (entries.length) {
      const { sql, values } = setClause(entries);
      await query(`UPDATE health_profiles SET ${sql}, updated_at = ${NOW} WHERE user_id = $${values.length + 1}`, [...values, userId]);
    }
    return db.getHealthProfile(userId);
  },

  // ----- daily_logs (water + activity) -----
  getDailyLog: (userId, date = today()) => one('SELECT * FROM daily_logs WHERE user_id = $1 AND log_date = $2', [userId, date]),
  setWater: (userId, glasses, date = today()) => one(
    `INSERT INTO daily_logs (user_id, log_date, water_glasses) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, log_date) DO UPDATE SET water_glasses = EXCLUDED.water_glasses
     RETURNING *`, [userId, date, glasses],
  ),
  setActivity: (userId, { steps, calories_burned, active_minutes, sync_source }, date = today()) => one(
    `INSERT INTO daily_logs (user_id, log_date, steps, calories_burned, active_minutes, sync_source, synced_at)
     VALUES ($1, $2, $3, $4, $5, $6, ${NOW})
     ON CONFLICT (user_id, log_date) DO UPDATE SET steps = EXCLUDED.steps, calories_burned = EXCLUDED.calories_burned,
       active_minutes = EXCLUDED.active_minutes, sync_source = EXCLUDED.sync_source, synced_at = EXCLUDED.synced_at
     RETURNING *`, [userId, date, steps, calories_burned, active_minutes, sync_source],
  ),

  // ----- meal_logs -----
  addMeal: (userId, m, date = today()) => one(
    `INSERT INTO meal_logs (user_id, log_date, name, quantity, kcal, protein_g, carbs_g, fat_g, source, barcode)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [userId, date, m.name, m.quantity ?? null, m.kcal, m.protein_g, m.carbs_g, m.fat_g, m.source, m.barcode ?? null],
  ),
  listMeals: (userId, date = today()) => query('SELECT * FROM meal_logs WHERE user_id = $1 AND log_date = $2 ORDER BY id', [userId, date]),
  deleteMeal: async (userId, id) => (await getPool().query('DELETE FROM meal_logs WHERE id = $1 AND user_id = $2', [id, userId])).rowCount > 0,
  async mealTotals(userId, date = today()) {
    // COUNT returns bigint (a string in pg) — cast to int
    const r = await one(`SELECT COUNT(*)::int AS items, COALESCE(SUM(kcal),0) AS calories, COALESCE(SUM(protein_g),0) AS protein_g,
                 COALESCE(SUM(carbs_g),0) AS carbs_g, COALESCE(SUM(fat_g),0) AS fat_g
                 FROM meal_logs WHERE user_id = $1 AND log_date = $2`, [userId, date]);
    return { items: r.items, calories: Math.round(r.calories), protein_g: Math.round(r.protein_g), carbs_g: Math.round(r.carbs_g), fat_g: Math.round(r.fat_g) };
  },
  async weeklyCalories(userId) {
    const rows = await query('SELECT log_date, SUM(kcal) AS kcal, SUM(protein_g) AS protein FROM meal_logs WHERE user_id = $1 AND log_date >= $2 GROUP BY log_date',
      [userId, daysAgo(6)]);
    const byDate = Object.fromEntries(rows.map((r) => [r.log_date, r]));
    return Array.from({ length: 7 }, (_, i) => {
      const d = daysAgo(6 - i);
      return { date: d, kcal: Math.round(byDate[d]?.kcal || 0), protein_g: Math.round(byDate[d]?.protein || 0) };
    });
  },

  // ----- meal_plans -----
  saveMealPlan: (userId, focus, meals, totalKcal) => query('INSERT INTO meal_plans (user_id, focus, meals, total_kcal) VALUES ($1, $2, $3, $4)',
    [userId, focus, JSON.stringify(meals), totalKcal]),

  // ----- chatbot_history -----
  addChatMessage: (userId, role, message) => query('INSERT INTO chatbot_history (user_id, role, message) VALUES ($1, $2, $3)', [userId, role, message]),
  getChatHistory: (userId, limit = 20) => query(
    'SELECT role, message FROM (SELECT * FROM chatbot_history WHERE user_id = $1 ORDER BY id DESC LIMIT $2) h ORDER BY id ASC',
    [userId, limit],
  ),

  // ----- health_observations -----
  addObservation: (userId, o) => query(
    'INSERT INTO health_observations (user_id, observed_on, metric, value, unit, reference_range, status) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [userId, o.observed_on || today(), o.metric, o.value, o.unit, o.reference_range, o.status],
  ),
  // Latest reading per metric
  getHealthObservations: (userId) => query(
    `SELECT * FROM health_observations o WHERE user_id = $1 AND id = (
       SELECT MAX(id) FROM health_observations WHERE user_id = o.user_id AND metric = o.metric)
     ORDER BY metric`, [userId],
  ),

  // ----- recovery_checks -----
  getRecoveryChecks: (userId, plan) => query('SELECT day, item FROM recovery_checks WHERE user_id = $1 AND plan = $2', [userId, plan]),
  async setRecoveryCheck(userId, plan, day, item, done) {
    if (done) await query('INSERT INTO recovery_checks (user_id, plan, day, item) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [userId, plan, day, item]);
    else await query('DELETE FROM recovery_checks WHERE user_id = $1 AND plan = $2 AND day = $3 AND item = $4', [userId, plan, day, item]);
  },
  resetRecovery: (userId, plan) => query('DELETE FROM recovery_checks WHERE user_id = $1 AND plan = $2', [userId, plan]),

  // ----- email_log -----
  logEmail: (userId, kind, to, status, detail) => query('INSERT INTO email_log (user_id, kind, to_addr, status, detail) VALUES ($1, $2, $3, $4, $5)',
    [userId, kind, to, status, detail ?? null]),

  stats: () => one(`SELECT (SELECT COUNT(*) FROM users)::int AS users, (SELECT COUNT(*) FROM meal_logs)::int AS meal_logs,
    (SELECT COUNT(*) FROM chatbot_history)::int AS chat_messages`),
};

module.exports = db;
