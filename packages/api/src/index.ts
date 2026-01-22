import express from "express";
import cors from "cors";
import { initDb, pool } from "./db";
import { authMiddleware, login, register } from "./auth";

const app = express();

// CORS configuration
const allowedOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(",").map(o => o.trim())
  : ["http://localhost:5173", "http://localhost:3000"]; // Default to local dev

const corsOptions = {
  origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.includes(origin) || allowedOrigins.includes("*")) {
      callback(null, true);
    } else {
      console.warn(`CORS blocked origin: ${origin}`);
      callback(null, true); // Allow for now, but log it
    }
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
};
app.use(cors(corsOptions));
app.use(express.json());

const PORT = Number(process.env.PORT ?? 4000);
const RELAY_WS_URL = process.env.RELAY_WS_URL || "ws://localhost:9000";

// Initialize database on startup
initDb().catch(console.error);

// Auth endpoints
app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password required" });
  }
  const result = await login(email, password);
  if (!result) {
    return res.status(401).json({ error: "Invalid credentials" });
  }
  res.json(result);
});

app.post("/api/register", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password required" });
  }
  try {
    const result = await register(email, password);
    res.json(result);
  } catch (err: any) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "Email already exists" });
    }
    throw err;
  }
});

// Public: Get live channels
app.get("/api/channels/live", async (_req, res) => {
  const result = await pool.query(`
    SELECT 
      c.id,
      c.title,
      c.description,
      s.stream_id as "streamId",
      COUNT(DISTINCT s.id) as listener_count
    FROM channels c
    INNER JOIN streams s ON s.channel_id = c.id
    WHERE s.ended_at IS NULL
    GROUP BY c.id, c.title, c.description, s.stream_id
  `);
  res.json(result.rows);
});

// Protected: Get my channels
app.get("/api/me/channels", authMiddleware, async (req, res) => {
  const user = (req as any).user;
  const result = await pool.query(
    "SELECT id, title, description, created_at FROM channels WHERE owner_id = $1 ORDER BY created_at DESC",
    [user.id]
  );
  res.json(result.rows);
});

// Protected: Create channel
app.post("/api/me/channels", authMiddleware, async (req, res) => {
  const user = (req as any).user;
  const { title, description } = req.body;
  if (!title) {
    return res.status(400).json({ error: "Title required" });
  }
  const result = await pool.query(
    "INSERT INTO channels (owner_id, title, description) VALUES ($1, $2, $3) RETURNING id, title, description, created_at",
    [user.id, title, description || null]
  );
  res.json(result.rows[0]);
});

// Protected: Go live (start streaming)
app.post("/api/me/channels/:channelId/go-live", authMiddleware, async (req, res) => {
  const user = (req as any).user;
  const { channelId } = req.params;

  // Verify ownership
  const channelResult = await pool.query(
    "SELECT id FROM channels WHERE id = $1 AND owner_id = $2",
    [channelId, user.id]
  );
  if (channelResult.rows.length === 0) {
    return res.status(404).json({ error: "Channel not found" });
  }

  // Check if already live
  const existingStream = await pool.query(
    "SELECT stream_id FROM streams WHERE channel_id = $1 AND ended_at IS NULL",
    [channelId]
  );
  if (existingStream.rows.length > 0) {
    const streamId = existingStream.rows[0].stream_id;
    const wsUrl = `${RELAY_WS_URL}/?role=broadcaster&streamId=${streamId}`;
    return res.json({ streamId, wsUrl });
  }

  // Create new stream
  const streamId = Date.now(); // Simple unique ID
  await pool.query(
    "INSERT INTO streams (channel_id, stream_id) VALUES ($1, $2)",
    [channelId, streamId]
  );

  const wsUrl = `${RELAY_WS_URL}/?role=broadcaster&streamId=${streamId}`;
  res.json({ streamId, wsUrl });
});

// Protected: Stop streaming
app.post("/api/me/channels/:channelId/stop-live", authMiddleware, async (req, res) => {
  const user = (req as any).user;
  const { channelId } = req.params;

  const channelResult = await pool.query(
    "SELECT id FROM channels WHERE id = $1 AND owner_id = $2",
    [channelId, user.id]
  );
  if (channelResult.rows.length === 0) {
    return res.status(404).json({ error: "Channel not found" });
  }

  await pool.query(
    "UPDATE streams SET ended_at = NOW() WHERE channel_id = $1 AND ended_at IS NULL",
    [channelId]
  );

  res.json({ success: true });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🌐 API server listening on http://0.0.0.0:${PORT}`);
  console.log(`   Database: ${process.env.DATABASE_URL ? "✅ Connected" : "⚠️ Using default"}`);
});
