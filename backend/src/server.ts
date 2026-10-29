import dotenv from "dotenv";
dotenv.config({ path: [".env", "../.env"] });

import { loadEnv } from "./config/env.js";

let env;
try {
  env = loadEnv();
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}

const { createApp } = await import("./app.js");
const { getLogger } = await import("./common/logger.js");
const { closePool, getPool } = await import("./database/pool.js");

const { startOutboxWorker } = await import("./modules/whatsapp/outbox.service.js");
const { getManager } = await import("./modules/whatsapp/whatsapp.service.js");

const { startAiResponder } = await import("./modules/ai/responder.js");

const { expireDueQuotes } = await import("./modules/sales/quotes.service.js");

const log = getLogger();
try {
  await getPool().query("SELECT 1");
} catch (e) {
  log.fatal({ err: e }, "No se pudo conectar a PostgreSQL. Revise DATABASE_URL y que la base esté activa.");
  process.exit(1);
}

const server = createApp().listen(env.PORT, () => log.info({ port: env.PORT }, "Backend iniciado"));

const stopWorker = startOutboxWorker();
const expiryTimer = setInterval(() => { expireDueQuotes().catch((e) => log.error({ err: e }, "Error al vencer cotizaciones")); }, 60_000);
expiryTimer.unref();
const stopAi = startAiResponder();
void getManager().autoConnectIfConfigured();

async function shutdown(signal: string) {
  log.info({ signal }, "Cerrando…");
  stopWorker();
  clearInterval(expiryTimer);
  stopAi();
  await getManager().shutdown();
  server.close(async () => {
    await closePool();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (err) => log.error({ err }, "unhandledRejection"));
