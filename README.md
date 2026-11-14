# 🥗 NutriPath

**AI-powered, culturally-aware nutrition platform for Indian users** — especially hostel students with only a kettle, a mess menu and a tight budget.

- **Phones (< 1024 px):** phone frame, summary-only Home, bottom nav; every module opens as a bottom sheet.
- **Desktop (≥ 1024 px):** left sidebar nav + 12-column grid — 7-column dashboard and a 5-column right panel where modules render. A top-right toggle switches to the phone preview for presentations.

---

## 🏠 Home Dashboard (summaries only)

`Hello, <Name>` · AI chat entry · 4 module icons · calorie ring + protein/carb/fat rings · water tracker · **Steps** and **Calories Burned** cards (from Health Sync).
Rings come from the meals the user actually logs (`meal_logs`), and refresh right after every log or delete.

## 🧩 Modules (all deep features live inside these)

| Module | Inside the modal | API |
|---|---|---|
| **🍽️ Diet Planner** | **Meal Plans** (3 gap-targeted Indian plans, log any meal, local swaps, chai-time iron timer) · **Scan & Log** (html5-qrcode barcode scan → Open Food Facts, AI meal photo, manual log) · **Hostel Menu** (AI mess-menu reader, kettle/induction recipes) | `GET /api/diet-planner` · `GET /api/barcode/:code` · `POST /api/vision` · `POST /api/log-meal` |
| **👟 Fitness Nutrition** | Slider TDEE calculator (live Mifflin–St Jeor, save as target) · Pre/post-workout fuel timeline · Today's food log with **Delete** | `GET /api/fitness` · `GET /api/meals` · `DELETE /api/log-meal/:id` |
| **❤️‍🩹 Health & Recovery** | **Lab Analyzer** (B12 / ferritin / Vit D / Hb → status + diet-specific food fixes, saved to history) · **Recovery Roadmap** (interactive Day 1–14 checklists for Viral Fever & Dengue, saved) · **Condition toggles** (Diabetes, Hypertension, PCOS, Cholesterol, 40+ → food warnings) | `POST /api/lab-analyze` · `GET /api/recovery/:plan` · `POST /api/recovery/:plan/check` · `GET/PUT /api/conditions` |
| **💊 Supplement Hub** | Interaction checker (medication + supplement dropdowns) · 3-question AI quiz · **Partner Brands / Sponsored** cards · supplement library | `GET /api/supplements` · `POST /api/supplements/quiz` · `GET /api/sponsored` |
| **🤖 AI Chat** | Gemini Indian-nutritionist, profile- and intake-aware, per-user history | `POST /api/chat` · `GET /api/chat/history` |
| **📊 Analytics** | Real 7-day calorie chart vs target · nutrient gaps · latest labs | `GET /api/analytics` |
| **🧑 Profile** | Sync Health App (Google Fit / Apple Health, mocked) · daily email opt-in + **Send test email** · health & hostel profile · sign out | `GET/PUT /api/profile` · `POST /api/health-sync` · `POST /api/email/test` |

Sponsored products are placeholder listings (`/api/sponsored`); "Buy Now" shows a placeholder notice until real partner links exist.

---

## 🔐 Auth & Onboarding

1. The login overlay offers **Continue with Google** (Firebase Auth, compat SDK from gstatic).
2. The browser sends the Firebase ID token to `POST /api/auth/login`. The server verifies the RS256 signature against Google's published certs plus `aud`/`iss`/`exp` (`auth.js`, no `firebase-admin` dependency), upserts the `users` row, and returns an HMAC-signed session token (30 days).
3. Every other `/api/*` route requires `Authorization: Bearer <session>`; each user only sees their own data.
4. New users get a 3-step onboarding modal (**Goal → Diet → Allergies**, plus body stats) → `POST /api/users/setup`.

**No Firebase project yet?** Leave `FIREBASE_*` blank and the login screen shows a **demo sign-in** (name + optional email) instead. It is turned off automatically once Firebase is configured (override with `ALLOW_DEMO_LOGIN`).

## 📧 Daily summary email

