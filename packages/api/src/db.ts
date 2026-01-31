import { Pool } from "pg";
import * as dotenv from "dotenv";

dotenv.config();

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://localhost:5432/laf_mvp",
  // Don't crash on connection errors
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
});

// Handle pool errors without crashing
pool.on("error", (err) => {
  console.error("❌ Unexpected database pool error:", err);
  // Don't crash - just log the error
});

export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS channels (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title VARCHAR(255) NOT NULL,
      description TEXT,
      cover_url TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`
    ALTER TABLE channels ADD COLUMN IF NOT EXISTS cover_url TEXT
  `).catch(() => { /* column may already exist */ });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS streams (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      stream_id BIGINT UNIQUE NOT NULL,
      started_at TIMESTAMP DEFAULT NOW(),
      ended_at TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_channels_owner ON channels(owner_id);
    CREATE INDEX IF NOT EXISTS idx_streams_channel ON streams(channel_id);
    CREATE INDEX IF NOT EXISTS idx_streams_active ON streams(ended_at) WHERE ended_at IS NULL;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS external_stations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(255) NOT NULL,
      description TEXT,
      website_url TEXT NOT NULL,
      stream_url TEXT NOT NULL,
      logo_url TEXT,
      submitted_by UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_external_stations_name ON external_stations(name);
  `).catch(() => {});

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_favorites (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind VARCHAR(20) NOT NULL CHECK (kind IN ('laf', 'external')),
      ref TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_id, kind, ref)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_user_favorites_user ON user_favorites(user_id);
  `).catch(() => {});

  console.log("✅ Database tables initialized");
}
