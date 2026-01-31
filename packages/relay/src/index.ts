import { WebSocketServer, WebSocket } from "ws";
import http from "http";
import jwt from "jsonwebtoken";

type Role = "broadcaster" | "listener";

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";

interface ClientInfo {
  ws: WebSocket;
  role: Role;
  streamId: number;
  dropRate: number;
  maxKbps: number | null;
  sentBytesWindow: number;
  windowStartMs: number;
  userId?: string;
  email?: string;
}

interface StreamRoom {
  broadcaster: ClientInfo | null;
  listeners: Set<ClientInfo>;
}

const PORT = Number(process.env.PORT ?? process.env.LAF_RELAY_PORT ?? 9000);
console.log(`🚀 Starting WebSocket relay server...`);
console.log(`   PORT: ${PORT}`);
console.log(`   Environment: ${process.env.NODE_ENV || "development"}`);

// Initialize rooms map before HTTP server (needed for health check)
const rooms = new Map<number, StreamRoom>();

// Create HTTP server for health checks (Railway needs this)
const httpServer = http.createServer((req, res) => {
  // CORS headers for API access
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }
  
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  
  if (req.url === "/health" || req.url === "/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ 
      status: "ok", 
      service: "relay",
      uptime: process.uptime(),
      rooms: rooms.size
    }));
  } else if (req.url === "/active-streams") {
    // Return list of streamIds that have active broadcasters
    // CRITICAL: Only return streams where broadcaster WebSocket is OPEN and connected
    const activeStreamIds: number[] = [];
    const now = Date.now();
    
    for (const [streamId, room] of rooms.entries()) {
      if (room.broadcaster) {
        const ws = room.broadcaster.ws;
        // Check if WebSocket is OPEN (readyState === 1)
        // Also verify it's not in the process of closing
        const wsState = ws.readyState;
        if (wsState === 1) { // WebSocket.OPEN = 1
          activeStreamIds.push(streamId);
          // Log periodically to debug connection issues
          if (Math.random() < 0.1) { // Log ~10% of requests to avoid spam
            console.log(`[${streamId}] Broadcaster WebSocket is OPEN and active`);
          }
        } else {
          console.log(`[${streamId}] Broadcaster WebSocket not open (state: ${wsState}, 0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED)`);
          // If WebSocket is CLOSING or CLOSED, it will be cleaned up in the onclose handler
        }
      } else {
        console.log(`[${streamId}] No broadcaster in room (${room.listeners.size} listeners)`);
      }
    }
    
    console.log(`📡 /active-streams: Returning ${activeStreamIds.length} active stream(s): ${activeStreamIds.join(", ")}`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ 
      activeStreamIds,
      count: activeStreamIds.length,
      timestamp: now
    }));
  } else {
    res.writeHead(404);
    res.end("Not found");
  }
});

// Create WebSocket server attached to HTTP server
const wss = new WebSocketServer({ server: httpServer });

// Start HTTP server (which also handles WebSocket upgrades)
httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`🌐 HTTP server listening on http://0.0.0.0:${PORT}`);
  console.log(`🌐 WebSocket relay server listening on ws://0.0.0.0:${PORT}`);
  console.log(`   Health check: http://0.0.0.0:${PORT}/health`);
  console.log(`   ✅ Relay server started successfully!`);
});

function parseUrl(url?: string): {
  role: Role;
  streamId: number;
  dropRate: number;
  maxKbps: number | null;
  userId?: string;
  email?: string;
} {
  const u = new URL(url ?? "/", "ws://dummy");
  const role = (u.searchParams.get("role") as Role) || "listener";
  const streamId = Number(u.searchParams.get("streamId") ?? "1");
  const dropRate = Number(u.searchParams.get("dropRate") ?? "0");
  const maxKbpsParam = u.searchParams.get("maxKbps");
  const maxKbps = maxKbpsParam ? Number(maxKbpsParam) : null;
  const token = u.searchParams.get("token");
  let userId: string | undefined;
  let email: string | undefined;
  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET) as { userId: string; email?: string };
      userId = decoded.userId;
      email = decoded.email ?? undefined;
    } catch {
      // Invalid token - chat will be disabled for this connection
    }
  }
  return {
    role,
    streamId,
    dropRate: Math.min(Math.max(dropRate, 0), 0.5),
    maxKbps,
    userId,
    email
  };
}

function broadcastChatToRoom(room: StreamRoom, streamId: number, payload: { type: "chat"; userId: string; email: string; text: string; timestamp: number }) {
  const msg = JSON.stringify(payload);
  if (room.broadcaster && room.broadcaster.ws.readyState === WebSocket.OPEN) {
    room.broadcaster.ws.send(msg);
  }
  for (const listener of room.listeners) {
    if (listener.ws.readyState === WebSocket.OPEN) {
      listener.ws.send(msg);
    }
  }
}