`node-cron` runs `0 8 * * *` in `APP_TZ` (default Asia/Kolkata) and emails each opted-in user yesterday's calories, macros, water and steps via `nodemailer`. Without `SMTP_HOST`, messages are rendered and written to the server log instead of being delivered. Every send is recorded in `email_log`.

## 🗄️ Data — PostgreSQL (Neon)

Uses `pg` with a connection pool on `DATABASE_URL` (a free [Neon](https://neon.tech) database in production; SSL is on automatically for non-localhost hosts). `npm start` runs `initDB.js` first, which applies `schema.sql` (tables, indexes, and a seeded `Guest` account) idempotently:

`users` · `health_profiles` · `daily_logs` (water, steps, burned) · `meal_logs` · `meal_plans` · `chatbot_history` · `health_observations` · `recovery_checks` · `email_log`

Reference data (foods, recipes, supplements, interaction rules) lives in `data.js`.

---

## 🧮 Mifflin–St Jeor

```
BMR  = 10 × weight(kg) + 6.25 × height(cm) − 5 × age + s      s = +5 (male), −161 (female)
TDEE = BMR × activity      sedentary 1.2 · light 1.375 · moderate 1.55 · active 1.725 · very_active 1.9
Goal: lose = TDEE − 500 · maintain = TDEE · recomp = TDEE × 0.94 · gain = TDEE + 300
Protein = 1.8 g/kg (1.4 on maintain) · Fat = 25% of kcal · Carbs = remainder
```

---

## 🚀 Setup

**Requirements:** Node.js 22.13+ (24 recommended). Gemini, Firebase and SMTP are all optional.

```bash
npm install
cp .env.example .env     # fill in what you have
npm start                # runs initDB.js, then → http://localhost:3000 (needs DATABASE_URL)
```

See `.env.example` for every variable. Deep links open a module directly: `/#diet`, `/#fitness`, `/#recovery`, `/#supplements`, `/#analytics`, `/#profile`, `/#chat`.

**Firebase setup:** Firebase console → add a Web app → copy `apiKey`, `projectId`, `appId` → enable **Google** under Authentication → Sign-in method → add your domain (and `localhost`) under Authorized domains.

---

## 🐳 Deployment

### Docker

```bash
docker build -t nutripath .
docker run -p 3000:3000 --env-file .env nutripath
```

`node:24-alpine`, production deps only, non-root `node` user, `HEALTHCHECK` on `/api/health`. The container is stateless: all data lives in the Postgres database at `DATABASE_URL`.

### Render

`render.yaml` deploys a free Node web service (`npm ci --omit=dev`, then `npm start`). Data lives in Neon, so the free plan's ephemeral disk loses nothing. In the Render dashboard, set `DATABASE_URL` (Neon connection string), `GEMINI_API_KEY`, and optionally `GMAIL_USER`/`GMAIL_PASS` (a Gmail App Password). `SESSION_SECRET` is generated by the blueprint so sign-ins survive restarts.

---

## 📁 Project Structure

```
nutripath/
├── server.js        # Express API — all modules, auth gate, cron start
├── db.js            # PostgreSQL data layer (pg Pool, async)
├── initDB.js        # Applies schema.sql + seed data (run by npm start)
├── auth.js          # Firebase ID-token verification + session tokens
├── mailer.js        # nodemailer transport + 8 AM node-cron job
├── data.js          # Reference data: foods, recipes, supplements, warnings
├── schema.sql       # PostgreSQL schema + seed
├── public/
│   ├── index.html   # Login, onboarding, home dashboard, sheet/panel shell
│   ├── style.css    # Phone frame ↔ desktop 12-col grid
│   └── app.js       # Auth flow, dashboard, module modals
├── Dockerfile · .dockerignore · render.yaml
└── README.md
```

---

## ⚕️ Clinical Safeguard

NutriPath provides general nutrition education, **not medical advice**. It does not diagnose, treat or prescribe. Consult a qualified doctor or registered dietitian before changing your diet or starting supplements, especially if you have a medical condition, are pregnant, or take prescription medication. In an emergency, call **112**.
