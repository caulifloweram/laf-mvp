import express from "express";
import cors from "cors";
import { initDb, pool } from "./db";
import { authMiddleware, login, register, changePassword, deleteUser } from "./auth";
import { sendWelcomeEmail, sendPasswordChangedEmail, sendAccountDeletedEmail } from "./email";

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
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "Accept", "Origin", "Cache-Control"],
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
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, Accept, Origin, Cache-Control");
  res.header("Access-Control-Allow-Credentials", "true");
  res.header("Access-Control-Max-Age", "86400"); // 24 hours
  res.sendStatus(204);
});

// Parse JSON bodies
app.use(express.json());

// Log all requests for debugging
app.use((req, res, next) => {
  const startTime = Date.now();
  console.log(`📥 ${req.method} ${req.path} - Origin: ${req.headers.origin || 'none'}`);
  
  // Log response when it finishes
  res.on("finish", () => {
    const duration = Date.now() - startTime;
    console.log(`📤 ${req.method} ${req.path} - Status: ${res.statusCode} (${duration}ms)`);
  });
  
  // Log if response is closed without finishing
  res.on("close", () => {
    if (!res.headersSent) {
      console.log(`⚠️ ${req.method} ${req.path} - Response closed without headers sent`);
    }
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

// Root endpoint for testing
app.get("/", (req, res) => {
  res.json({ 
    message: "LAF MVP API",
    status: "running",
    version: "0.1.0"
  });
});

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
    // Send welcome email (non-blocking)
    sendWelcomeEmail(result.user.email).catch(console.error);
    res.json(result);
  } catch (err: any) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "Email already exists" });
    }
    if (err.message) {
      return res.status(400).json({ error: err.message });
    }
    throw err;
  }
});

// Public: Get live channels
app.get("/api/channels/live", async (_req, res) => {
  try {
    // First, let's check all streams to debug
    const allStreams = await pool.query(`
      SELECT s.id, s.channel_id, s.stream_id, s.started_at, s.ended_at
      FROM streams s
      ORDER BY s.started_at DESC
      LIMIT 10
    `);
    console.log(`Total streams in DB: ${allStreams.rows.length}`);
    console.log("Recent streams:", allStreams.rows.map((r: any) => ({
      channel_id: r.channel_id,
      stream_id: r.stream_id,
      ended_at: r.ended_at
    })));

    // Only get streams that are actually active (ended_at IS NULL)
    // Use DISTINCT ON to ensure we only get the most recent active stream per channel
    const result = await pool.query(`
      SELECT DISTINCT ON (c.id)
        c.id,
        c.title,
        c.description,
        s.stream_id as "streamId",
        s.started_at,
        s.ended_at
      FROM channels c
      INNER JOIN streams s ON s.channel_id = c.id
      WHERE s.ended_at IS NULL
      ORDER BY c.id, s.started_at DESC
    `);
    console.log(`Live channels query returned ${result.rows.length} raw channels`);
    console.log("Raw channels:", result.rows.map((r: any) => ({
      id: r.id,
      title: r.title,
      streamId: r.streamId,
      ended_at: r.ended_at
    })));
    
    // Remove duplicates by channel id (keep the most recent stream per channel)
    const uniqueChannels = new Map();
    result.rows.forEach((row: any) => {
      if (!uniqueChannels.has(row.id)) {
        uniqueChannels.set(row.id, {
          id: row.id,
          title: row.title,
          description: row.description,
          streamId: row.streamId
        });
      }
    });
    const channels = Array.from(uniqueChannels.values());
    console.log(`After deduplication: ${channels.length} unique live channels`);
    console.log("Final channels:", channels);
    res.json(channels);
  } catch (err: any) {
    console.error("Error fetching live channels:", err);
    console.error("Error stack:", err.stack);
    res.status(500).json({ error: "Failed to fetch live channels", details: err.message });
  }
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

  // IMPORTANT: Each "go-live" creates a NEW stream - streams cannot be resumed once stopped
  // If there's an existing active stream, mark it as ended first
  const existingStream = await pool.query(
    "SELECT stream_id FROM streams WHERE channel_id = $1 AND ended_at IS NULL",
    [channelId]
  );
  if (existingStream.rows.length > 0) {
    const oldStreamId = existingStream.rows[0].stream_id;
    console.log(`Ending existing stream ${oldStreamId} for channel ${channelId} before creating new one`);
    await pool.query(
      "UPDATE streams SET ended_at = NOW() WHERE channel_id = $1 AND ended_at IS NULL",
      [channelId]
    );
  }

  // Always create a NEW stream with a unique streamId
  // Use timestamp + random to ensure uniqueness even if called multiple times in the same millisecond
  const streamId = Date.now() + Math.floor(Math.random() * 1000);
  await pool.query(
    "INSERT INTO streams (channel_id, stream_id) VALUES ($1, $2)",
    [channelId, streamId]
  );
  
  console.log(`Created new stream ${streamId} for channel ${channelId}`);

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

  // End ALL active streams for this channel (should only be one, but be thorough)
  const updateResult = await pool.query(
    "UPDATE streams SET ended_at = NOW() WHERE channel_id = $1 AND ended_at IS NULL RETURNING stream_id",
    [channelId]
  );

  if (updateResult.rows.length === 0) {
    console.log(`⚠️ No active stream found for channel ${channelId} - might already be stopped`);
    // Stream might already be stopped, return success anyway
    return res.json({ success: true, message: "Stream already stopped" });
  }

  const stoppedStreamIds = updateResult.rows.map((r: any) => r.stream_id);
  console.log(`✅ Stopped ${updateResult.rows.length} stream(s) for channel ${channelId}: ${stoppedStreamIds.join(", ")}`);
  
  // Verify the streams are actually ended
  const verifyResult = await pool.query(
    "SELECT stream_id, ended_at FROM streams WHERE channel_id = $1 AND stream_id = ANY($2::bigint[])",
    [channelId, stoppedStreamIds]
  );
  console.log(`✅ Verification: ${verifyResult.rows.length} stream(s) verified as ended`);
  
  res.json({ 
    success: true, 
    message: "Stream stopped successfully",
    stoppedStreamIds: stoppedStreamIds
  });
});

