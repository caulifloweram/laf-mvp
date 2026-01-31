import { OpusDecoder } from "opus-decoder";

let API_URL = import.meta.env.VITE_API_URL || "http://localhost:4000";
let RELAY_BASE = import.meta.env.VITE_LAF_RELAY_URL || "ws://localhost:9000";

function ensureRelayWsUrl(url: string): string {
  const trimmed = url.replace(/\/$/, "");
  if (/^wss?:/i.test(trimmed)) return trimmed;
  return (typeof window !== "undefined" && window.location?.protocol === "https:" ? "wss:" : "ws:") + "//" + trimmed;
}

async function loadRuntimeConfig(): Promise<void> {
  try {
    const base = window.location.origin;
    const res = await fetch(`${base}/config.json`);
    if (!res.ok) return;
    const config = await res.json() as { apiUrl?: string; relayWsUrl?: string };
    if (config.apiUrl) API_URL = config.apiUrl.replace(/\/$/, "");
    if (config.relayWsUrl) {
      RELAY_BASE = config.relayWsUrl.replace(/\/$/, "");
      if (!/^wss?:/i.test(RELAY_BASE)) {
        RELAY_BASE = (window.location.protocol === "https:" ? "wss:" : "ws:") + "//" + RELAY_BASE;
      }
    }
    console.log("[config] Using API:", API_URL, "Relay:", RELAY_BASE);
  } catch (_) {
    console.log("[config] Using build-time defaults");
  }
}

const MIN_TIER = Number(import.meta.env.VITE_LAF_MIN_TIER || 1);
const MAX_TIER_ALLOWED = Number(import.meta.env.VITE_LAF_MAX_TIER || 4);
const START_TIER = Number(import.meta.env.VITE_LAF_START_TIER || 2);

const SAMPLE_RATE = 48000;
const CHANNELS = 1;
const FRAME_DURATION_MS = 20;
const SAMPLES_PER_FRAME = (SAMPLE_RATE * FRAME_DURATION_MS) / 1000;

interface LAFPacket {
  tier: number;
  flags: number;
  streamId: number;
  seq: number;
  ptsMs: bigint;
  opusPayload: Uint8Array;
}

interface LiveChannel {
  id: string;
  title: string;
  description?: string;
  coverUrl?: string | null;
  streamId: number;
}

/** External online radio stations (stream URLs from [Radio Browser API](https://api.radio-browser.info/)); logoUrl = site favicon/apple-touch-icon */
interface ExternalStation {
  name: string;
  description: string;
  websiteUrl: string;
  streamUrl: string;
  logoUrl: string;
}

const EXTERNAL_STATIONS: ExternalStation[] = [
  {
    name: "Refuge Worldwide",
    description: "Community radio from Berlin. Music and issues we care about.",
    websiteUrl: "https://refugeworldwide.com/",
    streamUrl: "https://streaming.radio.co/s3699c5e49/listen",
    logoUrl: "https://refugeworldwide.com/apple-touch-icon.png",
  },
  {
    name: "Mutant Radio",
    description: "Independent station streaming worldwide. Experimental, electronic, folk.",
    websiteUrl: "https://www.mutantradio.net/",
    streamUrl: "https://listen.radioking.com/radio/282820/stream/328621",
    logoUrl: "https://www.mutantradio.net/icon?e5faaecf67dfe01a",
  },
  {
    name: "Radio 80000",
    description: "Non-commercial online radio from Munich. Music, dialogue, events.",
    websiteUrl: "https://www.radio80k.de/",
    streamUrl: "https://radio80k.out.airtime.pro:8000/radio80k_a",
    logoUrl: "https://www.radio80k.de/app/uploads/2022/10/cropped-favicon-8000-192x192.gif",
  },
];

function decodeLAF(buf: ArrayBuffer): LAFPacket | null {
  const view = new DataView(buf);
  let off = 0;

  const magic = view.getUint32(off); off += 4;
  if (magic !== 0x4c414631) return null;
  const version = view.getUint8(off); off += 1;
  if (version !== 1) return null;

  const tier = view.getUint8(off); off += 1;
  const flags = view.getUint16(off); off += 2;
  const streamId = view.getUint32(off); off += 4;
  const seq = view.getUint32(off); off += 4;
  const hi = view.getUint32(off); off += 4;
  const lo = view.getUint32(off); off += 4;
  const ptsMs = (BigInt(hi) << 32n) | BigInt(lo);
  const opusLen = view.getUint16(off); off += 2;

  if (buf.byteLength < off + opusLen) return null;
  const opusPayload = new Uint8Array(buf, off, opusLen);

  return { tier, flags, streamId, seq, ptsMs, opusPayload };
}

class JitterBuffer {
  private readonly targetDelayMs: number;
  private readonly minBufferPackets: number;
  private readonly maxBufferPackets: number; // Prevent memory overflow
  private packets = new Map<number, LAFPacket>();
  private playbackSeq: number | null = null;
  private startPtsMs: bigint | null = null;
  private playbackStartMs: number | null = null;
  private lastPlayedPacket: LAFPacket | null = null; // For packet loss concealment

  lossCount = 0;
  receivedCount = 0;
  lateCount = 0;
  lastSeq: number | null = null;
  bufferMs = 0;

  constructor(targetDelayMs = 1000, minBufferPackets = 30, maxBufferPackets = 100) {
    this.targetDelayMs = targetDelayMs;
    this.minBufferPackets = minBufferPackets; // ~600ms at 20ms per frame - larger initial buffer
    this.maxBufferPackets = maxBufferPackets; // ~2 seconds max buffer to prevent memory overflow
  }

  push(pkt: LAFPacket) {
    // CRITICAL: Prevent buffer overflow by removing old packets if buffer is too large
    if (this.packets.size >= this.maxBufferPackets) {
      // Remove oldest packets (lowest sequence numbers)
      const sortedSeqs = Array.from(this.packets.keys()).sort((a, b) => a - b);
      const packetsToRemove = sortedSeqs.slice(0, sortedSeqs.length - this.maxBufferPackets + 1);
      for (const seq of packetsToRemove) {
        this.packets.delete(seq);
      }
      if (packetsToRemove.length > 0) {
        console.warn(`[Buffer] Overflow: removed ${packetsToRemove.length} old packets (buffer was ${this.packets.size + packetsToRemove.length}, max: ${this.maxBufferPackets})`);
      }
    }
    
    // Also remove packets that are too far behind playback (more than 2 seconds = 100 packets)
    if (this.playbackSeq !== null) {
      const maxAge = 100; // ~2 seconds at 20ms per packet
      const oldestAllowedSeq = this.playbackSeq - maxAge;
      for (const seq of this.packets.keys()) {
        if (seq < oldestAllowedSeq) {
          this.packets.delete(seq);
        }
      }
    }
    
    this.packets.set(pkt.seq, pkt);
    this.receivedCount++;
    this.lastSeq = pkt.seq;

    if (this.startPtsMs == null) {
      this.startPtsMs = pkt.ptsMs;
      // Don't start playback until we have minimum buffer
      this.playbackSeq = pkt.seq;
      // We'll set playbackStartMs when we have enough packets
      console.log(`Jitter buffer initialized: seq=${pkt.seq}, waiting for ${this.minBufferPackets} packets before playback`);
    }

    // Start playback once we have minimum buffer
    if (this.startPtsMs != null && this.playbackStartMs == null && this.packets.size >= this.minBufferPackets) {
      this.playbackStartMs = performance.now() + this.targetDelayMs;
      console.log(`[Buffer] ready: ${this.packets.size} packets, playback starts in ${this.targetDelayMs}ms`);
    }

    this.updateBuffer();
  }

  private updateBuffer() {
    if (this.startPtsMs == null) {
      this.bufferMs = 0;
      return;
    }
    let maxPts: bigint | null = null;
    this.packets.forEach((p) => {
      if (maxPts == null || p.ptsMs > maxPts) maxPts = p.ptsMs;
    });
    if (maxPts == null) {
      this.bufferMs = 0;
      return;
    }
    this.bufferMs = Number(maxPts - this.startPtsMs);
  }

