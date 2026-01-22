import { Client } from "pg";
import * as dotenv from "dotenv";

dotenv.config();

const connectionString = process.env.DATABASE_URL || "postgresql://localhost:5432/postgres";

async function createDatabase() {
  // Connect to default 'postgres' database to create our database
  const client = new Client({
    connectionString: connectionString.replace(/\/[^/]+$/, "/postgres")
  });

  try {
    await client.connect();
    console.log("Connected to PostgreSQL");

    // Check if database exists
    const result = await client.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      ["laf_mvp"]
    );

    if (result.rows.length > 0) {
      console.log("Database 'laf_mvp' already exists");
    } else {
      await client.query("CREATE DATABASE laf_mvp");
      console.log("✅ Database 'laf_mvp' created successfully!");
    }

    await client.end();
  } catch (err: any) {
    console.error("Failed to create database:", err.message);
    console.error("\nTroubleshooting:");
    console.error("1. Make sure PostgreSQL is running");
    console.error("2. Check your DATABASE_URL in .env file");
    console.error("3. Try creating manually: createdb laf_mvp");
    process.exit(1);
  }
}

createDatabase();
