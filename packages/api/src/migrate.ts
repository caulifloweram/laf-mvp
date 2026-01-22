import { initDb } from "./db";

async function main() {
  try {
    await initDb();
    console.log("Migration complete!");
    process.exit(0);
  } catch (err) {
    console.error("Migration failed:", err);
    process.exit(1);
  }
}

main();