  popForPlayback(nowMs: number): LAFPacket | null {
    if (
      this.playbackSeq == null ||
      this.playbackStartMs == null ||
      this.startPtsMs == null
    ) {
      return null;
    }
    
    const elapsed = nowMs - this.playbackStartMs;
    if (elapsed < 0) {
      // Not time to start playback yet
      return null;
    }

    // Simple sequential playback: play the next packet in sequence
    const expectedSeq = this.playbackSeq;
    this.playbackSeq = expectedSeq + 1;

    // Try to get the expected packet
    let pkt = this.packets.get(expectedSeq);
    
    // If exact packet not found, try to find the next available packet (within reasonable window)
    if (!pkt && this.packets.size > 0) {
      const availableSeqs = Array.from(this.packets.keys()).sort((a, b) => a - b);
      // Look for a packet that's close to expected (within 15 packets = 300ms)
      for (const seq of availableSeqs) {
        if (seq >= expectedSeq && seq <= expectedSeq + 15) {
          pkt = this.packets.get(seq)!;
          this.playbackSeq = seq + 1;
          if (seq !== expectedSeq) {
            console.log(`⏭️ Skipped to packet seq ${seq} (expected ${expectedSeq}, gap: ${seq - expectedSeq})`);
          }
          break;
        }
      }
    }

    // Packet loss concealment: if no packet found, use last played packet (with fade)
    if (!pkt) {
      this.lossCount++;
      this.updateBuffer();
      
      // Use last played packet for concealment (will be faded in schedulePcm)
      if (this.lastPlayedPacket) {
        pkt = this.lastPlayedPacket;
        // Mark it as concealed so we can fade it
        (pkt as any).concealed = true;
        // Only log occasionally to reduce spam
        if (this.lossCount === 1 || this.lossCount % 50 === 0) {
          const availableSeqs = Array.from(this.packets.keys()).sort((a, b) => a - b);
          if (availableSeqs.length > 0) {
            console.warn(`[Conceal] missing packet seq ${expectedSeq} (using last packet), buffer has ${this.packets.size} packets`);
          } else {
            console.warn(`[Conceal] missing packet seq ${expectedSeq} (using last packet), buffer is empty`);
          }
        }
      } else {
        // No last packet to conceal with
        if (this.lossCount === 1 || this.lossCount % 50 === 0) {
          const availableSeqs = Array.from(this.packets.keys()).sort((a, b) => a - b);
          if (availableSeqs.length > 0) {
            console.warn(`[Missing] packet seq ${expectedSeq}, buffer has ${this.packets.size} packets, earliest: ${availableSeqs[0]}, latest: ${availableSeqs[availableSeqs.length - 1]}`);
          } else {
            console.warn(`[Missing] packet seq ${expectedSeq}, buffer is empty`);
          }
        }
        return null;
      }
    } else {
      // We have a real packet, remove it from buffer and update last played
      this.packets.delete(pkt.seq);
      this.lastPlayedPacket = pkt;
      (pkt as any).concealed = false;
    }

    this.updateBuffer();
    return pkt;
  }

  resetWindow() {
    this.lossCount = 0;
    this.receivedCount = 0;
    this.lateCount = 0;
  }
  
  // Reset all buffer state (for stop/start cycles)
  reset() {
    this.packets.clear();
    this.playbackSeq = null;
    this.startPtsMs = null;
    this.playbackStartMs = null;
    this.lastPlayedPacket = null;
    this.lossCount = 0;
    this.receivedCount = 0;
    this.lateCount = 0;
    this.lastSeq = null;
    this.bufferMs = 0;
  }
}

interface AbrState {
  currentTier: number;
  minTier: number;
  maxTierAllowed: number;
  stableMs: number;
  consecutiveLateOrMissing: number;
}
interface AbrInputs {
  lossPercent2s: number;
  bufferMs: number;
  lateRate: number;
  deltaMs: number;
}

function updateAbr(state: AbrState, inputs: AbrInputs, tierBuf: JitterBuffer, allTiers: Map<number, JitterBuffer>): AbrState {
  const next = { ...state };
  next.stableMs += inputs.deltaMs;

  // Check if current tier has packets in buffer
  const hasPackets = (tierBuf as any).packets.size > 0;
  const bufferInitialized = (tierBuf as any).playbackSeq !== null;
  const playbackStarted = (tierBuf as any).playbackStartMs !== null && 
                          performance.now() >= (tierBuf as any).playbackStartMs;

  // Check if target tier would have packets before switching
  const checkTierHasPackets = (tier: number): boolean => {
    const buf = allTiers.get(tier);
    if (!buf) return false;
    return (buf as any).packets.size > 0 || (buf as any).playbackSeq !== null;
  };

  // Don't downgrade if:
  // 1. Current tier has packets in buffer AND buffer is initialized
  // 2. OR playback hasn't started yet (still in initial delay)
  // 3. OR target tier doesn't have packets (would cause silence)
  // CRITICAL: Never downgrade to a tier that has no packets - this causes silence!
  const targetTier = next.currentTier - 1;
  const targetTierHasPackets = targetTier >= MIN_TIER && checkTierHasPackets(targetTier);
  
  // SIMPLIFIED: Only downgrade if we have sustained packet loss
  // Don't downgrade for temporary buffer issues - that's normal
  const hasRealProblem = inputs.lossPercent2s > 10 || 
                         (next.consecutiveLateOrMissing >= 10 && playbackStarted);
  
  const shouldDown =
    hasRealProblem &&
    // Don't downgrade if current tier has packets and is initialized
    !(hasPackets && bufferInitialized) &&
    // Don't downgrade during initial delay
    playbackStarted &&
    // CRITICAL: Don't downgrade if target tier doesn't have packets (would cause silence)
    targetTierHasPackets &&
    // Don't downgrade if current tier has packets (buffer is healthy)
    (tierBuf as any).packets.size > 0;

  if (shouldDown) {
    const oldTier = next.currentTier;
    const newTier = Math.max(next.currentTier - 1, next.minTier);
    
    // CRITICAL: Double-check that the new tier actually has packets before switching
    const newTierBuf = allTiers.get(newTier);
    const newTierHasPackets = newTierBuf && ((newTierBuf as any).packets.size > 0 || (newTierBuf as any).playbackSeq !== null);
    
    if (!newTierHasPackets) {
      // Target tier doesn't have packets, don't downgrade
      console.warn(`[ABR] Wanted to downgrade to tier ${newTier} but it has no packets, staying on tier ${oldTier}`);
      return next;
    }
    
    next.currentTier = newTier;
    if (oldTier !== next.currentTier) {
      console.log(`⬇️ ABR downgrading: ${oldTier} → ${next.currentTier} (loss: ${inputs.lossPercent2s.toFixed(1)}%, buffer: ${inputs.bufferMs}ms, missing: ${next.consecutiveLateOrMissing})`);
    }
    next.stableMs = 0;
    next.consecutiveLateOrMissing = 0;
    return next;
  }

  // Only upgrade if target tier has packets
  const canUp =
    next.stableMs >= 15_000 && 
    inputs.lossPercent2s < 1 && 
    inputs.bufferMs > 250 &&
    checkTierHasPackets(next.currentTier + 1);

  if (canUp) {
    const oldTier = next.currentTier;
    next.currentTier = Math.min(next.currentTier + 1, next.maxTierAllowed);
    if (oldTier !== next.currentTier) {
      console.log(`⬆️ ABR upgrading: ${oldTier} → ${next.currentTier}`);
    }
    next.stableMs = 0;
  }

  return next;
}

// DOM refs
const channelsGrid = document.getElementById("channels-grid")!;
const playerSection = document.getElementById("player-section")!;
const nowPlayingTitle = document.getElementById("now-playing-title")!;
const nowPlayingDesc = document.getElementById("now-playing-desc")!;
const playerCoverWrap = document.getElementById("player-cover-wrap")!;
const playerCover = document.getElementById("player-cover")! as HTMLImageElement;
const btnStart = document.getElementById("btn-start") as HTMLButtonElement;
const btnStop = document.getElementById("btn-stop") as HTMLButtonElement;
const playIcon = document.getElementById("play-icon")!;
const playText = document.getElementById("play-text")!;
const playerLiveBadge = document.getElementById("player-live-badge")!;
const playerStatus = document.getElementById("player-status")!;
const playerStatusIcon = document.getElementById("player-status-icon")!;
const playerStatusText = document.getElementById("player-status-text")!;
const statTier = document.getElementById("stat-tier")!;
const statLoss = document.getElementById("stat-loss")!;
const statBuffer = document.getElementById("stat-buffer")!;
const statLate = document.getElementById("stat-late")!;
const statLatency = document.getElementById("stat-latency")!;
const statKbps = document.getElementById("stat-kbps")!;
const chatMessages = document.getElementById("chat-messages")!;
const chatSigninPrompt = document.getElementById("chat-signin-prompt")!;
const chatInputRow = document.getElementById("chat-input-row")!;
const chatInput = document.getElementById("chat-input")! as HTMLInputElement;
const chatSendBtn = document.getElementById("chat-send")!;
const externalStreamActions = document.getElementById("external-stream-actions")!;
const externalVisitWebsite = document.getElementById("external-visit-website")! as HTMLAnchorElement;
const playerStatGrid = document.getElementById("player-stat-grid")!;
const playerChatPanel = document.getElementById("player-chat-panel")!;
const externalStationsGrid = document.getElementById("external-stations-grid")!;
const nowPlayingProgram = document.getElementById("now-playing-program")!;
const nowPlayingProgramWrap = document.getElementById("now-playing-program-wrap")!;
const playerPrevNextWrap = document.getElementById("player-prev-next-wrap")!;
const btnPrevStation = document.getElementById("btn-prev-station")!;
const btnNextStation = document.getElementById("btn-next-station")!;

