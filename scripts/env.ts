// Loads .env.local when present (local runs); CI passes the variables directly.
try {
  process.loadEnvFile(new URL("../.env.local", import.meta.url));
} catch {}
