// Applies schema.sql (tables, indexes, seed data) to the Postgres database at $DATABASE_URL.
// Idempotent — safe to run on every deploy. `npm start` runs it before server.js.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('./db');

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  const client = await db.getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(sql); // multi-statement simple query
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  const s = await db.stats();
  console.log(`[initDB] Schema ready on ${db.getPath()} — ${s.users} users, ${s.meal_logs} meal logs, ${s.chat_messages} chat messages`);
}

main()
  .then(() => db.close())
  .catch(async (err) => {
    console.error('[initDB] Failed:', db.describeError(err));
    await db.close().catch(() => {});
    process.exit(1);
  });
