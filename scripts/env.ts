try {
  process.loadEnvFile(new URL("../.env.local", import.meta.url));
} catch {}
