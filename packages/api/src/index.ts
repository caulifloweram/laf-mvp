import express from "express";
import cors from "cors";
import { initDb, pool } from "./db";
import { authMiddleware, login, register } from "./auth";

const app = express();

// CORS - Apply FIRST, before any other middleware
// When credentials: true, we must use a function for origin, not "*"
app.use(cors({
  origin: (origin, callback) => {
    // Allow all origins when credentials are needed
    callback(null, true);
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "Accept", "Origin"],
  exposedHeaders: ["Content-Type", "Authorization"],
  preflightContinue: false,
  optionsSuccessStatus: 204
}));

// Explicit OPTIONS handler as backup - sets headers manually
app.options("*", (req, res) => {
  console.log(`OPTIONS request from origin: ${req.headers.origin}`);
  const origin = req.headers.origin || "*";
  res.header("Access-Control-Allow-Origin", origin);
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS, PATCH");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, Accept, Origin");
  res.header("Access-Control-Allow-Credentials", "true");
  res.header("Access-Control-Max-Age", "86400"); // 24 hours
  res.sendStatus(204);
});

// Parse JSON bodies
app.use(express.json());

// Log all requests for debugging
app.use((req, res, next) => {
  console.log(`${req.method} ${req.path} - Origin: ${req.headers.origin || 'none'}`);
  // Log response when it finishes
  res.on("finish", () => {
    console.log(`${req.method} ${req.path} - Status: ${res.statusCode}`);
  });
  next();
});

const PORT = Number(process.env.PORT ?? 4000);
const RELAY_WS_URL = process.env.RELAY_WS_URL || "ws://localhost:9000";

// Health check endpoint - put it early so we can test if API is running
// Railway uses HEAD requests for health checks, so we need to handle both GET and HEAD
const healthCheckHandler = (req: express.Request, res: express.Response) => {
  console.log(`🏥 Health check called (${req.method})`);
  
  // Send response immediately - no async operations
  res.status(200);
  
  // For GET requests, send JSON body. For HEAD, just send status.
  if (req.method === "GET") {
    res.json({ 
      status: "ok", 
      timestamp: new Date().toISOString(),
      port: PORT,
      cors: "enabled",
      uptime: process.uptime()
    });
  } else {
    // HEAD request - just send status, no body
    res.end();
  }
  
  console.log(`✅ Health check response sent - Status: 200 (${req.method})`);
};

app.get("/health", healthCheckHandler);
app.head("/health", healthCheckHandler);

// Initialize database on startup (non-blocking)
// Don't block server startup if DB fails
initDb()
  .then(() => {
    console.log("✅ Database initialization completed");
  })
  .catch((err) => {
    console.error("❌ Database initialization error:", err);
    console.error("   API will continue but database operations may fail");
    // Don't crash - API can still serve some endpoints
  });

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

// Start server with error handling
console.log(`🚀 Starting API server...`);
console.log(`   PORT: ${PORT}`);
console.log(`   DATABASE_URL: ${process.env.DATABASE_URL ? "✅ Set" : "❌ Not set"}`);

try {
  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`🌐 API server listening on http://0.0.0.0:${PORT}`);
    console.log(`   Health check: http://0.0.0.0:${PORT}/health`);
    console.log(`   Database: ${process.env.DATABASE_URL ? "✅ Configured" : "⚠️ Not configured"}`);
    console.log(`   CORS: ✅ Enabled (allowing all origins)`);
    console.log(`   Environment: ${process.env.NODE_ENV || "development"}`);
    console.log(`   ✅ Server started successfully!`);
    console.log(`   Process PID: ${process.pid}`);
  });

  // Handle server errors
  server.on("error", (err: any) => {
    console.error("❌ Server error:", err);
    if (err.code === "EADDRINUSE") {
      console.error(`   Port ${PORT} is already in use`);
    }
    // Don't exit immediately - let Railway handle it
    console.error("   Server will continue running...");
  });

  // Keep the process alive
  server.on("close", () => {
    console.log("⚠️ Server closed");
  });

  // Graceful shutdown
  process.on("SIGTERM", () => {
    console.log("📴 SIGTERM received, shutting down gracefully...");
    server.close(() => {
      console.log("✅ Server closed gracefully");
      process.exit(0);
    });
  });

  process.on("SIGINT", () => {
    console.log("📴 SIGINT received, shutting down gracefully...");
    server.close(() => {
      console.log("✅ Server closed gracefully");
      process.exit(0);
    });
  });
} catch (error) {
  console.error("❌ Failed to start server:", error);
  console.error("   Error details:", error);
  // Exit with error code so Railway knows it failed
  process.exit(1);
}

// Handle errors - but don't exit
process.on("uncaughtException", (err) => {
  console.error("❌ Uncaught Exception:", err);
  console.error("   Stack:", err.stack);
  // Don't exit - keep the server running
  // Railway will restart if needed
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("❌ Unhandled Rejection at:", promise);
  console.error("   Reason:", reason);
  // Don't exit - keep the server running
});

// Keep process alive
setInterval(() => {
  // Heartbeat to keep process alive
  if (process.uptime() % 60 === 0) {
    console.log(`💓 Server heartbeat - uptime: ${Math.floor(process.uptime())}s`);
  }
}, 1000);
