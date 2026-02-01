import express from "express";
import cors from "cors";
import { Readable } from "stream";
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

// Parse JSON bodies (higher limit for cover image base64 uploads)
app.use(express.json({ limit: "10mb" }));

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
// Get HTTP URL for relay (for checking active streams)
const RELAY_HTTP_URL = process.env.RELAY_HTTP_URL || process.env.RELAY_WS_URL?.replace("ws://", "http://").replace("wss://", "https://") || "http://localhost:9000";

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

// Shared: check if a stream URL is reachable (returns quickly; does not read full body)
async function checkStreamUrl(url: string): Promise<{ ok: boolean; status: string }> {
  if (!url || (!url.startsWith("http://") && !url.startsWith("https://"))) {
    return { ok: false, status: "invalid_url" };
  }
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 3000);
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: { "Icy-MetaData": "1" },
    });
    clearTimeout(t);
    const ok = response.ok || response.status === 200 || response.status === 206;
    return { ok: !!ok, status: ok ? "live" : "unavailable" };
  } catch (err: unknown) {
    const status = err instanceof Error && err.name === "AbortError" ? "timeout" : "error";
    return { ok: false, status };
  }
}

const RESOLVE_FETCH_TIMEOUT_MS = 8000;
const RESOLVE_USER_AGENT = "LAF/1.0 (Radio station resolver)";

interface ResolvedStation {
  streamUrl: string;
  name: string;
  description: string;
  websiteUrl: string;
  logoUrl: string | null;
}

/** Resolve a website or stream URL to a playable station with metadata. */
async function resolveStationUrl(inputUrl: string): Promise<ResolvedStation> {
  const trimmed = (inputUrl || "").trim();
  if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
    throw new Error("URL must be http or https");
  }
  const baseUrl = trimmed.replace(/#.*$/, "").replace(/\/?$/, "/");

  // 1) If input is already a stream, use it and try to get metadata from same-origin or Radio Browser
  const looksLikeStream = /\.(m3u8?|pls|mp3|aac|ogg)(\?|$)/i.test(trimmed) || /\/stream|\/listen|\/live(\/|$)/i.test(trimmed);
  if (looksLikeStream) {
    const { ok } = await checkStreamUrl(trimmed);
    if (ok) {
      const origin = new URL(trimmed).origin;
      const meta = await fetchHtmlMetadata(origin + "/");
      return {
        streamUrl: trimmed,
        name: meta.name || new URL(trimmed).hostname.replace(/^www\./, ""),
        description: meta.description || "",
        websiteUrl: meta.websiteUrl || origin,
        logoUrl: meta.logoUrl || null,
      };
    }
  }

  // 2) Try Radio Browser API: byurl (homepage), search by hostname, then by page title (after fetching HTML)
  const rbBase = "https://de1.api.radio-browser.info";
  const hostnamePart = new URL(baseUrl).hostname.replace(/^www\./, "").split(".")[0] || "";
  const rbEndpoints: string[] = [
    `/json/stations/byurl/${encodeURIComponent(baseUrl.replace(/\/$/, ""))}`,
    `/json/stations/search?name=${encodeURIComponent(hostnamePart)}&limit=5`,
  ];

  // Fetch HTML early so we can try Radio Browser by page title and add same-origin path candidates
  let htmlMeta: HtmlMetadata;
  try {
    htmlMeta = await fetchHtmlMetadata(baseUrl);
  } catch (e) {
    htmlMeta = { name: "", description: "", websiteUrl: baseUrl, logoUrl: null, streamUrls: [] };
  }
  const pageTitle = (htmlMeta.name || "").trim() || hostnamePart;
  if (pageTitle && pageTitle.length > 2) {
    rbEndpoints.push(`/json/stations/search?name=${encodeURIComponent(pageTitle)}&limit=5`);
  }

  for (const endpoint of rbEndpoints) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 5000);
      const rbRes = await fetch(rbBase + endpoint, {
        signal: controller.signal,
        headers: { "User-Agent": RESOLVE_USER_AGENT },
      });
      clearTimeout(t);
      if (!rbRes.ok) continue;
      const stations = (await rbRes.json()) as Array<{ url_resolved?: string; url?: string; name?: string; tags?: string; favicon?: string; homepage?: string }>;
      for (const s of stations) {
        const streamUrl = (s.url_resolved || s.url || "").trim();
        if (!streamUrl) continue;
        const { ok } = await checkStreamUrl(streamUrl);
        if (ok) {
          return {
            streamUrl,
            name: (s.name || "").trim() || "Radio station",
            description: (s.tags || "").trim() || "",
            websiteUrl: (s.homepage || baseUrl).trim(),
            logoUrl: (s.favicon || "").trim() || null,
          };
        }
      }
    } catch (_) {
      // try next endpoint or HTML candidates
    }
  }

  // 3) Use stream URLs from HTML scrape, then try same-origin common paths, then URLs found in script tags
  let streamCandidates = htmlMeta.streamUrls.length > 0 ? [...htmlMeta.streamUrls] : [];
  const origin = new URL(baseUrl).origin;

  if (streamCandidates.length === 0) {
    const commonPaths = ["/stream", "/live", "/listen", "/radio", "/stream.mp3", "/live.mp3", "/listen.mp3", "/icecast", "/stream.m3u", "/live.m3u"];
    for (const path of commonPaths) {
      streamCandidates.push(origin + path);
    }
  }

  // Also scrape script/JSON in page for stream-like URLs (e.g. "http://host:port/" or ".mp3")
  if (htmlMeta.rawHtml) {
    const scriptUrlRe = /https?:\/\/[^\s"']+(?::\d+)?(?:\/[^\s"']*)?\.?(?:mp3|m3u8?|aac|ogg|pls)?/gi;
    let m: RegExpExecArray | null;
    scriptUrlRe.lastIndex = 0;
    while ((m = scriptUrlRe.exec(htmlMeta.rawHtml)) !== null) {
      const raw = m[0].replace(/[,;)\]\s]+$/, "");
      if (/\.(m3u8?|pls|mp3|aac|ogg)(\?|$)/i.test(raw) || /:\d+\//.test(raw)) {
        try {
          const u = new URL(raw);
          if (u.protocol === "http:" || u.protocol === "https:") streamCandidates.push(u.href);
        } catch (_) {}
      }
    }
  }

  const seen = new Set<string>();
  streamCandidates = streamCandidates.filter((u) => {
    try {
      const normalized = new URL(u).href;
      if (seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    } catch (_) {
      return false;
    }
  });

  if (streamCandidates.length === 0) {
    throw new Error("No stream URL found on this page. Paste a direct stream URL (e.g. .mp3, .m3u) or a radio homepage that embeds a player.");
  }
  let workingStreamUrl: string | null = null;
  for (const candidate of streamCandidates) {
    const { ok } = await checkStreamUrl(candidate);
    if (ok) {
      workingStreamUrl = candidate;
      break;
    }
  }
  if (!workingStreamUrl) {
    throw new Error("Found stream links on the page but none are reachable or live. Try a direct stream URL.");
  }
  return {
    streamUrl: workingStreamUrl,
    name: htmlMeta.name || new URL(baseUrl).hostname.replace(/^www\./, ""),
    description: htmlMeta.description || "",
    websiteUrl: baseUrl.replace(/\/$/, ""),
    logoUrl: htmlMeta.logoUrl || null,
  };
}

