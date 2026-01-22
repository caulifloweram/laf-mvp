import { OpusDecoder } from "opus-decoder";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:4000";
const RELAY_BASE = import.meta.env.VITE_LAF_RELAY_URL || "ws://localhost:9000";

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
  streamId: number;
}

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
        console.warn(`⚠️ Buffer overflow: removed ${packetsToRemove.length} old packets (buffer was ${this.packets.size + packetsToRemove.length}, max: ${this.maxBufferPackets})`);
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
      console.log(`✅ Buffer ready: ${this.packets.size} packets, playback starts in ${this.targetDelayMs}ms`);
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
            console.warn(`🔇 Concealing missing packet seq ${expectedSeq} (using last packet), buffer has ${this.packets.size} packets`);
          } else {
            console.warn(`🔇 Concealing missing packet seq ${expectedSeq} (using last packet), buffer is empty`);
          }
        }
      } else {
        // No last packet to conceal with
        if (this.lossCount === 1 || this.lossCount % 50 === 0) {
          const availableSeqs = Array.from(this.packets.keys()).sort((a, b) => a - b);
          if (availableSeqs.length > 0) {
            console.warn(`❌ Missing packet seq ${expectedSeq}, buffer has ${this.packets.size} packets, earliest: ${availableSeqs[0]}, latest: ${availableSeqs[availableSeqs.length - 1]}`);
          } else {
            console.warn(`❌ Missing packet seq ${expectedSeq}, buffer is empty`);
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
      console.warn(`⚠️ ABR wanted to downgrade to tier ${newTier} but it has no packets, staying on tier ${oldTier}`);
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

let ws: WebSocket | null = null;
let audioCtx: AudioContext | null = null;
let opusDecoder: OpusDecoder | null = null;

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
let playheadTime = 0;
let loopRunning = false;
const LOOKAHEAD_PACKETS = 10; // Schedule 10 packets (200ms) ahead for smooth playback - increased for better stability

async function loadChannels() {
  try {
    const url = `${API_URL}/api/channels/live`;
    console.log(`[loadChannels] Fetching live channels from ${url}`);
    console.log(`[loadChannels] API_URL is: ${API_URL}`);
    
    const res = await fetch(url, {
      cache: "no-cache",
      headers: {
        "Cache-Control": "no-cache",
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
        playIcon.textContent = "▶️";
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
      card.innerHTML = `
        <div class="channel-title">${escapeHtml(c.title || "Untitled")}</div>
        <div class="channel-desc">${escapeHtml(c.description || "")}</div>
        <span class="live-badge">LIVE</span>
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
      playIcon.textContent = "▶️";
      playText.textContent = "Start";
      currentChannel = null;
    }
  } catch (err: any) {
    console.error("[loadChannels] Exception caught:", err);
    console.error("[loadChannels] Error details:", err.message, err.stack);
    channelsGrid.innerHTML = `<p style='opacity: 0.7; color: #ef4444;'>Error: ${err.message || "Failed to load channels"}</p>`;
  }
}

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function selectChannel(channel: LiveChannel) {
  currentChannel = channel;
  nowPlayingTitle.textContent = channel.title;
  nowPlayingDesc.textContent = channel.description || "";
  playerSection.classList.remove("hidden");
  if (ws) {
    loopRunning = false; // Stop loop
    ws.close();
    ws = null;
  }
}

async function startListening() {
  if (!currentChannel) return;
  btnStart.disabled = true;

  console.log("▶️ Starting listening - initializing fresh state...");
  
  // CRITICAL: Ensure all state is reset before starting
  // Reset playheadTime to current time (fresh start)
  if (!audioCtx) {
    audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
    // Resume audio context if suspended (browser autoplay policy)
    if (audioCtx.state === "suspended") {
      await audioCtx.resume();
      console.log("Audio context resumed");
    }
    playheadTime = audioCtx.currentTime;
  } else {
    // Reset playheadTime to current time for fresh start
    if (audioCtx.state === "suspended") {
      await audioCtx.resume();
      console.log("Audio context resumed");
    }
    playheadTime = audioCtx.currentTime;
  }
  
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

  const wsUrl = `${RELAY_BASE}/?role=listener&streamId=${currentChannel.streamId}`;
  console.log("Connecting to relay:", wsUrl);
  console.log("Current ABR tier:", abrState.currentTier);
  console.log("Available tiers:", Array.from(tiers.keys()));
  
  ws = new WebSocket(wsUrl);
  ws.binaryType = "arraybuffer";

  ws.onopen = async () => {
    console.log("✅ WebSocket connected to relay");
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
    updatePlayerStatus("playing", "🔴 Listening live");
    btnStart.classList.add("hidden");
    btnStop.classList.remove("hidden");
    playerLiveBadge.classList.remove("hidden");
  };

  ws.onerror = (err) => {
    console.error("WebSocket error:", err);
  };

  ws.onclose = (event) => {
    console.log("WebSocket disconnected:", event.code, event.reason || "No reason");
    console.log(`   Total messages received: ${messageCount}, last seq: ${lastLoggedSeq}`);
    
    // Clean up message monitor
    if ((ws as any).messageMonitor) {
      clearInterval((ws as any).messageMonitor);
    }
    
    loopRunning = false; // Stop the loop
    updatePlayerStatus("stopped", "Disconnected");
    btnStart.disabled = false;
    btnStart.classList.remove("hidden");
    btnStop.classList.add("hidden");
    playerLiveBadge.classList.add("hidden");
    playIcon.textContent = "▶️";
    playText.textContent = "Reconnect";
  };

  let lastMessageTime = performance.now();
  let messageCount = 0;
  let lastLoggedSeq = 0;
  
  // Monitor message reception to detect when they stop
  const messageMonitor = setInterval(() => {
    const timeSinceLastMessage = performance.now() - lastMessageTime;
    if (timeSinceLastMessage > 2000 && ws && ws.readyState === WebSocket.OPEN) {
      console.warn(`⚠️ No messages received for ${timeSinceLastMessage.toFixed(0)}ms, WebSocket state: ${ws.readyState}`);
      console.warn(`   Last message count: ${messageCount}, last seq: ${lastLoggedSeq}`);
    }
  }, 2000);
  
  ws.onmessage = (ev) => {
    lastMessageTime = performance.now();
    messageCount++;
    
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
      console.log("🎵 First packet received!", { tier: pkt.tier, seq: pkt.seq, streamId: pkt.streamId });
    }
    
    const buf = tiers.get(pkt.tier);
    if (!buf) {
      console.warn("❌ Unknown tier:", pkt.tier, "available tiers:", Array.from(tiers.keys()));
      return;
    }
    
    const beforePush = buf.receivedCount;
    const playbackSeqBefore = (buf as any).playbackSeq;
    buf.push(pkt);
    const playbackSeqAfter = (buf as any).playbackSeq;
    
    // Log initialization
    if (playbackSeqBefore === null && playbackSeqAfter !== null) {
      console.log("✅ Jitter buffer initialized! playbackSeq:", playbackSeqAfter, "playback starts in 1000ms (1s delay for smooth streaming)");
    }
    
    // Log first few packets and periodically
    if (pkt.seq <= 5 || pkt.seq % 50 === 0 || beforePush === 0) {
      console.log("📦 Pushed packet to tier", pkt.tier, ":", { 
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
    
    // If this is a concealed packet (packet loss), fade it out to reduce artifacts
    if (isConcealed) {
      const fadeLength = Math.min(sampleCount / 4, 240); // Fade last 25% or 5ms, whichever is smaller
      const fadeStart = sampleCount - fadeLength;
      for (let i = 0; i < sampleCount; i++) {
        if (i >= fadeStart) {
          const fadeFactor = 1 - ((i - fadeStart) / fadeLength);
          channelData[i] = pcm[i] * fadeFactor;
        } else {
          channelData[i] = pcm[i];
        }
      }
    } else {
      channelData.set(pcm);
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
    src.connect(ctx.destination);
    
    src.start(targetTime);
    // Update playheadTime for next packet (continuous scheduling)
    playheadTime = targetTime + buffer.duration;
  } catch (err) {
    console.error("Failed to schedule PCM:", err, "sampleCount:", sampleCount);
  }
}

function scheduleSilence(ctx: AudioContext) {
  if (ctx.state === "suspended") {
    return;
  }
  
  const buffer = ctx.createBuffer(CHANNELS, SAMPLES_PER_FRAME, SAMPLE_RATE);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const now = ctx.currentTime;
  // Use same timing logic as schedulePcm to maintain continuity
  const startTime = Math.max(playheadTime, now + 0.02);
  src.connect(ctx.destination);
  
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
    console.warn(`⚠️ Loop running slowly: ${timeSinceLastLoop.toFixed(0)}ms since last iteration`);
  }
  
  if (!loopRunning) {
    console.log("Loop stopped");
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
      console.warn(`⚠️ No tier has packets available! Current tier: ${abrState.currentTier}`);
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
      console.warn(`⚠️ Buffer underrun: only ${bufferPackets} packets in buffer`);
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
    console.log(`🔄 ABR state updated: ${abrState.currentTier} → ${tierToUse} (using tier with packets)`);
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
          console.warn(`⚠️ Missing packet on tier ${tierToUse}: buffer=${bufferPackets}, playbackSeq=${playbackSeq}, but tier ${alternativeTier} has ${(altBuf as any).packets.size} packets - should switch!`);
        } else {
          console.warn(`⚠️ Missing packet on tier ${tierToUse}: buffer=${bufferPackets}, lastSeq=${lastSeq}, playbackSeq=${playbackSeq}, no alternative tiers available`);
        }
      }
      scheduleSilence(audioCtx);
      break; // Can't schedule more if no packets available
    } else {
    const isConcealed = (pkt as any).concealed === true;
    // Log first few packets to verify they're being processed
    if (pkt.seq <= 5 || (pkt.seq > 0 && pkt.seq % 100 === 0)) {
      console.log("🎵 Processing packet:", { seq: pkt.seq, tier: pkt.tier, payloadSize: pkt.opusPayload.length, concealed: isConcealed });
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
          console.warn("⚠️ Very quiet audio detected (max:", maxSample.toFixed(4), "), might be silence or mic issue");
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
    console.log(`🔄 Syncing ABR state: ${abrState.currentTier} → ${tierToUse} (using tier with packets)`);
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
    console.log(`🔄 ABR tier changed: ${oldTier} → ${abrState.currentTier}`);
  }
  
  // After ABR update, if ABR switched to a tier without packets, revert to tier with packets
  if (abrState.currentTier !== tierToUse) {
    const newTierBuf = tiers.get(abrState.currentTier);
    const newTierHasPackets = newTierBuf && ((newTierBuf as any).packets.size > 0 || (newTierBuf as any).playbackSeq !== null);
    if (!newTierHasPackets) {
      console.warn(`⚠️ ABR switched to tier ${abrState.currentTier} but it has no packets, reverting to tier ${tierToUse}`);
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
  if (loopRunning) {
    // Use a more precise timing mechanism
    const nextFrameTime = now + 18; // Slightly less than 20ms to account for processing time
    const delay = Math.max(0, nextFrameTime - performance.now());
    setTimeout(loop, Math.min(delay, 20));
  }
}

function updatePlayerStatus(status: "ready" | "playing" | "stopped", message: string) {
  playerStatus.className = `status ${status}`;
  if (status === "playing") {
    playerStatusIcon.textContent = "🔴";
    playerStatusText.textContent = message;
  } else if (status === "stopped") {
    playerStatusIcon.textContent = "⏹️";
    playerStatusText.textContent = message;
  } else {
    playerStatusIcon.textContent = "⏸️";
    playerStatusText.textContent = message;
  }
}

function stopListening() {
  console.log("🛑 Stopping listening and cleaning up...");
  
  // Stop the loop first
  loopRunning = false;
  
  // Close WebSocket
  if (ws) {
    // Clean up message monitor
    if ((ws as any).messageMonitor) {
      clearInterval((ws as any).messageMonitor);
    }
    ws.close();
    ws = null;
  }
  
  // Reset all jitter buffers - CRITICAL: clear old packets
  for (const [tier, buf] of tiers.entries()) {
    buf.reset(); // Use the reset method to clean up all state
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
  
  // Suspend AudioContext (but don't close it - we'll reuse it)
  if (audioCtx && audioCtx.state !== "closed") {
    audioCtx.suspend();
  }
  
  console.log("✅ Cleanup complete - all state reset");
  updatePlayerStatus("stopped", "Stopped");
  btnStart.disabled = false;
  btnStart.classList.remove("hidden");
  btnStop.classList.add("hidden");
  playerLiveBadge.classList.add("hidden");
  playIcon.textContent = "▶️";
  playText.textContent = "Start";
}

btnStart.onclick = () => {
  if (!currentChannel) return;
  playIcon.textContent = "⏳";
  playText.textContent = "Connecting...";
  btnStart.disabled = true;
  updatePlayerStatus("ready", "Connecting...");
  startListening().catch((e) => {
    console.error("Failed to start listening:", e);
    alert(`Failed to start: ${e.message}`);
    updatePlayerStatus("stopped", `Error: ${e.message}`);
    btnStart.disabled = false;
    playIcon.textContent = "▶️";
    playText.textContent = "Start";
  });
};

btnStop.onclick = () => {
  if (confirm("Stop listening to this stream?")) {
    stopListening();
  }
};

// Load channels on startup and refresh every 3s (more frequent to catch stream stops)
loadChannels();
setInterval(loadChannels, 3000);