let token: string | null = localStorage.getItem("laf_token");
let userEmail: string | null = localStorage.getItem("laf_user_email");

function updateTopBarAuth() {
  const signinLink = document.getElementById("client-signin-link")!;
  const userEmailEl = document.getElementById("client-user-email")!;
  const logoutBtn = document.getElementById("client-logout-btn")!;
  if (token && userEmail) {
    signinLink.classList.add("hidden");
    userEmailEl.textContent = userEmail;
    userEmailEl.classList.remove("hidden");
    logoutBtn.classList.remove("hidden");
    chatSigninPrompt.classList.add("hidden");
    chatInputRow.classList.remove("hidden");
  } else {
    signinLink.classList.remove("hidden");
    userEmailEl.classList.add("hidden");
    logoutBtn.classList.add("hidden");
    chatSigninPrompt.classList.remove("hidden");
    chatInputRow.classList.add("hidden");
  }
}

function appendChatMessage(email: string, text: string, ts?: number) {
  const div = document.createElement("div");
  div.className = "chat-message";
  const time = ts ? new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "";
  div.innerHTML = `<span class="chat-author">${escapeHtml(email)}${time ? ` <small>${time}</small>` : ""}</span> ${escapeHtml(text)}`;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function showConfirm(options: {
  message: string;
  title?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}): Promise<boolean> {
  const overlay = document.getElementById("confirm-overlay")!;
  const titleEl = document.getElementById("confirm-title")!;
  const messageEl = document.getElementById("confirm-message")!;
  const cancelBtn = document.getElementById("confirm-cancel-btn")!;
  const okBtn = document.getElementById("confirm-ok-btn")!;
  titleEl.textContent = options.title ?? "Confirm";
  messageEl.textContent = options.message;
  cancelBtn.textContent = options.cancelText ?? "Cancel";
  okBtn.textContent = options.confirmText ?? "OK";
  okBtn.classList.toggle("danger", !!options.danger);
  overlay.classList.add("visible");
  overlay.setAttribute("aria-hidden", "false");
  return new Promise((resolve) => {
    const done = (value: boolean) => {
      overlay.classList.remove("visible");
      overlay.setAttribute("aria-hidden", "true");
      overlay.onclick = null;
      cancelBtn.onclick = null;
      okBtn.onclick = null;
      window.removeEventListener("keydown", onKey);
      resolve(value);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") done(false);
    };
    overlay.onclick = (e) => {
      if (e.target === overlay) done(false);
    };
    window.addEventListener("keydown", onKey);
    cancelBtn.onclick = () => done(false);
    okBtn.onclick = () => done(true);
  });
}

let ws: WebSocket | null = null;
let audioCtx: AudioContext | null = null;
let opusDecoder: OpusDecoder | null = null;
let analyserNode: AnalyserNode | null = null;
let lafGain: GainNode | null = null;
let mediaSource: MediaElementAudioSourceNode | null = null;
const FREQ_BIN_COUNT = 256;

const tiers = new Map<number, JitterBuffer>();
// Create jitter buffers with larger initial delay and buffer for smooth streaming
// Initial delay: 1000ms (1 second) to build up buffer before playback
// Min buffer: 30 packets (~600ms) before starting playback
// Max buffer: 100 packets (~2 seconds) to prevent memory overflow
for (let t = MIN_TIER; t <= MAX_TIER_ALLOWED; t++) {
  tiers.set(t, new JitterBuffer(1000, 30, 100)); // 1000ms delay, 30 packets minimum, 100 packets max
}

let abrState: AbrState = {
  currentTier: START_TIER,
  minTier: MIN_TIER,
  maxTierAllowed: MAX_TIER_ALLOWED,
  stableMs: 0,
  consecutiveLateOrMissing: 0
};

let lastStatsTime = performance.now();
let lossCountWindow = 0;
let recvCountWindow = 0;
let lateCountWindow = 0;
let currentChannel: LiveChannel | null = null;
let currentExternalStation: ExternalStation | null = null;
let externalAudio: HTMLAudioElement | null = null;
let playheadTime = 0;
let loopRunning = false;
let isStopping = false; // Flag to prevent audio scheduling during stop
let fadeOutStartTime: number | null = null; // When fade out started (for smooth fade)
let fadeOutDuration = 5000; // 5 seconds fade out
const LOOKAHEAD_PACKETS = 10; // Schedule 10 packets (200ms) ahead for smooth playback - increased for better stability

async function getOrCreateAudioContext(): Promise<AudioContext | null> {
  if (audioCtx) {
    if (audioCtx.state === "suspended") await audioCtx.resume().catch(() => {});
    return audioCtx;
  }
  audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
  analyserNode = audioCtx.createAnalyser();
  analyserNode.fftSize = FREQ_BIN_COUNT * 2;
  analyserNode.smoothingTimeConstant = 0.6;
  analyserNode.connect(audioCtx.destination);
  if (audioCtx.state === "suspended") await audioCtx.resume().catch(() => {});
  return audioCtx;
}

async function loadChannels() {
  try {
    const url = `${API_URL}/api/channels/live`;
    console.log(`[loadChannels] Fetching live channels from ${url}`);
    console.log(`[loadChannels] API_URL is: ${API_URL}`);
    
    // Add timestamp to URL to prevent caching
    const cacheBuster = `?t=${Date.now()}`;
    const res = await fetch(url + cacheBuster, {
      cache: "no-store",
      headers: {
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Accept": "application/json"
      }
    });
    
    console.log(`[loadChannels] Response status: ${res.status} ${res.statusText}`);
    console.log(`[loadChannels] Response headers:`, Object.fromEntries(res.headers.entries()));
    
    if (!res.ok) {
      const errorText = await res.text();
      console.error(`[loadChannels] Failed to fetch live channels: HTTP ${res.status}`, errorText);
      channelsGrid.innerHTML = `<p style='opacity: 0.7; color: #ef4444;'>Error loading channels: HTTP ${res.status}</p>`;
      return;
    }
    
    const channels: LiveChannel[] = await res.json();
    console.log(`[loadChannels] Loaded ${channels.length} live channels:`, channels);
    
    channelsGrid.innerHTML = "";
    if (channels.length === 0) {
      channelsGrid.innerHTML = "<p style='opacity: 0.7;'>No live channels at the moment.</p>";
      renderExternalStations();
      // If we were listening to a channel that's no longer live, stop listening
      if (currentChannel && !channels.find(c => c.id === currentChannel.id)) {
        console.log("Current channel is no longer live, stopping...");
        if (ws) {
          loopRunning = false;
          ws.close();
          ws = null;
        }
        updatePlayerStatus("stopped", "Stream ended");
        btnStart.classList.remove("hidden");
        btnStop.classList.add("hidden");
        playerLiveBadge.classList.add("hidden");
        playIcon.textContent = "\u25B6";
        playText.textContent = "Start";
      }
      return;
    }
    channels.forEach((c) => {
      console.log(`[loadChannels] Creating card for channel:`, c);
      if (!c.id || !c.streamId) {
        console.warn(`[loadChannels] Invalid channel data:`, c);
        return;
      }
      const card = document.createElement("div");
      card.className = "channel-card";
      if (currentChannel?.id === c.id) card.classList.add("selected");
      if (currentChannel?.id === c.id && ws && ws.readyState === WebSocket.OPEN) card.classList.add("now-playing");
      const coverHtml = c.coverUrl
        ? `<img src="${escapeAttr(c.coverUrl)}" alt="" class="channel-card-cover" />`
        : "";
      card.innerHTML = `
        <div class="mac-window-title"><span class="close-box"></span>${escapeHtml(c.title || "Untitled")}</div>
        <div class="mac-window-body">
          ${coverHtml}
          <div class="channel-desc">${escapeHtml(c.description || "")}</div>
          <span class="live-badge">LIVE</span>
        </div>
      `;
      card.onclick = () => {
        console.log(`[loadChannels] Channel clicked:`, c);
        selectChannel(c);
      };
      channelsGrid.appendChild(card);
    });
    console.log(`[loadChannels] Added ${channels.length} channel cards to grid`);
    
    // If current channel is no longer in the list, stop listening
    if (currentChannel && !channels.find(c => c.id === currentChannel.id)) {
      console.log("Current channel is no longer live, stopping...");
      if (ws) {
        loopRunning = false;
        ws.close();
        ws = null;
      }
      updatePlayerStatus("stopped", "Stream ended");
      btnStart.classList.remove("hidden");
      btnStop.classList.add("hidden");
      playerLiveBadge.classList.add("hidden");
      playIcon.textContent = "\u25B6";
      playText.textContent = "Start";
      currentChannel = null;
    }
    renderExternalStations();
  } catch (err: any) {
    console.error("[loadChannels] Exception caught:", err);
    console.error("[loadChannels] Error details:", err.message, err.stack);
    channelsGrid.innerHTML = `<p style='opacity: 0.7; color: #ef4444;'>Error: ${err.message || "Failed to load channels"}</p>`;
    renderExternalStations();
  }
}

function renderExternalStations() {
  externalStationsGrid.innerHTML = "";
  EXTERNAL_STATIONS.forEach((station) => {
    const card = document.createElement("div");
    card.className = "external-station-card";
    if (currentExternalStation?.streamUrl === station.streamUrl) card.classList.add("now-playing");
    const logoHtml = station.logoUrl
      ? `<img src="${escapeAttr(station.logoUrl)}" alt="" class="ext-station-logo" />`
      : "";
    card.innerHTML = `
      ${logoHtml}
      <div class="ext-name">${escapeHtml(station.name)}</div>
      <div class="ext-desc">${escapeHtml(station.description)}</div>
      <div class="ext-link">Stream · ${escapeHtml(station.websiteUrl)}</div>
    `;
    card.onclick = (e) => {
      e.preventDefault();
      selectExternalStation(station);
    };
    externalStationsGrid.appendChild(card);
  });
}

function selectExternalStation(station: ExternalStation) {
  if (currentExternalStation?.streamUrl === station.streamUrl) return;
  if (currentChannel || ws) {
    stopListening();
    currentChannel = null;
  }
  stopExternalStream();
  currentExternalStation = station;
  nowPlayingTitle.textContent = station.name;
  nowPlayingDesc.textContent = station.description;
  externalVisitWebsite.href = station.websiteUrl;
  externalVisitWebsite.textContent = "Visit " + station.name;
  externalStreamActions.classList.remove("hidden");
  playerStatGrid.classList.add("hidden");
  playerChatPanel.classList.add("hidden");
  playerCoverWrap.classList.add("external-logo");
  if (station.logoUrl) {
    playerCover.src = station.logoUrl;
    playerCoverWrap.classList.remove("placeholder");
    playerCover.onerror = () => {
      playerCoverWrap.classList.add("placeholder");
      playerCover.removeAttribute("src");
    };
  } else {
    playerCoverWrap.classList.add("placeholder");
    playerCover.removeAttribute("src");
  }
  playerSection.classList.remove("hidden", "window-closed");
  const center = (window as unknown as { centerWindowInViewport?: (win: HTMLElement) => void }).centerWindowInViewport;
  const clamp = (window as unknown as { clampWindowToViewport?: (win: HTMLElement) => void }).clampWindowToViewport;
  requestAnimationFrame(() => {
    if (center) center(playerSection);
    else if (clamp) clamp(playerSection);
  });
  if (externalAudio) {
    externalAudio.pause();
    externalAudio.src = "";
  }
  if (mediaSource) {
    try { mediaSource.disconnect(); } catch (_) {}
    mediaSource = null;
  }
  externalAudio = new Audio(station.streamUrl);
  playerPrevNextWrap.classList.remove("hidden");
  nowPlayingProgramWrap.classList.add("hidden");
  nowPlayingProgram.textContent = "";
  fetchStreamMetadataViaApi(station.streamUrl).then((text) => {
    if (currentExternalStation?.streamUrl === station.streamUrl && text) {
      nowPlayingProgram.textContent = text.length > 120 ? text.slice(0, 117) + "…" : text;
      nowPlayingProgramWrap.classList.remove("hidden");
    }
  }).catch(() => {});

  externalAudio.onplaying = () => updatePlayerStatus("playing", "Listening to stream");
  externalAudio.onerror = () => updatePlayerStatus("stopped", "Stream error");
  externalAudio.onended = () => {
    if (currentExternalStation?.streamUrl === station.streamUrl) {
      updatePlayerStatus("ready", "Stream ended");
    }
  };
  externalAudio.play().catch((err) => {
    console.error("[External stream] Play failed:", err);
    updatePlayerStatus("stopped", "Could not start stream");
  });
  updatePlayerStatus("playing", "Connecting…");
  btnStart.classList.add("hidden");
  btnStop.classList.remove("hidden");
  playerLiveBadge.classList.remove("hidden");
}

async function fetchStreamMetadataViaApi(streamUrl: string): Promise<string | null> {
  try {
    const res = await fetch(`${API_URL}/api/stream-metadata?url=${encodeURIComponent(streamUrl)}`);
    if (!res.ok) return null;
    const data = (await res.json()) as { name?: string | null; description?: string | null };
    const desc = data.description?.trim();
    const name = data.name?.trim();
    if (desc) return desc;
    if (name) return name;
    return null;
  } catch {
    return null;
  }
}

function stopExternalStream() {
  if (externalAudio) {
    externalAudio.pause();
    externalAudio.src = "";
    externalAudio = null;
  }
  if (mediaSource) {
    try { mediaSource.disconnect(); } catch (_) {}
    mediaSource = null;
  }
  currentExternalStation = null;
  playerPrevNextWrap.classList.add("hidden");
  externalStreamActions.classList.add("hidden");
  playerStatGrid.classList.remove("hidden");
  playerChatPanel.classList.remove("hidden");
  playerCoverWrap.classList.remove("external-logo");
  nowPlayingTitle.textContent = "Not playing";
  nowPlayingDesc.textContent = "";
  nowPlayingProgramWrap.classList.add("hidden");
  nowPlayingProgram.textContent = "";
  updatePlayerStatus("ready", "Ready to listen");
  btnStart.classList.remove("hidden");
  btnStop.classList.add("hidden");
  playerLiveBadge.classList.add("hidden");
  playerSection.classList.add("hidden");
}

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function escapeAttr(s: string): string {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML.replace(/"/g, "&quot;");
}

function selectChannel(channel: LiveChannel) {
  const wasPlayingLaf = ws != null && ws.readyState === WebSocket.OPEN;
  if (currentExternalStation) stopExternalStream();
  currentChannel = channel;
  nowPlayingTitle.textContent = channel.title;
  nowPlayingDesc.textContent = channel.description || "";
  nowPlayingProgramWrap.classList.add("hidden");
  nowPlayingProgram.textContent = "";
  playerPrevNextWrap.classList.add("hidden");
  playerCoverWrap.classList.remove("external-logo");
  playerCover.onerror = null;
  if (channel.coverUrl) {
    playerCover.src = channel.coverUrl;
    playerCoverWrap.classList.remove("placeholder");
  } else {
    playerCover.removeAttribute("src");
    playerCoverWrap.classList.add("placeholder");
  }
  playerSection.classList.remove("hidden", "window-closed");
  const center = (window as unknown as { centerWindowInViewport?: (win: HTMLElement) => void }).centerWindowInViewport;
  const clamp = (window as unknown as { clampWindowToViewport?: (win: HTMLElement) => void }).clampWindowToViewport;
  requestAnimationFrame(() => {
    if (center) center(playerSection);
    else if (clamp) clamp(playerSection);
  });
  if (ws) {
    loopRunning = false;
    ws.close();
    ws = null;
  }
  if (wasPlayingLaf) {
    btnStart.classList.add("hidden");
    btnStop.classList.remove("hidden");
    playerLiveBadge.classList.remove("hidden");
    startListening().catch((e) => {
      console.error("Failed to switch channel:", e);
      btnStart.classList.remove("hidden");
      btnStop.classList.add("hidden");
      playerLiveBadge.classList.add("hidden");
    });
  }
}

async function startListening() {
  if (!currentChannel) return;
  btnStart.disabled = true;

  console.log("[Listen] Starting - initializing fresh state...");
  
  // CRITICAL: Reset stopping flag and fade out state when starting a new stream
  isStopping = false;
  fadeOutStartTime = null;
  (window as any).lastShownCountdown = null; // Reset countdown tracker
  
  const ctx = await getOrCreateAudioContext();
  if (!ctx) return;
  audioCtx = ctx;
  playheadTime = audioCtx.currentTime;

  if (lafGain) lafGain.disconnect();
  lafGain = audioCtx.createGain();
  lafGain.gain.value = 1;
  lafGain.connect(analyserNode!);
  
  // Ensure ABR state is reset
  abrState = {
    currentTier: START_TIER,
    minTier: MIN_TIER,
    maxTierAllowed: MAX_TIER_ALLOWED,
    stableMs: 0,
    consecutiveLateOrMissing: 0
  };
  
  if (!opusDecoder) {
    opusDecoder = new OpusDecoder({
      channels: CHANNELS,
      sampleRate: SAMPLE_RATE,
    });
    await opusDecoder.ready;
  }

  chatMessages.innerHTML = "";

  const wsUrl = `${ensureRelayWsUrl(RELAY_BASE)}/?role=listener&streamId=${currentChannel.streamId}${token ? `&token=${encodeURIComponent(token)}` : ""}`;
  console.log("Connecting to relay:", wsUrl);
  console.log("Current ABR tier:", abrState.currentTier);
  console.log("Available tiers:", Array.from(tiers.keys()));
  
  ws = new WebSocket(wsUrl);
  ws.binaryType = "arraybuffer";

  ws.onopen = async () => {
    console.log("[WS] Connected to relay");
    console.log("Connected to stream");
    console.log("AudioContext state:", audioCtx?.state);
    if (audioCtx && audioCtx.state === "suspended") {
      await audioCtx.resume();
      console.log("AudioContext resumed after connection");
    }
    
    // Test audio output with a brief tone
    if (audioCtx) {
      const testBuffer = audioCtx.createBuffer(1, audioCtx.sampleRate * 0.1, audioCtx.sampleRate);
      const testData = testBuffer.getChannelData(0);
      for (let i = 0; i < testData.length; i++) {
        testData[i] = Math.sin(2 * Math.PI * 440 * i / audioCtx.sampleRate) * 0.1; // 440Hz tone
      }
      const testSrc = audioCtx.createBufferSource();
      testSrc.buffer = testBuffer;
      testSrc.connect(audioCtx.destination);
      testSrc.start();
      console.log("Test tone played - if you hear a beep, audio is working");
    }
    
    loopRunning = true; // Start the loop
    loop(); // Start processing
    
    // Update UI
    updatePlayerStatus("playing", "Listening live");
    btnStart.classList.add("hidden");
    btnStop.classList.remove("hidden");
    playerLiveBadge.classList.remove("hidden");
  };

  ws.onerror = (err) => {
    console.error("WebSocket error:", err);
  };

  ws.onclose = (event) => {
    console.log("[WS] Closed");
    console.log(`   Code: ${event.code}`);
    console.log(`   Reason: ${event.reason || "No reason"}`);
    console.log(`   Was clean: ${event.wasClean}`);
    console.log(`   Total messages received: ${messageCount}, last seq: ${lastLoggedSeq}`);
    
    if ((window as any).__streamEndCountdownInterval) {
      clearInterval((window as any).__streamEndCountdownInterval);
      (window as any).__streamEndCountdownInterval = null;
    }
    if ((ws as any).messageMonitor) {
      clearInterval((ws as any).messageMonitor);
    }
    
    stopListening();
    
    const reason = event.reason || "";
    updatePlayerStatus("stopped", reason.includes("Stream ended") ? "Stream ended" : "Disconnected");
    btnStart.disabled = false;
    btnStart.classList.remove("hidden");
    btnStop.classList.add("hidden");
    playerLiveBadge.classList.add("hidden");
    playIcon.textContent = "\u25B6";
    playText.textContent = "Reconnect";
  };

  let lastMessageTime = performance.now();
  let messageCount = 0;
  let lastLoggedSeq = 0;
  
  // Monitor message reception to detect when they stop
  const messageMonitor = setInterval(() => {
    const timeSinceLastMessage = performance.now() - lastMessageTime;
    if (timeSinceLastMessage > 2000 && ws && ws.readyState === WebSocket.OPEN) {
      console.warn(`[WS] No messages received for ${timeSinceLastMessage.toFixed(0)}ms, WebSocket state: ${ws.readyState}`);
      console.warn(`   Last message count: ${messageCount}, last seq: ${lastLoggedSeq}`);
    }
  }, 2000);
  
  ws.onmessage = async (ev) => {
    lastMessageTime = performance.now();
    messageCount++;
    
    // Handle text messages (chat and control like "stream ending")
    if (typeof ev.data === "string") {
      try {
        const message = JSON.parse(ev.data);
        if (message.type === "chat" && message.email != null && message.text != null) {
          appendChatMessage(message.email, message.text, message.timestamp);
          return;
        }
        if (message.type === "stream_ending") {
          const countdown = message.countdown || 5;
          console.log(`[Stream] Ending notification - ${countdown} seconds until end`);
          console.log(`[Fade] Starting graceful fade out over ${countdown} seconds...`);
          
          // Start fade out
          fadeOutStartTime = performance.now();
          fadeOutDuration = countdown * 1000; // Convert to milliseconds
          (window as any).lastShownCountdown = countdown + 1; // Initialize countdown tracker
          
          // Update UI and tick countdown every second
          updatePlayerStatus("playing", `Stream ending in ${countdown}...`);
          let remaining = countdown;
          const countdownTick = setInterval(() => {
            remaining--;
            if (remaining <= 0) {
              clearInterval(countdownTick);
              updatePlayerStatus("playing", "Stream ending…");
            } else {
              updatePlayerStatus("playing", `Stream ending in ${remaining}...`);
            }
          }, 1000);
          (window as any).__streamEndCountdownInterval = countdownTick;
        }
      } catch (err) {
        console.warn("Failed to parse control message:", err);
      }
      return;
    }
    
    // Handle binary messages (audio packets)
    if (!(ev.data instanceof ArrayBuffer)) {
      console.warn("Received non-ArrayBuffer message");
      return;
    }
    
    const pkt = decodeLAF(ev.data);
    if (!pkt) {
      console.warn("Failed to decode LAF packet, data size:", ev.data.byteLength);
      return;
    }
    
    lastLoggedSeq = pkt.seq;
    
    // Log first packet always
    if (pkt.seq === 1) {
      console.log("[First packet]", { tier: pkt.tier, seq: pkt.seq, streamId: pkt.streamId });
    }
    
    const buf = tiers.get(pkt.tier);
    if (!buf) {
      console.warn("[Unknown tier]:", pkt.tier, "available tiers:", Array.from(tiers.keys()));
      return;
    }
    
    const beforePush = buf.receivedCount;
    const playbackSeqBefore = (buf as any).playbackSeq;
    buf.push(pkt);
    const playbackSeqAfter = (buf as any).playbackSeq;
    
    // Log initialization
    if (playbackSeqBefore === null && playbackSeqAfter !== null) {
      console.log("[Jitter] Buffer initialized playbackSeq:", playbackSeqAfter, "playback starts in 1000ms");
    }
    
    // Log first few packets and periodically
    if (pkt.seq <= 5 || pkt.seq % 50 === 0 || beforePush === 0) {
      console.log("[Buffer] Pushed packet to tier", pkt.tier, ":", { 
        seq: pkt.seq, 
        payloadSize: pkt.opusPayload.length, 
        receivedCount: buf.receivedCount,
        bufferSize: (buf as any).packets.size,
        totalMessages: messageCount
      });
    }
  };
  
  // Store messageMonitor for cleanup
  (ws as any).messageMonitor = messageMonitor;

  // Loop will be started when WebSocket opens
}

function schedulePcm(ctx: AudioContext, pcm: Float32Array, isConcealed = false) {
  // CRITICAL: Don't schedule audio if we're stopping or stopped
  if (isStopping || !loopRunning) {
    return;
  }
  
  if (ctx.state === "suspended") {
    console.warn("AudioContext is suspended, cannot play audio");
    return;
  }
  
  if (pcm.length === 0) {
    console.warn("Empty PCM data");
    return;
  }
  
  const sampleCount = pcm.length;
  try {
    const buffer = ctx.createBuffer(CHANNELS, sampleCount, SAMPLE_RATE);
    const channelData = buffer.getChannelData(0);
    
    // Calculate fade out factor if fade out is active
    let fadeOutFactor = 1.0;
    if (fadeOutStartTime !== null) {
      const elapsed = performance.now() - fadeOutStartTime;
      
      // Add small ramp-in period (100ms) to prevent glitch when fade starts
      const RAMP_IN_MS = 100;
      const effectiveElapsed = Math.max(0, elapsed - RAMP_IN_MS);
      const effectiveDuration = fadeOutDuration - RAMP_IN_MS;
      
      if (elapsed >= fadeOutDuration) {
        // Fade out complete - stop scheduling audio and clean up
        console.log("[Fade] Complete - stopping audio and cleaning up");
        fadeOutStartTime = null;
        isStopping = true;
        
        // Don't stop loopRunning here - let the loop handle it naturally
        // This prevents the freeze issue
        
        // Clean up gracefully after fade-out completes
        // Use requestAnimationFrame to ensure UI updates happen
        requestAnimationFrame(() => {
          setTimeout(() => {
            stopListening();
            updatePlayerStatus("stopped", "Stream ended");
          }, 200); // Small delay to ensure last audio packet is scheduled
        });
        
        return;
      }
      
      // Smooth fade out with ramp-in: 1.0 at start, gradually fade to 0.0 at end
      // Use exponential curve for smoother fade (ease-out)
      if (effectiveElapsed <= 0) {
        fadeOutFactor = 1.0; // Full volume during ramp-in
      } else {
        const progress = Math.min(1.0, effectiveElapsed / effectiveDuration);
        // Exponential ease-out for smoother fade: 1 - (1 - progress)^2
        const easedProgress = 1 - Math.pow(1 - progress, 2);
        fadeOutFactor = 1.0 - easedProgress;
      }
      
      // Update UI countdown every second during fade-out
      const remainingSeconds = Math.ceil((fadeOutDuration - elapsed) / 1000);
      const lastShownCountdown = (window as any).lastShownCountdown || 999;
      if (remainingSeconds !== lastShownCountdown && remainingSeconds >= 0) {
        (window as any).lastShownCountdown = remainingSeconds;
        // Use requestAnimationFrame for smooth UI updates
        requestAnimationFrame(() => {
          if (remainingSeconds > 0) {
            updatePlayerStatus("playing", `Stream ending in ${remainingSeconds}...`);
          } else {
            updatePlayerStatus("playing", "Stream ending...");
          }
        });
      }
    }
    
    // If this is a concealed packet (packet loss), fade it out to reduce artifacts
    if (isConcealed) {
      const fadeLength = Math.min(sampleCount / 4, 240); // Fade last 25% or 5ms, whichever is smaller
      const fadeStart = sampleCount - fadeLength;
      for (let i = 0; i < sampleCount; i++) {
        let sample = pcm[i];
        if (i >= fadeStart) {
          const concealFadeFactor = 1 - ((i - fadeStart) / fadeLength);
          sample *= concealFadeFactor;
        }
        // Apply stream ending fade out
        sample *= fadeOutFactor;
        channelData[i] = sample;
      }
    } else {
      // Apply stream ending fade out to all samples
      for (let i = 0; i < sampleCount; i++) {
        channelData[i] = pcm[i] * fadeOutFactor;
      }
    }
    
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    
    // CRITICAL: Use playheadTime for continuous scheduling, but ensure we're not too far ahead
    const now = ctx.currentTime;
    // If playheadTime is too far in the past, reset it to now + small buffer
    if (playheadTime < now - 0.1) {
      playheadTime = now + 0.05; // Reset if we're more than 100ms behind
    }
    
    // Schedule at playheadTime to maintain continuity
    const targetTime = playheadTime;
    const dest = lafGain ?? ctx.destination;
    src.connect(dest);
    
    src.start(targetTime);
    // Update playheadTime for next packet (continuous scheduling)
    playheadTime = targetTime + buffer.duration;
  } catch (err) {
    console.error("Failed to schedule PCM:", err, "sampleCount:", sampleCount);
  }
}

function scheduleSilence(ctx: AudioContext) {
  // CRITICAL: Don't schedule silence if we're stopping or stopped
  if (isStopping || !loopRunning) {
    return;
  }
  
  if (ctx.state === "suspended") {
    return;
  }
  
  const buffer = ctx.createBuffer(CHANNELS, SAMPLES_PER_FRAME, SAMPLE_RATE);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const now = ctx.currentTime;
  // Use same timing logic as schedulePcm to maintain continuity
  const startTime = Math.max(playheadTime, now + 0.02);
  const dest = lafGain ?? ctx.destination;
  src.connect(dest);
  
  try {
    src.start(startTime);
    playheadTime = startTime + buffer.duration;
  } catch (err) {
    console.error("Failed to start silence:", err);
  }
}

let lastLoopTime = performance.now();
let loopIterations = 0;

async function loop() {
  loopIterations++;
  const now = performance.now();
  const timeSinceLastLoop = now - lastLoopTime;
  lastLoopTime = now;
  
  // Warn if loop is running slowly
  if (timeSinceLastLoop > 100 && loopIterations % 100 === 0) {
    console.warn(`[Loop] Running slowly: ${timeSinceLastLoop.toFixed(0)}ms since last iteration`);
  }
  
  // CRITICAL: Check both loopRunning and isStopping
  if (!loopRunning || isStopping) {
    if (isStopping) {
      console.log("Loop stopped due to fade-out completion");
    } else {
      console.log("Loop stopped");
    }
    return;
  }
  
  if (!audioCtx || !opusDecoder) {
    if (loopRunning) setTimeout(loop, 20);
    return;
  }

  const deltaMs = now - lastStatsTime;
  lastStatsTime = now;

  // Check if current tier has packets, if not try to find a tier that does
  let tierBuf = tiers.get(abrState.currentTier)!;
  let tierToUse = abrState.currentTier;
  
  // CRITICAL: If current tier has no packets available for playback, find ANY tier with packets
  // This prevents silence when ABR switches to a tier that doesn't have packets yet
  const currentTierHasPackets = (tierBuf as any).packets.size > 0 || 
                                 (tierBuf as any).playbackSeq !== null;
  
  if (!currentTierHasPackets) {
    // Try to find ANY tier with packets (check higher tiers first, then lower)
    let foundTier = false;
    
    // First check higher tiers (better quality)
    for (let t = abrState.currentTier + 1; t <= MAX_TIER_ALLOWED; t++) {
      const buf = tiers.get(t);
      if (buf && ((buf as any).packets.size > 0 || (buf as any).playbackSeq !== null)) {
        tierBuf = buf;
        tierToUse = t;
        foundTier = true;
        console.log(`⬆️ Tier ${abrState.currentTier} has no packets, using tier ${t} instead (higher quality)`);
        // Update ABR state to match the tier we're actually using
        abrState.currentTier = t;
        break;
      }
    }
    
    // If no higher tier, check lower tiers
    if (!foundTier) {
      for (let t = abrState.currentTier - 1; t >= MIN_TIER; t--) {
        const buf = tiers.get(t);
        if (buf && ((buf as any).packets.size > 0 || (buf as any).playbackSeq !== null)) {
          tierBuf = buf;
          tierToUse = t;
          foundTier = true;
          console.log(`⬇️ Tier ${abrState.currentTier} has no packets, using tier ${t} instead (lower quality)`);
          // Update ABR state to match the tier we're actually using
          abrState.currentTier = t;
          break;
        }
      }
    }
    
    // If still no tier found, log warning and keep using current tier (will play silence)
    if (!foundTier) {
      console.warn(`[ABR] No tier has packets available! Current tier: ${abrState.currentTier}`);
      for (const [t, buf] of tiers.entries()) {
        console.warn(`  Tier ${t}: packets=${(buf as any).packets.size}, playbackSeq=${(buf as any).playbackSeq}`);
      }
    }
  }
  
  // Buffer underrun protection: if buffer is getting too low during playback, slow down slightly
  const playbackStarted = (tierBuf as any).playbackStartMs !== null && 
                          performance.now() >= (tierBuf as any).playbackStartMs;
  const bufferPackets = (tierBuf as any).packets.size;
  if (playbackStarted && bufferPackets < 5) {
    // Buffer is getting low, this might cause chopping
    // The packet loss concealment will help, but we should log this
    if (bufferPackets === 0 && Math.floor(now / 1000) !== Math.floor((now - deltaMs) / 1000)) {
      console.warn(`[Buffer] Underrun: only ${bufferPackets} packets in buffer`);
    }
  }
  
  // Log buffer state occasionally (before resetWindow is called)
  if (Math.floor(now / 1000) !== Math.floor((now - deltaMs) / 1000)) {
    const stats = tierBuf;
    const playbackSeq = (tierBuf as any).playbackSeq;
    const playbackStartMs = (tierBuf as any).playbackStartMs;
    const packetCount = (tierBuf as any).packets.size;
    console.log(`[Tier ${tierToUse}] Buffer state: ${stats.bufferMs}ms, received: ${stats.receivedCount}, loss: ${stats.lossCount}, lastSeq: ${stats.lastSeq}, playbackSeq: ${playbackSeq}, packets in buffer: ${packetCount}`);
    
    // Also check other tiers
    for (const [tier, buf] of tiers.entries()) {
      if (tier !== tierToUse) {
        const otherPacketCount = (buf as any).packets.size;
        if (otherPacketCount > 0) {
          console.log(`[Tier ${tier}] Has ${otherPacketCount} packets in buffer`);
        }
      }
    }
  }
  
  // CRITICAL: Update ABR state to match the tier we're actually using
  // This prevents ABR from making decisions based on the wrong tier's buffer
  if (tierToUse !== abrState.currentTier) {
    console.log(`[ABR] state updated: ${abrState.currentTier} → ${tierToUse} (using tier with packets)`);
    abrState.currentTier = tierToUse;
  }
  
  // CRITICAL: Schedule multiple packets ahead (lookahead scheduling) for smooth playback
  // This prevents glitches by ensuring we always have audio scheduled ahead
  const nowAudioTime = audioCtx.currentTime;
  const timeUntilPlayhead = playheadTime - nowAudioTime;
  
  // Calculate how many packets we have scheduled ahead
  // Each packet is 20ms, so we need to check how many are scheduled
  const packetsAhead = Math.floor(timeUntilPlayhead / 0.02);
  
  // Schedule packets until we have enough lookahead (5 packets = 100ms)
  while (packetsAhead < LOOKAHEAD_PACKETS || timeUntilPlayhead < 0.1) {
    const pkt = tierBuf.popForPlayback(now);

    if (!pkt) {
      abrState.consecutiveLateOrMissing++;
      lossCountWindow++;
      
      // Check if other tiers have packets we could use
      let alternativeTier: number | null = null;
      for (const [t, buf] of tiers.entries()) {
        if (t !== tierToUse && ((buf as any).packets.size > 0 || (buf as any).playbackSeq !== null)) {
          alternativeTier = t;
          break;
        }
      }
      
      // Log missing packets more frequently to detect issues
      if (lossCountWindow === 1 || lossCountWindow % 5 === 0) {
        const bufferPackets = (tierBuf as any).packets.size;
        const lastSeq = tierBuf.lastSeq;
        const playbackSeq = (tierBuf as any).playbackSeq;
        if (alternativeTier) {
          const altBuf = tiers.get(alternativeTier)!;
          console.warn(`[ABR] Missing packet on tier ${tierToUse}: buffer=${bufferPackets}, playbackSeq=${playbackSeq}, but tier ${alternativeTier} has ${(altBuf as any).packets.size} packets - should switch!`);
        } else {
          console.warn(`[ABR] Missing packet on tier ${tierToUse}: buffer=${bufferPackets}, lastSeq=${lastSeq}, playbackSeq=${playbackSeq}, no alternative tiers available`);
        }
      }
      scheduleSilence(audioCtx);
      break; // Can't schedule more if no packets available
    } else {
    const isConcealed = (pkt as any).concealed === true;
    // Log first few packets to verify they're being processed
    if (pkt.seq <= 5 || (pkt.seq > 0 && pkt.seq % 100 === 0)) {
      console.log("[Process] packet:", { seq: pkt.seq, tier: pkt.tier, payloadSize: pkt.opusPayload.length, concealed: isConcealed });
    }
    abrState.consecutiveLateOrMissing = 0;
    try {
      // Try to decode as Opus first
      const decoded = await opusDecoder.decode(pkt.opusPayload);
      // opus-decoder returns Float32Array[] (one per channel)
      schedulePcm(audioCtx, decoded[0], isConcealed);
    } catch (err) {
      // If Opus decode fails, try to handle as raw PCM (Int16)
      // Only log first failure to reduce spam
      if (pkt.seq === 1 || pkt.seq % 100 === 0) {
        console.log("Opus decode failed, trying raw PCM (payload size:", pkt.opusPayload.length, ")");
      }
      try {
        // The broadcaster may send Int16 PCM (2 bytes per sample) or Int8 PCM (1 byte per sample)
        const byteLength = pkt.opusPayload.length;
        
        // Check if it's 8-bit PCM (1 byte per sample) or 16-bit PCM (2 bytes per sample)
        // 8-bit: 960 bytes for 20ms at 48kHz, 16-bit: 1920 bytes
        const is8Bit = byteLength === SAMPLES_PER_FRAME || (byteLength < SAMPLES_PER_FRAME * 1.5);
        
        let pcmFloat: Float32Array;
        
        if (is8Bit) {
          // 8-bit PCM: convert from Uint8 (0-255) to Float32 (-1.0 to 1.0)
          const sampleCount = byteLength;
          pcmFloat = new Float32Array(sampleCount);
          for (let i = 0; i < sampleCount; i++) {
            // Convert: 0 -> -1.0, 128 -> 0.0, 255 -> 1.0
            pcmFloat[i] = (pkt.opusPayload[i] - 128) / 127.5;
          }
        } else {
          // 16-bit PCM: convert from Int16Array
          if (byteLength % 2 !== 0) {
            console.warn("Odd byte length for 16-bit PCM:", byteLength);
            scheduleSilence(audioCtx);
            return;
          }
          
          const sampleCount = byteLength / 2;
          const pcm16 = new Int16Array(pkt.opusPayload.buffer, pkt.opusPayload.byteOffset, sampleCount);
          
          // Convert Int16 to Float32 (-1.0 to 1.0)
          pcmFloat = new Float32Array(sampleCount);
          for (let i = 0; i < sampleCount; i++) {
            const normalized = pcm16[i] / (pcm16[i] < 0 ? 0x8000 : 0x7fff);
            pcmFloat[i] = Math.max(-1, Math.min(1, normalized));
          }
        }
        
        let maxSample = 0;
        for (let i = 0; i < pcmFloat.length; i++) {
          maxSample = Math.max(maxSample, Math.abs(pcmFloat[i]));
        }
        
        // Only log occasionally
        if (pkt.seq <= 10 || pkt.seq % 100 === 0) {
          console.log("Decoded raw PCM:", pcmFloat.length, "samples,", is8Bit ? "8-bit" : "16-bit", "max amplitude:", maxSample.toFixed(3));
        }
        
        // Check if we have actual audio data (not silence)
        if (maxSample < 0.001 && pkt.seq % 50 === 0) {
          console.warn("[Audio] Very quiet audio detected (max:", maxSample.toFixed(4), "), might be silence or mic issue");
        }
        
        schedulePcm(audioCtx, pcmFloat, isConcealed);
      } catch (pcmErr) {
        console.error("Failed to decode raw PCM:", pcmErr);
        scheduleSilence(audioCtx);
      }
    }
    
    // Recalculate lookahead after scheduling this packet
    const newTimeUntilPlayhead = playheadTime - audioCtx.currentTime;
    const newPacketsAhead = Math.floor(newTimeUntilPlayhead / 0.02);
    
    // If we have enough lookahead, break out of scheduling loop
    if (newPacketsAhead >= LOOKAHEAD_PACKETS && newTimeUntilPlayhead >= 0.1) {
      break;
    }
    // Otherwise continue scheduling more packets
    }
  }

  const stats = tierBuf;
  // Only accumulate stats if we've actually received packets
  if (stats.receivedCount > 0 || stats.lossCount > 0) {
    recvCountWindow += stats.receivedCount;
    lossCountWindow += stats.lossCount;
    lateCountWindow += stats.lateCount;
  }
  stats.resetWindow();

  const total = recvCountWindow + lossCountWindow;
  const lossPercent = total === 0 ? 0 : (lossCountWindow / total) * 100;
  const lateRate = total === 0 ? 0 : lateCountWindow / total;

  // CRITICAL: Sync ABR state with the tier we're actually using
  // This prevents ABR from making decisions based on wrong tier's buffer
  if (tierToUse !== abrState.currentTier) {
    console.log(`[ABR] Syncing state: ${abrState.currentTier} → ${tierToUse} (using tier with packets)`);
    abrState.currentTier = tierToUse;
  }
  
  const oldTier = abrState.currentTier;
  abrState = updateAbr(abrState, {
    lossPercent2s: lossPercent,
    bufferMs: stats.bufferMs, // This is from tierToUse's buffer (the tier we're actually playing)
    lateRate,
    deltaMs
  }, tierBuf, tiers);
  
  // Log tier changes
  if (abrState.currentTier !== oldTier) {
    console.log(`[ABR] tier changed: ${oldTier} → ${abrState.currentTier}`);
  }
  
  // After ABR update, if ABR switched to a tier without packets, revert to tier with packets
  if (abrState.currentTier !== tierToUse) {
    const newTierBuf = tiers.get(abrState.currentTier);
    const newTierHasPackets = newTierBuf && ((newTierBuf as any).packets.size > 0 || (newTierBuf as any).playbackSeq !== null);
    if (!newTierHasPackets) {
      console.warn(`[ABR] Switched to tier ${abrState.currentTier} but it has no packets, reverting to tier ${tierToUse}`);
      abrState.currentTier = tierToUse;
    }
  }

  if (Math.floor(now / 1000) !== Math.floor((now - deltaMs) / 1000)) {
    const estLatencyMs = stats.bufferMs;
    statTier.textContent = String(abrState.currentTier);
    statLoss.textContent = `${lossPercent.toFixed(1)}%`;
    statBuffer.textContent = `${stats.bufferMs.toFixed(0)}ms`;
    statLate.textContent = lateRate.toFixed(2);
    statLatency.textContent = `${estLatencyMs.toFixed(0)}ms`;
    statKbps.textContent = `${(SAMPLE_RATE / SAMPLES_PER_FRAME) * 1 * 8 / 1000 | 0}kbps`;

    lossCountWindow = 0;
    recvCountWindow = 0;
    lateCountWindow = 0;
  }

  // Schedule next iteration (approximately 20ms for 20ms audio frames)
  // Use requestAnimationFrame for more precise timing, but throttle to ~20ms
  // CRITICAL: Check both loopRunning and isStopping to prevent loop after fade-out
  if (loopRunning && !isStopping) {
    // Use a more precise timing mechanism
    const nextFrameTime = now + 18; // Slightly less than 20ms to account for processing time
    const delay = Math.max(0, nextFrameTime - performance.now());
    setTimeout(loop, Math.min(delay, 20));
  } else if (isStopping) {
    // Fade-out complete, stop the loop gracefully
    console.log("[Loop] Stopping due to fade-out completion");
    loopRunning = false;
  }
}

function updatePlayerStatus(status: "ready" | "playing" | "stopped", message: string) {
  playerStatus.className = `status ${status}`;
  playerSection.classList.toggle("is-playing", status === "playing");
  if (status === "playing") {
    playerStatusIcon.textContent = "";
    playerStatusText.textContent = message;
  } else if (status === "stopped") {
    playerStatusIcon.textContent = "";
    playerStatusText.textContent = message;
  } else {
    playerStatusIcon.textContent = "";
    playerStatusText.textContent = message;
  }
}

function stopListening() {
  console.log("[Stop] Stopping listening and cleaning up...");
  
  // CRITICAL: Set stopping flag FIRST to prevent any new audio scheduling
  isStopping = true;
  
  // Reset fade out state
  fadeOutStartTime = null;
  (window as any).lastShownCountdown = null; // Reset countdown tracker
  
  // Stop the loop to prevent any new audio processing
  loopRunning = false;
  
  // CRITICAL: Clear all jitter buffers IMMEDIATELY to prevent processing old packets
  // This must happen before suspending AudioContext to prevent glitchy sounds
  for (const [tier, buf] of tiers.entries()) {
    buf.reset(); // Use the reset method to clean up all state
  }
  console.log("[Stop] Jitter buffers cleared");
  
  // Close WebSocket
  if (ws) {
    // Clean up message monitor
    if ((ws as any).messageMonitor) {
      clearInterval((ws as any).messageMonitor);
    }
    // Close gracefully
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close(1000, "Client stopping");
    }
    ws = null;
  }
  
  // CRITICAL: Stop audio gracefully to prevent glitching
  // Suspend AudioContext immediately - this stops all scheduled audio
  // Buffers are already cleared, so no new audio will be processed
  if (audioCtx && audioCtx.state === "running") {
    try {
      audioCtx.suspend();
      console.log("[Stop] AudioContext suspended");
    } catch (err) {
      console.warn("[Error] Suspending AudioContext:", err);
    }
  }
  
  // Reset playheadTime - CRITICAL: reset audio scheduling
  if (audioCtx) {
    playheadTime = audioCtx.currentTime;
  } else {
    playheadTime = 0;
  }
  
  // Reset ABR state to initial values
  abrState = {
    currentTier: START_TIER,
    minTier: MIN_TIER,
    maxTierAllowed: MAX_TIER_ALLOWED,
    stableMs: 0,
    consecutiveLateOrMissing: 0
  };
  
  // Reset window counters
  lossCountWindow = 0;
  recvCountWindow = 0;
  lateCountWindow = 0;
  lastStatsTime = performance.now();
  lastLoopTime = performance.now();
  
  if (lafGain) {
    try { lafGain.disconnect(); } catch (_) {}
    lafGain = null;
  }

  // Reset stopping flag after a brief delay to ensure all audio has stopped
  setTimeout(() => {
    isStopping = false;
  }, 100);
  
  console.log("[Cleanup] Complete - state reset, audio stopped");
  updatePlayerStatus("stopped", "Stream ended");
  btnStart.disabled = false;
  btnStart.classList.remove("hidden");
  btnStop.classList.add("hidden");
  playerLiveBadge.classList.add("hidden");
  playIcon.textContent = "\u25B6";
  playText.textContent = "Start";
}

btnStart.onclick = () => {
  if (!currentChannel) return;
  playIcon.textContent = "\u25B6";
  playText.textContent = "Connecting...";
  btnStart.disabled = true;
  updatePlayerStatus("ready", "Connecting...");
  startListening().catch((e) => {
    console.error("Failed to start listening:", e);
    alert(`Failed to start: ${e.message}`);
    updatePlayerStatus("stopped", `Error: ${e.message}`);
    btnStart.disabled = false;
    playIcon.textContent = "\u25B6";
    playText.textContent = "Start";
  });
};

btnStop.onclick = () => {
  if (currentExternalStation) {
    stopExternalStream();
    return;
  }
  stopListening();
};

btnPrevStation.onclick = () => {
  if (!currentExternalStation || EXTERNAL_STATIONS.length === 0) return;
  const idx = EXTERNAL_STATIONS.findIndex((s) => s.streamUrl === currentExternalStation.streamUrl);
  const prevIdx = (idx - 1 + EXTERNAL_STATIONS.length) % EXTERNAL_STATIONS.length;
  selectExternalStation(EXTERNAL_STATIONS[prevIdx]);
};

btnNextStation.onclick = () => {
  if (!currentExternalStation || EXTERNAL_STATIONS.length === 0) return;
  const idx = EXTERNAL_STATIONS.findIndex((s) => s.streamUrl === currentExternalStation.streamUrl);
  const nextIdx = (idx + 1) % EXTERNAL_STATIONS.length;
  selectExternalStation(EXTERNAL_STATIONS[nextIdx]);
};

function sendChatMessage() {
  if (!ws || ws.readyState !== WebSocket.OPEN || !token) return;
  const text = (chatInput.value || "").trim();
  if (!text) return;
  try {
    ws.send(JSON.stringify({ type: "chat", text }));
    chatInput.value = "";
  } catch (err) {
    console.error("Failed to send chat:", err);
  }
}

chatSendBtn.onclick = sendChatMessage;
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    sendChatMessage();
  }
});