interface HtmlMetadata {
  name: string;
  description: string;
  websiteUrl: string;
  logoUrl: string | null;
  streamUrls: string[];
  rawHtml?: string;
}

async function fetchHtmlMetadata(pageUrl: string): Promise<HtmlMetadata> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), RESOLVE_FETCH_TIMEOUT_MS);
  const res = await fetch(pageUrl, {
    signal: controller.signal,
    headers: { "User-Agent": RESOLVE_USER_AGENT },
    redirect: "follow",
  });
  clearTimeout(t);
  if (!res.ok) throw new Error(`Page returned ${res.status}`);
  const contentType = (res.headers.get("content-type") || "").toLowerCase();
  if (!contentType.includes("text/html")) throw new Error("URL is not an HTML page");
  const html = await res.text();
  const base = new URL(pageUrl);

  const meta: HtmlMetadata = {
    name: "",
    description: "",
    websiteUrl: pageUrl.replace(/\/$/, ""),
    logoUrl: null,
    streamUrls: [],
  };

  // og:title, og:description, og:image
  const ogTitle = html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']*)["']/i) || html.match(/<meta[^>]*content=["']([^"']*)["'][^>]*property=["']og:title["']/i);
  if (ogTitle) meta.name = ogTitle[1].trim().replace(/&amp;/g, "&").replace(/&quot;/g, '"');
  const ogDesc = html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']*)["']/i) || html.match(/<meta[^>]*content=["']([^"']*)["'][^>]*property=["']og:description["']/i);
  if (ogDesc) meta.description = (ogDesc[1].trim().replace(/&amp;/g, "&") || "").slice(0, 500);
  const ogImage = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']*)["']/i) || html.match(/<meta[^>]*content=["']([^"']*)["'][^>]*property=["']og:image["']/i);
  if (ogImage) meta.logoUrl = new URL(ogImage[1].trim(), base).href;
  if (!meta.name) {
    const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    if (titleMatch) meta.name = titleMatch[1].trim().replace(/&amp;/g, "&").slice(0, 200);
  }

  // Stream URLs: audio src, source src, and hrefs to .m3u, .pls, .mp3, .aac, /stream, /listen, /live
  const streamPatterns = [
    /<audio[^>]+src=["']([^"']+)["']/gi,
    /<source[^>]+src=["']([^"']+)["']/gi,
    /(?:href|src)=["']([^"']*\.(?:m3u8?|pls|mp3|aac|ogg)(?:\?[^"']*)?)["']/gi,
    /(?:href|src)=["']([^"']*(?:\/stream|\/listen|\/live)[^"']*)["']/gi,
  ];
  const seen = new Set<string>();
  for (const re of streamPatterns) {
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(html)) !== null) {
      const raw = m[1].trim();
      if (!raw || raw.startsWith("data:") || raw.startsWith("blob:")) continue;
      try {
        const absolute = new URL(raw, base).href;
        if (absolute.startsWith("http://") || absolute.startsWith("https://")) seen.add(absolute);
      } catch (_) {}
    }
  }
  meta.streamUrls = [...seen];
  meta.rawHtml = html;
  return meta;
}

