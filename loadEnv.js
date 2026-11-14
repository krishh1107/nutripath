// Loads local env files. `.env.local` holds the Neon variables written by `neon env pull`
// (DATABASE_URL, DATABASE_URL_UNPOOLED, NEON_AUTH_*); `.env` holds app secrets (GEMINI_API_KEY, …).
// The first file to define a key wins, and real environment variables (e.g. set in the Render
// dashboard) always win over both files. Neither file exists on Render, which is fine.
const path = require('path');

require('dotenv').config({
  path: ['.env.local', '.env'].map((f) => path.join(__dirname, f)),
  quiet: true,
});
