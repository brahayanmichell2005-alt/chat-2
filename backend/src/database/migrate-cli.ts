import dotenv from "dotenv";
dotenv.config({ path: [".env", "../.env"] });

const { runMigrations } = await import("./migrate.js");
const { closePool } = await import("./pool.js");
try {
  await runMigrations();
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await closePool();
}