app.get("/api/stream-check", async (req, res) => {
  const url = typeof req.query.url === "string" ? req.query.url.trim() : "";
  const result = await checkStreamUrl(url);
  res.json(result);
});

// Stream proxy: pipe radio stream through API so client avoids CORS when loading Audio()
app.get("/api/stream-proxy", async (req, res) => {
  const url = typeof req.query.url === "string" ? req.query.url.trim() : "";
  if (!url || (!url.startsWith("http://") && !url.startsWith("https://"))) {
    return res.status(400).send("Invalid url");
  }
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 30000);
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: { "Icy-MetaData": "1" },
    });
    clearTimeout(t);
    const ct = response.headers.get("content-type");
    if (ct) res.setHeader("Content-Type", ct);
    res.setHeader("Cache-Control", "no-store");
    if (response.body) {
      Readable.fromWeb(response.body).pipe(res);
    } else {
      res.status(502).send("No body");
    }
  } catch (err) {
    if (!res.headersSent) res.status(502).send("Stream unavailable");
  }
});

// Proxy for ICY stream metadata (CORS blocks client from reading stream headers directly)
app.get("/api/stream-metadata", async (req, res) => {
  const url = typeof req.query.url === "string" ? req.query.url.trim() : "";
  if (!url || (!url.startsWith("http://") && !url.startsWith("https://"))) {
    return res.status(400).json({ error: "Invalid url" });
  }
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 6000);
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: { "Icy-MetaData": "1" },
    });
    clearTimeout(t);
    const name = response.headers.get("icy-name")?.trim() ?? null;
    const description = response.headers.get("icy-description")?.trim() ?? null;
    res.json({ name, description });
  } catch {
    res.json({ name: null, description: null });
  }
});