// Protected: Change password
app.post("/api/me/change-password", authMiddleware, async (req, res) => {
  const user = (req as any).user;
  const { currentPassword, newPassword } = req.body;
  
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: "Current password and new password required" });
  }
  
  try {
    await changePassword(user.id, currentPassword, newPassword);
    // Get user email for notification
    const userResult = await pool.query("SELECT email FROM users WHERE id = $1", [user.id]);
    if (userResult.rows.length > 0) {
      sendPasswordChangedEmail(userResult.rows[0].email).catch(console.error);
    }
    res.json({ success: true, message: "Password changed successfully" });
  } catch (err: any) {
    return res.status(400).json({ error: err.message || "Failed to change password" });
  }
});

// Protected: Delete account
app.post("/api/me/delete-account", authMiddleware, async (req, res) => {
  const user = (req as any).user;
  const { password } = req.body;
  
  if (!password) {
    return res.status(400).json({ error: "Password required to delete account" });
  }
  
  try {
    // Get user email before deletion
    const userResult = await pool.query("SELECT email FROM users WHERE id = $1", [user.id]);
    const userEmail = userResult.rows[0]?.email;
    
    await deleteUser(user.id, password);
    
    // Send deletion email (non-blocking)
    if (userEmail) {
      sendAccountDeletedEmail(userEmail).catch(console.error);
    }
    
    res.json({ success: true, message: "Account deleted successfully" });
  } catch (err: any) {
    return res.status(400).json({ error: err.message || "Failed to delete account" });
  }
});

// Protected: Get user profile
app.get("/api/me/profile", authMiddleware, async (req, res) => {
  const user = (req as any).user;
  const result = await pool.query(
    "SELECT id, email, created_at FROM users WHERE id = $1",
    [user.id]
  );
  if (result.rows.length === 0) {
    return res.status(404).json({ error: "User not found" });
  }
  res.json(result.rows[0]);
});

// Start server with error handling
console.log(`🚀 Starting API server...`);
console.log(`   PORT: ${PORT}`);
console.log(`   DATABASE_URL: ${process.env.DATABASE_URL ? "✅ Set" : "❌ Not set"}`);
console.log(`   NODE_ENV: ${process.env.NODE_ENV || "not set"}`);
console.log(`   RAILWAY_ENVIRONMENT: ${process.env.RAILWAY_ENVIRONMENT || "not set"}`);

try {
  // Listen on all interfaces - Railway needs this
  const server = app.listen(PORT, "0.0.0.0", () => {
    const address = server.address();
    console.log(`🌐 API server listening on http://0.0.0.0:${PORT}`);
    console.log(`   Server address: ${JSON.stringify(address)}`);
    console.log(`   Health check: http://0.0.0.0:${PORT}/health`);
    console.log(`   Database: ${process.env.DATABASE_URL ? "✅ Configured" : "⚠️ Not configured"}`);
    console.log(`   CORS: ✅ Enabled (allowing all origins)`);
    console.log(`   Environment: ${process.env.NODE_ENV || "development"}`);
    console.log(`   ✅ Server started successfully!`);
    console.log(`   Process PID: ${process.pid}`);
    
    // Test that server is actually listening
    if (address && typeof address === 'object') {
      console.log(`   ✅ Server bound to ${address.address}:${address.port}`);
    }
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
