// Daily calorie-summary emails: nodemailer transport + node-cron 8 AM job.
// With SMTP_HOST set, mail is delivered via SMTP. Without it, nodemailer's JSON transport
// is used: messages are rendered and logged to the console (nothing leaves the machine),
// so the cron job and the Profile "Send test email" button work in development.
const nodemailer = require('nodemailer');
const cron = require('node-cron');

// Gmail shortcut: GMAIL_USER + GMAIL_PASS (a 16-char Google App Password, not your login password)
const gmailConfigured = Boolean(process.env.GMAIL_USER && process.env.GMAIL_PASS);
const smtpConfigured = gmailConfigured || Boolean(process.env.SMTP_HOST);
const transport = gmailConfigured
  ? nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASS } })
  : smtpConfigured
    ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true' || Number(process.env.SMTP_PORT) === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    })
    : nodemailer.createTransport({ jsonTransport: true });
const FROM = process.env.MAIL_FROM || (gmailConfigured ? `NutriPath <${process.env.GMAIL_USER}>` : 'NutriPath <no-reply@nutripath.local>');
const CRON = process.env.DAILY_EMAIL_CRON || '0 8 * * *'; // 08:00 every day

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => Number(n || 0).toLocaleString('en-IN');

// summary = { date, totals, targets, water, steps, burned, meals }
function render(user, s, kind) {
  const pct = s.targets.calories ? Math.round((s.totals.calories / s.targets.calories) * 100) : 0;
  const verdict = s.totals.items === 0 ? 'No meals were logged — try scanning a barcode or snapping your plate today.'
    : pct < 80 ? 'You ate well under your target. Add a protein-rich snack (sattu, paneer, eggs, roasted chana).'
      : pct > 110 ? 'You went over your target. Go lighter on rice/roti portions today.'
        : 'Right on target — great consistency!';
  const label = kind === 'test' ? `Test summary for ${s.date}` : `Your NutriPath summary for ${s.date}`;
  const row = (k, v, t) => `<tr><td style="padding:6px 0;color:#6b7280">${k}</td><td style="padding:6px 0;text-align:right;font-weight:600">${v}</td><td style="padding:6px 0 6px 8px;color:#9ca3af;text-align:right">${t || ''}</td></tr>`;
  const html = `<div style="font-family:Inter,Segoe UI,Arial,sans-serif;max-width:520px;margin:auto;color:#111827">
    <div style="background:linear-gradient(100deg,#2bb3c0,#3fc39a 55%,#7fd877);color:#fff;border-radius:16px;padding:20px">
      <div style="font-size:13px;opacity:.9">🥗 NutriPath</div>
      <div style="font-size:20px;font-weight:700;margin-top:4px">Hi ${esc(user.name)}, ${esc(label)}</div>
      <div style="font-size:36px;font-weight:800;margin-top:12px">${fmt(s.totals.calories)} <span style="font-size:16px;font-weight:500">/ ${fmt(s.targets.calories)} kcal (${pct}%)</span></div>
    </div>
    <table style="width:100%;border-collapse:collapse;margin-top:16px;font-size:14px">
      ${row('Protein', `${fmt(s.totals.protein_g)} g`, `target ${fmt(s.targets.macros.protein_g)} g`)}
      ${row('Carbs', `${fmt(s.totals.carbs_g)} g`, `target ${fmt(s.targets.macros.carbs_g)} g`)}
      ${row('Fat', `${fmt(s.totals.fat_g)} g`, `target ${fmt(s.targets.macros.fat_g)} g`)}
      ${row('Water', `${s.water} glasses`, `target ${s.water_target}`)}
      ${row('Steps', s.steps != null ? fmt(s.steps) : '—', s.burned != null ? `${fmt(s.burned)} kcal burned` : 'sync your health app')}
    </table>
    <p style="background:#ecfdf5;color:#065f46;border-radius:12px;padding:12px;font-size:14px">💡 ${esc(verdict)}</p>
    ${s.meals.length ? `<p style="font-size:13px;color:#6b7280">Logged: ${s.meals.map((m) => esc(m.name)).join(' · ')}</p>` : ''}
    <p style="font-size:11px;color:#9ca3af">General nutrition guidance, not medical advice. Turn these emails off in Profile.</p>
  </div>`;
  const text = `${label}\nCalories: ${s.totals.calories}/${s.targets.calories} kcal (${pct}%)\nProtein ${s.totals.protein_g} g · Carbs ${s.totals.carbs_g} g · Fat ${s.totals.fat_g} g\nWater: ${s.water}/${s.water_target} glasses\n${verdict}`;
  return { subject: `🥗 ${label}: ${fmt(s.totals.calories)} kcal`, html, text };
}

async function sendSummary(db, user, summary, kind) {
  const { subject, html, text } = render(user, summary, kind);
  try {
    const info = await transport.sendMail({ from: FROM, to: user.email, subject, html, text });
    const status = smtpConfigured ? 'sent' : 'logged';
    if (!smtpConfigured) console.log(`[mail] (no SMTP configured — not delivered) to=${user.email} subject="${subject}"`);
    await db.logEmail(user.id, kind, user.email, status, info.messageId);
    return { status, to: user.email, subject, messageId: info.messageId, delivered: smtpConfigured };
  } catch (err) {
    await db.logEmail(user.id, kind, user.email, 'failed', err.message).catch((e) => console.error('[mail] log failed:', e.message));
    throw err;
  }
}

// buildSummary(userId, date) is provided by server.js (it owns the calorie math)
function startDailyJob(db, buildSummary) {
  const task = cron.schedule(CRON, async () => {
    const date = db.daysAgo(1); // at 8 AM, summarise yesterday
    let users = [];
    try { users = await db.listEmailableUsers(); } catch (err) { return console.error('[mail] Could not load recipients:', err.message); }
    console.log(`[mail] Daily summary job: ${users.length} recipient(s) for ${date}`);
    for (const user of users) {
      try {
        await sendSummary(db, user, await buildSummary(user.id, date), 'daily');
      } catch (err) {
        console.error(`[mail] Failed for user ${user.id}:`, err.message);
      }
    }
  }, { timezone: db.APP_TZ, name: 'daily-summary' });
  console.log(`[mail] Daily summary scheduled "${CRON}" (${db.APP_TZ}) via ${gmailConfigured ? 'Gmail' : smtpConfigured ? 'SMTP' : 'console log (set GMAIL_USER/GMAIL_PASS or SMTP_HOST to deliver)'}`);
  return task;
}

module.exports = { sendSummary, startDailyJob, smtpConfigured };