// Scrape station website for "now playing" / program title (often in live player or Next Up section)
app.get("/api/station-now-playing", async (req, res) => {
  const url = typeof req.query.url === "string" ? req.query.url.trim() : "";
  if (!url || (!url.startsWith("http://") && !url.startsWith("https://"))) {
    return res.status(400).json({ error: "Invalid url" });
  }
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 8000);
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; LAF/1.0; +https://github.com/caulifloweram/laf-mvp)",
        "Accept": "text/html,application/xhtml+xml",
      },
    });
    clearTimeout(t);
    if (!response.ok) return res.json({ text: null });
    const html = await response.text();
    let text: string | null = null;

    const decode = (raw: string) => raw.replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10))).trim();
    const isValid = (s: string) => s.length > 4 && s.length < 200 && !/^(loading|refuge|mutant|radio|80000|home|listen|play)$/i.test(s);

    // 1. Live player title: data attributes (common in React/JS players)
    if (!text) {
      const dataMatch = html.match(/data-(?:now[-_]?playing|track[-_]?name|current[-_]?show|title|show[-_]?name)=["']([^"']{5,180})["']/i)
        || html.match(/data-title=["']([^"']{5,180})["']/i);
      if (dataMatch?.[1]) {
        const raw = decode(dataMatch[1]);
        if (isValid(raw)) text = raw;
      }
    }

    // 2. Live player: class names often used for "now playing" title (capture following text)
    if (!text) {
      const playerTitleBlock = html.match(/class="[^"]*(?:now[-_]?playing|current[-_]?track|player[-_]?title|live[-_]?title|show[-_]?title|track[-_]?title|np[-_]?title|stream[-_]?title)[^"]*"[^>]*>[\s\S]{0,200}?([^<]{5,150})</i)
        || html.match(/id="(?:now[-_]?playing|current[-_]?track|player[-_]?title)[^"]*"[^>]*>[\s\S]{0,200}?([^<]{5,150})</i);
      if (playerTitleBlock?.[1]) {
        const raw = decode(playerTitleBlock[1]);
        if (isValid(raw)) text = raw;
      }
    }

    // 3. og:title (often page or current show)
    if (!text) {
      const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
        || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
      if (ogTitle?.[1]) {
        const decoded = decode(ogTitle[1]);
        if (isValid(decoded)) text = decoded;
      }
    }

    // 4. "Next Up" / "Now Playing" / "Live" section: heading or title-like content after label
    if (!text) {
      const section = html.match(/(?:next\s*up|now\s*playing|live\s*now|currently\s*playing|on\s*air)[\s\S]{0,1200}/i);
      if (section) {
        const chunk = section[0];
        const inTag = chunk.match(/<h[1-6][^>]*>([^<]+)</i)
          || chunk.match(/<[a-z]+[^>]*class="[^"]*title[^"]*"[^>]*>([^<]+)</i)
          || chunk.match(/<[a-z]+[^>]*class="[^"]*(?:show|program|track)[^"]*"[^>]*>([^<]{8,120})</i)
          || chunk.match(/<a[^>]+href="[^"]*\/radio\/[^"]*"[^>]*>([^<]+)</i)
          || chunk.match(/>(Ecology of Listening|Residency|The Breakfast Show|[A-Za-z0-9\s|&'\-–—]{10,100})</);
        if (inTag?.[1]) {
          const raw = decode(inTag[1]);
          if (isValid(raw)) text = raw;
        }
      }
    }

    // 5. First link to /radio/... (show slug) - use link text as show name
    if (!text) {
      const radioLink = html.match(/<a[^>]+href="[^"]*\/radio\/([^"?#]+)"[^>]*>([^<]{5,120})</i);
      if (radioLink?.[2]) {
        const raw = decode(radioLink[2]);
        if (raw.length > 3 && !/^\d|^loading$/i.test(raw)) text = raw;
      }
    }

    // 6. JSON-LD or script blob: "name" / "title" near "BroadcastEvent" or "RadioBroadcast"
    if (!text) {
      const jsonLd = html.match(/(?:BroadcastEvent|RadioBroadcast|RadioStation)[\s\S]{0,500}?"(?:name|title)"\s*:\s*"([^"]{8,150})"/i);
      if (jsonLd?.[1]) {
        const raw = decode(jsonLd[1]);
        if (isValid(raw)) text = raw;
      }
    }

    res.json({ text: text || null });
  } catch {
    res.json({ text: null });
  }
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

// Public: Get all external stations (user-submitted; client merges with built-in list)
app.get("/api/external-stations", async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, name, description, website_url as "websiteUrl", stream_url as "streamUrl", logo_url as "logoUrl", created_at as "createdAt"
      FROM external_stations
      ORDER BY name ASC
    `);
    res.json(result.rows);
  } catch (err: any) {
    console.error("Error fetching external stations:", err);
    res.status(500).json({ error: "Failed to fetch external stations", details: err.message });
  }
});

// Allowed admin emails for adding external stations (comma-separated in LAF_ADMIN_EMAILS env)
const ADMIN_EMAILS = process.env.LAF_ADMIN_EMAILS
  ? process.env.LAF_ADMIN_EMAILS.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean)
  : ["ale@forma.city"];

// Protected: Submit a radio station URL to be listed (for broadcasters who already have a stream elsewhere)
app.post("/api/external-stations", authMiddleware, async (req, res) => {
  const user = (req as any).user;
  const email = (user?.email ?? "").toString().toLowerCase();
  if (!ADMIN_EMAILS.includes(email)) {
    return res.status(403).json({ error: "Only authorized admins can add stations" });
  }
  const { url: singleUrl, name, description, websiteUrl, streamUrl, logoUrl } = req.body;

  let stationName: string;
  let desc: string;
  let website: string;
  let url: string;
  let logo: string | null;

  if (singleUrl && typeof singleUrl === "string" && singleUrl.trim()) {
    // Resolve website or stream URL: scrape page / Radio Browser, find live stream, then insert
    try {
      const resolved = await resolveStationUrl(singleUrl.trim());
      stationName = resolved.name || "Radio station";
      desc = resolved.description || "";
      website = resolved.websiteUrl || singleUrl.trim();
      url = resolved.streamUrl;
      logo = resolved.logoUrl;
    } catch (err: any) {
      return res.status(400).json({
        error: err?.message || "Could not resolve a live stream from this URL",
      });
    }
  } else {
    // Manual form: streamUrl required
    if (!streamUrl || typeof streamUrl !== "string" || !streamUrl.trim()) {
      return res.status(400).json({ error: "Stream URL or website URL is required" });
    }
    url = streamUrl.trim();
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      return res.status(400).json({ error: "Stream URL must be http or https" });
    }
    const { ok, status } = await checkStreamUrl(url);
    if (!ok) {
      return res.status(400).json({
        error: "Stream is not reachable or not live. Station was not added.",
        status: status === "timeout" ? "timeout" : status === "error" ? "error" : "unavailable",
      });
    }
    website = (websiteUrl && typeof websiteUrl === "string" ? websiteUrl.trim() : url) || url;
    stationName = (name && typeof name === "string" ? name.trim() : null) || "User station";
    desc = (description && typeof description === "string" ? description.trim() : null) || "";
    logo = (logoUrl && typeof logoUrl === "string" ? logoUrl.trim() : null) || null;
  }

  try {
    const result = await pool.query(
      `INSERT INTO external_stations (name, description, website_url, stream_url, logo_url, submitted_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, name, description, website_url as "websiteUrl", stream_url as "streamUrl", logo_url as "logoUrl", created_at as "createdAt"`,
      [stationName, desc || null, website, url, logo, user.id]
    );
    res.status(201).json(result.rows[0]);
  } catch (err: any) {
    console.error("Error creating external station:", err);
    res.status(500).json({ error: "Failed to add station", details: err.message });
  }
});

// Protected: Update an external station (admin only; name, description, websiteUrl, logoUrl)
app.patch("/api/external-stations/:id", authMiddleware, async (req, res) => {
  const user = (req as any).user;
  const email = (user?.email ?? "").toString().toLowerCase();
  if (!ADMIN_EMAILS.includes(email)) {
    return res.status(403).json({ error: "Only authorized admins can edit stations" });
  }
  const id = req.params.id;
  if (!id) return res.status(400).json({ error: "Station id is required" });
  const { name, description, websiteUrl, logoUrl } = req.body;
  const updates: string[] = [];
  const values: unknown[] = [];
  let pos = 1;
  if (name !== undefined && typeof name === "string") {
    updates.push(`name = $${pos++}`);
    values.push(name.trim() || "Station");
  }
  if (description !== undefined) {
    updates.push(`description = $${pos++}`);
    values.push(typeof description === "string" ? description.trim() || null : null);
  }
  if (websiteUrl !== undefined && typeof websiteUrl === "string" && websiteUrl.trim()) {
    updates.push(`website_url = $${pos++}`);
    values.push(websiteUrl.trim());
  }
  if (logoUrl !== undefined) {
    updates.push(`logo_url = $${pos++}`);
    values.push(typeof logoUrl === "string" && logoUrl.trim() ? logoUrl.trim() : null);
  }
  if (updates.length === 0) {
    return res.status(400).json({ error: "No fields to update" });
  }
  values.push(id);
  try {
    const result = await pool.query(
      `UPDATE external_stations SET ${updates.join(", ")} WHERE id = $${pos} RETURNING id, name, description, website_url as "websiteUrl", stream_url as "streamUrl", logo_url as "logoUrl"`,
      values
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Station not found" });
    }
    res.json(result.rows[0]);
  } catch (err: any) {
    console.error("Error updating external station:", err);
    res.status(500).json({ error: "Failed to update station", details: err.message });
  }
});

// Protected: Delete an external station (submitter can delete; admins can delete any)
app.delete("/api/external-stations/:id", authMiddleware, async (req, res) => {
  const user = (req as any).user;
  const email = (user?.email ?? "").toString().toLowerCase();
  const isAdmin = ADMIN_EMAILS.includes(email);
  const id = req.params.id;
  if (!id) return res.status(400).json({ error: "Station id is required" });
  try {
    const result = isAdmin
      ? await pool.query(`DELETE FROM external_stations WHERE id = $1 RETURNING id`, [id])
      : await pool.query(
          `DELETE FROM external_stations WHERE id = $1 AND submitted_by = $2 RETURNING id`,
          [id, user.id]
        );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Station not found or you are not the submitter" });
    }
    res.status(204).send();
  } catch (err: any) {
    console.error("Error deleting external station:", err);
    res.status(500).json({ error: "Failed to delete station", details: err.message });
  }
});

// Protected: Favorites (requires login)
app.get("/api/me/favorites", authMiddleware, async (req, res) => {
  const user = (req as any).user;
  try {
    const result = await pool.query(
      `SELECT kind, ref FROM user_favorites WHERE user_id = $1 ORDER BY created_at ASC`,
      [user.id]
    );
    res.json(result.rows.map((r: any) => ({ kind: r.kind, ref: r.ref })));
  } catch (err: any) {
    console.error("Error fetching favorites:", err);
    res.status(500).json({ error: "Failed to fetch favorites", details: err.message });
  }
});

app.post("/api/me/favorites", authMiddleware, async (req, res) => {
  const user = (req as any).user;
  const { kind, ref } = req.body;
  if (!kind || !ref || typeof kind !== "string" || typeof ref !== "string") {
    return res.status(400).json({ error: "kind and ref are required" });
  }
  if (kind !== "laf" && kind !== "external") {
    return res.status(400).json({ error: "kind must be 'laf' or 'external'" });
  }
  const refTrim = ref.trim();
  if (!refTrim) return res.status(400).json({ error: "ref cannot be empty" });
  try {
    await pool.query(
      `INSERT INTO user_favorites (user_id, kind, ref) VALUES ($1, $2, $3) ON CONFLICT (user_id, kind, ref) DO NOTHING`,
      [user.id, kind, refTrim]
    );
    res.status(201).json({ kind, ref: refTrim });
  } catch (err: any) {
    console.error("Error adding favorite:", err);
    res.status(500).json({ error: "Failed to add favorite", details: err.message });
  }
});

app.delete("/api/me/favorites", authMiddleware, async (req, res) => {
  const user = (req as any).user;
  const kind = typeof req.query.kind === "string" ? req.query.kind : null;
  const ref = typeof req.query.ref === "string" ? req.query.ref : null;
  if (!kind || !ref) {
    return res.status(400).json({ error: "kind and ref query params are required" });
  }
  if (kind !== "laf" && kind !== "external") {
    return res.status(400).json({ error: "kind must be 'laf' or 'external'" });
  }
  try {
    await pool.query(
      `DELETE FROM user_favorites WHERE user_id = $1 AND kind = $2 AND ref = $3`,
      [user.id, kind, ref]
    );
    res.status(204).send();
  } catch (err: any) {
    console.error("Error removing favorite:", err);
    res.status(500).json({ error: "Failed to remove favorite", details: err.message });
  }
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

    // CRITICAL: Check relay for actually active streams (has broadcaster connected)
    // This is the source of truth - database might be stale
    let activeStreamIdsFromRelay: number[] | null = null; // null = relay check failed, use DB fallback
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);
      
      const relayResponse = await fetch(`${RELAY_HTTP_URL}/active-streams`, {
        signal: controller.signal
      } as any);
      
      clearTimeout(timeoutId);
      
      if (relayResponse.ok) {
        const relayData = await relayResponse.json() as { activeStreamIds?: number[]; count?: number };
        activeStreamIdsFromRelay = Array.isArray(relayData.activeStreamIds) ? relayData.activeStreamIds : [];
        console.log(`📡 Relay reports ${activeStreamIdsFromRelay.length} active stream(s): ${activeStreamIdsFromRelay.join(", ")}`);
        console.log(`📡 Relay activeStreamIds type check:`, activeStreamIdsFromRelay.map(id => ({ id, type: typeof id })));
      } else {
        console.warn(`⚠️ Failed to check relay for active streams: HTTP ${relayResponse.status} - falling back to database`);
        activeStreamIdsFromRelay = null; // Use DB fallback
      }
    } catch (err: any) {
      if (err.name === 'AbortError') {
        console.warn(`⚠️ Relay check timed out after 2s - falling back to database`);
      } else {
        console.warn(`⚠️ Could not check relay for active streams: ${err.message} - falling back to database`);
      }
      activeStreamIdsFromRelay = null; // Use DB fallback
    }

    // Only get streams that are actually active (ended_at IS NULL)
    // Use DISTINCT ON to ensure we only get the most recent active stream per channel
    const result = await pool.query(`
      SELECT DISTINCT ON (c.id)
        c.id,
        c.title,
        c.description,
        c.cover_url as "coverUrl",
        s.stream_id as "streamId",
        s.started_at,
        s.ended_at
      FROM channels c
      INNER JOIN streams s ON s.channel_id = c.id
      WHERE s.ended_at IS NULL
        AND s.stream_id IS NOT NULL
      ORDER BY c.id, s.started_at DESC
    `);
    
    console.log(`📊 Database query returned ${result.rows.length} potential live channels`);
    
    // CRITICAL: Filter to only include streams that have active broadcasters on relay
    // This ensures we only show streams that are actually broadcasting
    // If relay check failed (null), fall back to database (show all active streams from DB)
    // If relay check succeeded but returned empty array, show recently created streams (grace period for connection timing)
    const filteredChannels = result.rows.filter((row: any) => {
      if (activeStreamIdsFromRelay === null) {
        // Relay check failed - fall back to database (show all active streams)
        console.log(`   ⚠️ Relay check failed, using DB fallback for channel ${row.id} (streamId=${row.streamId})`);
        return true; // Include all streams from DB when relay check fails
      } else if (activeStreamIdsFromRelay.length === 0) {
        // Relay check succeeded but returned empty array - this could mean:
        // 1. No streams are active (correct - filter them out)
        // 2. Broadcaster just connected but relay hasn't updated yet (timing issue)
        // Solution: Show streams created in the last 30 seconds as a grace period
        const streamAge = row.started_at ? (Date.now() - new Date(row.started_at).getTime()) : Infinity;
        const GRACE_PERIOD_MS = 30000; // 30 seconds grace period for connection timing
        if (streamAge < GRACE_PERIOD_MS) {
          console.log(`   ⏳ Relay returned empty, but stream ${row.streamId} is recent (${Math.round(streamAge/1000)}s old) - showing as grace period`);
          return true; // Include recent streams during grace period
        } else {
          console.log(`   ❌ Filtering out channel ${row.id} (streamId=${row.streamId}) - not active on relay and too old (${Math.round(streamAge/1000)}s)`);
          return false; // Filter out old streams that aren't on relay
        }
      } else {
        // Relay check succeeded and returned active streams
        // CRITICAL: Ensure type matching for streamId comparison (database might return bigint/string)
        const streamIdNum = typeof row.streamId === 'string' ? parseInt(row.streamId, 10) : Number(row.streamId);
        const isActiveOnRelay = activeStreamIdsFromRelay.includes(streamIdNum);
        
        console.log(`   🔍 Checking stream ${row.streamId} (as number: ${streamIdNum}, type: ${typeof row.streamId}): active=${isActiveOnRelay}, relay has: [${activeStreamIdsFromRelay.join(", ")}]`);
        
        if (isActiveOnRelay) {
          console.log(`   ✅ Stream ${row.streamId} is active on relay - showing`);
          return true; // Always show streams that are active on relay
        }
        
        // Stream not in relay's active list - check if it's very recent (grace period for timing)
        const streamAge = row.started_at ? (Date.now() - new Date(row.started_at).getTime()) : Infinity;
        const GRACE_PERIOD_MS = 30000; // 30 seconds grace period
        if (streamAge < GRACE_PERIOD_MS) {
          console.log(`   ⏳ Stream ${row.streamId} not on relay yet but recent (${Math.round(streamAge/1000)}s old) - showing as grace period`);
          return true; // Include recent streams during grace period
        } else {
          console.log(`   ❌ Filtering out channel ${row.id} (streamId=${row.streamId}) - not active on relay and too old (${Math.round(streamAge/1000)}s)`);
          return false; // Filter out old streams that aren't on relay
        }
      }
    });
    
    console.log(`✅ After relay filter: ${filteredChannels.length} actually live channels`);
    
    // Remove duplicates by channel id (keep the most recent stream per channel)
    const uniqueChannels = new Map();
    filteredChannels.forEach((row: any) => {
      if (!uniqueChannels.has(row.id)) {
        uniqueChannels.set(row.id, {
          id: row.id,
          title: row.title,
          description: row.description,
          coverUrl: row.coverUrl ?? null,
          streamId: row.streamId
        });
      }
    });
    const channels = Array.from(uniqueChannels.values());
    console.log(`📺 Final result: ${channels.length} unique live channels`);
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
    "SELECT id, title, description, cover_url, created_at FROM channels WHERE owner_id = $1 ORDER BY created_at DESC",
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
    "INSERT INTO channels (owner_id, title, description) VALUES ($1, $2, $3) RETURNING id, title, description, cover_url, created_at",
    [user.id, title, description || null]
  );
  res.json(result.rows[0]);
});

// Protected: Update channel (title, description, cover)
app.patch("/api/me/channels/:channelId", authMiddleware, async (req, res) => {
  const user = (req as any).user;
  const { channelId } = req.params;
  const { title, description, cover_url, cover_base64 } = req.body;

  const channelResult = await pool.query(
    "SELECT id FROM channels WHERE id = $1 AND owner_id = $2",
    [channelId, user.id]
  );
  if (channelResult.rows.length === 0) {
    return res.status(404).json({ error: "Channel not found" });
  }

  const updates: string[] = [];
  const values: any[] = [];
  let idx = 1;
  if (title !== undefined) {
    if (typeof title !== "string" || !title.trim()) {
      return res.status(400).json({ error: "Title cannot be empty" });
    }
    updates.push(`title = $${idx++}`);
    values.push(title.trim());
  }
  if (description !== undefined) {
    updates.push(`description = $${idx++}`);
    values.push(description === "" || description == null ? null : String(description).trim());
  }
  const coverValue = cover_base64 != null ? cover_base64 : cover_url;
  if (coverValue !== undefined) {
    updates.push(`cover_url = $${idx++}`);
    values.push(coverValue === "" ? null : String(coverValue));
  }
  if (updates.length === 0) {
    return res.status(400).json({ error: "No fields to update" });
  }
  updates.push("updated_at = NOW()");
  values.push(channelId, user.id);

  const result = await pool.query(
    `UPDATE channels SET ${updates.join(", ")} WHERE id = $${idx} AND owner_id = $${idx + 1} RETURNING id, title, description, cover_url, created_at`,
    values
  );
  res.json(result.rows[0]);
});

// Protected: Delete channel
app.delete("/api/me/channels/:channelId", authMiddleware, async (req, res) => {
  const user = (req as any).user;
  const { channelId } = req.params;

  const result = await pool.query(
    "DELETE FROM channels WHERE id = $1 AND owner_id = $2 RETURNING id",
    [channelId, user.id]
  );
  if (result.rowCount === 0) {
    return res.status(404).json({ error: "Channel not found" });
  }
  res.json({ success: true, deleted: channelId });
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
  // Use explicit timestamp to ensure it's set correctly
  const updateResult = await pool.query(
    "UPDATE streams SET ended_at = NOW() WHERE channel_id = $1 AND ended_at IS NULL RETURNING stream_id, started_at",
    [channelId]
  );

  if (updateResult.rows.length === 0) {
    console.log(`⚠️ No active stream found for channel ${channelId} - might already be finished`);
    // Stream might already be finished, return success anyway
    return res.json({ success: true, message: "Stream already finished", stoppedStreamIds: [] });
  }

  const stoppedStreamIds = updateResult.rows.map((r: any) => r.stream_id);
  console.log(`✅ Finished ${updateResult.rows.length} stream(s) for channel ${channelId}: ${stoppedStreamIds.join(", ")}`);
  
  // CRITICAL: Verify the streams are actually ended with a fresh query
  const verifyResult = await pool.query(
    "SELECT stream_id, ended_at, started_at FROM streams WHERE channel_id = $1 AND stream_id = ANY($2::bigint[])",
    [channelId, stoppedStreamIds]
  );
  
  const allEnded = verifyResult.rows.every((r: any) => r.ended_at !== null);
  if (!allEnded) {
    console.error(`❌ ERROR: Some streams were not properly ended!`);
    verifyResult.rows.forEach((r: any) => {
      console.error(`   Stream ${r.stream_id}: ended_at=${r.ended_at}`);
    });
  } else {
    console.log(`✅ Verification: All ${verifyResult.rows.length} stream(s) verified as finished`);
  }
  
  // Force a small delay to ensure database transaction is committed
  // This ensures subsequent queries will see the updated state
  await new Promise(resolve => setTimeout(resolve, 100));
  
  res.json({ 
    success: true, 
    message: "Stream finished successfully",
    stoppedStreamIds: stoppedStreamIds,
    verified: allEnded
  });
});

// Admin: Clean up stale streams
// This is useful for fixing database state if streams weren't properly stopped
app.post("/api/admin/cleanup-streams", async (req, res) => {
  try {
    // Check for admin token in header (simple security - in production use proper auth)
    const adminToken = req.headers["x-admin-token"];
    if (adminToken !== process.env.ADMIN_TOKEN && process.env.ADMIN_TOKEN) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // First, show what active streams exist
    const activeBefore = await pool.query(`
      SELECT stream_id, channel_id, started_at, 
             EXTRACT(EPOCH FROM (NOW() - started_at)) as age_seconds
      FROM streams 
      WHERE ended_at IS NULL
      ORDER BY started_at DESC
    `);
    console.log(`📊 Found ${activeBefore.rows.length} active stream(s) before cleanup:`);
    activeBefore.rows.forEach((row: any) => {
      console.log(`   - Stream ${row.stream_id}, Channel ${row.channel_id}, Age: ${Math.floor(row.age_seconds)}s`);
    });

    // Clean up ALL active streams (not just old ones) - more aggressive
    // This ensures we can fix any stuck streams
    const result = await pool.query(`
      UPDATE streams 
      SET ended_at = NOW() 
      WHERE ended_at IS NULL
      RETURNING stream_id, channel_id, started_at
    `);

    console.log(`🧹 Cleaned up ${result.rows.length} active stream(s)`);
    
    // Verify cleanup worked
    const activeAfter = await pool.query(`
      SELECT COUNT(*) as count FROM streams WHERE ended_at IS NULL
    `);
    console.log(`✅ Verification: ${activeAfter.rows[0].count} active stream(s) remaining`);

    res.json({ 
      success: true, 
      message: `Cleaned up ${result.rows.length} active stream(s)`,
      cleanedStreams: result.rows,
      activeBefore: activeBefore.rows.length,
      activeAfter: parseInt(activeAfter.rows[0].count)
    });
  } catch (err: any) {
    console.error("Error cleaning up streams:", err);
    res.status(500).json({ error: "Failed to cleanup streams", details: err.message });
  }
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