async function apiCall(endpoint: string, options: RequestInit = {}): Promise<any> {
  const url = `${API_URL}${endpoint}`;
  const headers: HeadersInit = { "Content-Type": "application/json", ...options.headers };
  if (token) {
    (headers as Record<string, string>)["Authorization"] = `Bearer ${token}`;
  }
  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

const authOverlay = document.getElementById("auth-overlay")!;
const authTabLogin = document.getElementById("auth-tab-login")!;
const authTabRegister = document.getElementById("auth-tab-register")!;
const authLoginForm = document.getElementById("auth-login-form")!;
const authRegisterForm = document.getElementById("auth-register-form")!;
const authLoginEmail = document.getElementById("auth-login-email")! as HTMLInputElement;
const authLoginPassword = document.getElementById("auth-login-password")! as HTMLInputElement;
const authRegisterEmail = document.getElementById("auth-register-email")! as HTMLInputElement;
const authRegisterPassword = document.getElementById("auth-register-password")! as HTMLInputElement;
const authError = document.getElementById("auth-error")!;
const authLoginBtn = document.getElementById("auth-login-btn")!;
const authRegisterBtn = document.getElementById("auth-register-btn")!;
const authClose = document.getElementById("auth-close")!;

function showAuthError(msg: string) {
  authError.textContent = msg;
  authError.classList.remove("hidden");
}
function hideAuthError() {
  authError.classList.add("hidden");
}

authTabLogin.onclick = () => {
  authTabLogin.classList.add("active");
  authTabRegister.classList.remove("active");
  authLoginForm.classList.remove("hidden");
  authRegisterForm.classList.add("hidden");
  hideAuthError();
};
authTabRegister.onclick = () => {
  authTabRegister.classList.add("active");
  authTabLogin.classList.remove("active");
  authRegisterForm.classList.remove("hidden");
  authLoginForm.classList.add("hidden");
  hideAuthError();
};

authLoginBtn.onclick = async () => {
  hideAuthError();
  const email = authLoginEmail.value.trim();
  const password = authLoginPassword.value;
  if (!email || !password) {
    showAuthError("Email and password required");
    return;
  }
  try {
    const result = await fetch(`${API_URL}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!result.ok) {
      const err = await result.json().catch(() => ({}));
      showAuthError(err.error || "Login failed");
      return;
    }
    const data = await result.json();
    token = data.token;
    userEmail = data.user?.email ?? null;
    if (token) localStorage.setItem("laf_token", token);
    if (userEmail) localStorage.setItem("laf_user_email", userEmail);
    updateTopBarAuth();
    authOverlay.classList.remove("visible");
  } catch (err: any) {
    showAuthError(err.message || "Network error");
  }
};

authRegisterBtn.onclick = async () => {
  hideAuthError();
  const email = authRegisterEmail.value.trim();
  const password = authRegisterPassword.value;
  if (!email || !password) {
    showAuthError("Email and password required");
    return;
  }
  try {
    const result = await fetch(`${API_URL}/api/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!result.ok) {
      const err = await result.json().catch(() => ({}));
      showAuthError(err.error || "Registration failed");
      return;
    }
    const data = await result.json();
    token = data.token;
    userEmail = data.user?.email ?? null;
    if (token) localStorage.setItem("laf_token", token);
    if (userEmail) localStorage.setItem("laf_user_email", userEmail);
    updateTopBarAuth();
    authOverlay.classList.remove("visible");
  } catch (err: any) {
    showAuthError(err.message || "Network error");
  }
};

authClose.onclick = () => authOverlay.classList.remove("visible");
document.getElementById("client-signin-link")!.addEventListener("click", (e) => {
  e.preventDefault();
  authOverlay.classList.add("visible");
});
document.getElementById("client-logout-btn")!.onclick = () => {
  token = null;
  userEmail = null;
  localStorage.removeItem("laf_token");
  localStorage.removeItem("laf_user_email");
  updateTopBarAuth();
};

// Load runtime config (API/relay URLs from /config.json) then start
window.addEventListener("window-closed", ((e: CustomEvent<{ windowId: string }>) => {
  if (e.detail?.windowId !== "player") return;
  stopExternalStream();
  stopListening();
}) as EventListener);

loadRuntimeConfig().then(() => {
  updateTopBarAuth();
  loadChannels();
  setInterval(loadChannels, 3000);
});
