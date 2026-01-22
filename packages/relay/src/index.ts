import { WebSocketServer, WebSocket } from "ws";

type Role = "broadcaster" | "listener";

interface ClientInfo {
  ws: WebSocket;
  role: Role;
  streamId: number;
  dropRate: number;
  maxKbps: number | null;
  sentBytesWindow: number;
  windowStartMs: number;
}

interface StreamRoom {
  broadcaster: ClientInfo | null;
  listeners: Set<ClientInfo>;
}

const PORT = Number(process.env.LAF_RELAY_PORT ?? 9000);
const wss = new WebSocketServer({ port: PORT });

const rooms = new Map<number, StreamRoom>();

function parseUrl(url?: string): {
  role: Role;
  streamId: number;
  dropRate: number;
  maxKbps: number | null;
} {
  const u = new URL(url ?? "/", "ws://dummy");
  const role = (u.searchParams.get("role") as Role) || "listener";
  const streamId = Number(u.searchParams.get("streamId") ?? "1");
  const dropRate = Number(u.searchParams.get("dropRate") ?? "0");
  const maxKbpsParam = u.searchParams.get("maxKbps");
  const maxKbps = maxKbpsParam ? Number(maxKbpsParam) : null;
  return {
    role,
    streamId,
    dropRate: Math.min(Math.max(dropRate, 0), 0.5),
    maxKbps
  };
}

wss.on("connection", (ws, req) => {
  const { role, streamId, dropRate, maxKbps } = parseUrl(req.url);
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
    windowStartMs: Date.now()
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
    if (!isBinary || client.role !== "broadcaster") return;
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as any);
    const r = rooms.get(streamId);
    if (!r) return;

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

const HOST = process.env.RAILWAY_PUBLIC_DOMAIN 
  ? `wss://${process.env.RAILWAY_PUBLIC_DOMAIN}` 
  : `ws://localhost:${PORT}`;

console.log(`🚀 Multi-stream relay listening on ${HOST}`);
console.log(`   Connect as: ${HOST}/?role=broadcaster&streamId=123`);
console.log(`   Or:        ${HOST}/?role=listener&streamId=123`);