wss.on("connection", (ws, req) => {
  const { role, streamId, dropRate, maxKbps, userId, email } = parseUrl(req.url);
  let room = rooms.get(streamId);
  if (!room) {
    room = { broadcaster: null, listeners: new Set() };
    rooms.set(streamId, room);
  }

  const client: ClientInfo = {
    ws,
    role,
    streamId,
    dropRate,
    maxKbps,
    sentBytesWindow: 0,
    windowStartMs: Date.now(),
    userId,
    email
  };

  if (role === "broadcaster") {
    if (room.broadcaster) {
      ws.close(1013, "Broadcaster already connected for this streamId");
      return;
    }
    room.broadcaster = client;
    console.log(`[${streamId}] Broadcaster connected`);
  } else {
    room.listeners.add(client);
    console.log(`[${streamId}] Listener connected (${room.listeners.size} total)`);
  }

  ws.on("message", (data, isBinary) => {
    const r = rooms.get(streamId);
    if (!r) return;

    // Text messages: chat (any role) or control (broadcaster only)
    if (!isBinary) {
      const text = data.toString();
      try {
        const parsed = JSON.parse(text) as { type?: string; text?: string };
        if (parsed.type === "chat" && typeof parsed.text === "string") {
          if (!client.userId || !client.email) {
            return; // Must be logged in to send chat
          }
          const trimmed = String(parsed.text).trim().slice(0, 2000);
          if (!trimmed) return;
          broadcastChatToRoom(r, streamId, {
            type: "chat",
            userId: client.userId,
            email: client.email,
            text: trimmed,
            timestamp: Date.now()
          });
          return;
        }
      } catch {
        // Not JSON or not chat - fall through
      }
      // Control messages (e.g. stream_ending): only broadcaster, forward to listeners
      if (client.role === "broadcaster") {
        for (const listener of r.listeners) {
          if (listener.ws.readyState === WebSocket.OPEN) {
            listener.ws.send(text);
          }
        }
      }
      return;
    }

    // Binary messages (audio): only broadcaster forwards to listeners
    if (client.role !== "broadcaster") return;

    // Forward binary messages (audio packets) to all listeners
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as any);
    for (const listener of r.listeners) {
      if (listener.ws.readyState !== WebSocket.OPEN) continue;

      // Simulate packet loss
      if (listener.dropRate > 0 && Math.random() < listener.dropRate) {
        continue;
      }

      // Simulate bandwidth limit via token bucket per 1s window
      const now = Date.now();
      if (now - listener.windowStartMs >= 1000) {
        listener.windowStartMs = now;
        listener.sentBytesWindow = 0;
      }
      if (listener.maxKbps != null) {
        const maxBytesPerSec = (listener.maxKbps * 1000) / 8;
        if (listener.sentBytesWindow + buf.length > maxBytesPerSec) {
          continue;
        }
        listener.sentBytesWindow += buf.length;
      }

      listener.ws.send(buf, { binary: true });
    }
  });

  ws.on("close", () => {
    const r = rooms.get(streamId);
    if (!r) return;
    if (client.role === "broadcaster") {
      console.log(`[${streamId}] Broadcaster disconnected`);
      r.broadcaster = null;
    } else {
      r.listeners.delete(client);
      console.log(`[${streamId}] Listener disconnected (${r.listeners.size} remaining)`);
    }
    if (!r.broadcaster && r.listeners.size === 0) {
      rooms.delete(streamId);
      console.log(`[${streamId}] Room cleaned up`);
    }
  });

  ws.on("error", (err) => {
    console.error(`[${streamId}] WebSocket error:`, err);
  });
});

// Log connection info
const HOST = process.env.RAILWAY_PUBLIC_DOMAIN 
  ? `wss://${process.env.RAILWAY_PUBLIC_DOMAIN}` 
  : `ws://localhost:${PORT}`;

console.log(`📡 Multi-stream relay ready`);
console.log(`   Connect as: ${HOST}/?role=broadcaster&streamId=123`);
console.log(`   Or:        ${HOST}/?role=listener&streamId=123`);

// Handle server errors
httpServer.on("error", (err: any) => {
  console.error("❌ HTTP server error:", err);
  if (err.code === "EADDRINUSE") {
    console.error(`   Port ${PORT} is already in use`);
  }
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("📴 SIGTERM received, shutting down gracefully...");
  httpServer.close(() => {
    console.log("✅ Server closed gracefully");
    process.exit(0);
  });
});

process.on("SIGINT", () => {
  console.log("📴 SIGINT received, shutting down gracefully...");
  httpServer.close(() => {
    console.log("✅ Server closed gracefully");
    process.exit(0);
  });
});
