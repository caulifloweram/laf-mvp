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
  private packets = new Map<number, LAFPacket>();
  private playbackSeq: number | null = null;
  private startPtsMs: bigint | null = null;
  private playbackStartMs: number | null = null;

  lossCount = 0;
  receivedCount = 0;
  lateCount = 0;
  lastSeq: number | null = null;
  bufferMs = 0;

  constructor(targetDelayMs = 300) {
    this.targetDelayMs = targetDelayMs;
  }

  push(pkt: LAFPacket) {
    this.packets.set(pkt.seq, pkt);
    this.receivedCount++;
    this.lastSeq = pkt.seq;

    if (this.startPtsMs == null) {
      this.startPtsMs = pkt.ptsMs;
      // Start playback from this packet after the delay
      this.playbackSeq = pkt.seq;
      this.playbackStartMs = performance.now() + this.targetDelayMs;
      const startTime = new Date(Date.now() + this.targetDelayMs).toISOString();
      console.log(`Jitter buffer initialized: seq=${pkt.seq}, playback starts in ${this.targetDelayMs}ms`);
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
      // Look for a packet that's close to expected (within 10 packets = 200ms)
      for (const seq of availableSeqs) {
        if (seq >= expectedSeq && seq <= expectedSeq + 10) {
          pkt = this.packets.get(seq)!;
          this.playbackSeq = seq + 1;
          if (seq !== expectedSeq) {
            console.log(`⏭️ Skipped to packet seq ${seq} (expected ${expectedSeq}, gap: ${seq - expectedSeq})`);
          }
          break;
        }
      }
    }

    if (!pkt) {
      this.lossCount++;
      this.updateBuffer();
      // Only log occasionally to reduce spam
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

    this.packets.delete(pkt.seq);
    this.updateBuffer();
    return pkt;
  }

  resetWindow() {
    this.lossCount = 0;
    this.receivedCount = 0;
    this.lateCount = 0;
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

function updateAbr(state: AbrState, inputs: AbrInputs, tierBuf: JitterBuffer): AbrState {
  const next = { ...state };
  next.stableMs += inputs.deltaMs;

  // Check if current tier has packets in buffer
  const hasPackets = (tierBuf as any).packets.size > 0;
  const bufferInitialized = (tierBuf as any).playbackSeq !== null;
  const playbackStarted = (tierBuf as any).playbackStartMs !== null && 
                          performance.now() >= (tierBuf as any).playbackStartMs;

  // Don't downgrade if:
  // 1. Current tier has packets in buffer AND buffer is initialized
  // 2. OR playback hasn't started yet (still in initial delay)
  const shouldDown =
    (inputs.lossPercent2s > 5 ||
     (inputs.bufferMs < 80 && playbackStarted) ||
     (next.consecutiveLateOrMissing >= 3 && playbackStarted)) &&
    // Don't downgrade if current tier has packets and is initialized
    !(hasPackets && bufferInitialized) &&
    // Don't downgrade during initial delay
    playbackStarted;

  if (shouldDown) {
    const oldTier = next.currentTier;
    next.currentTier = Math.max(next.currentTier - 1, next.minTier);
    if (oldTier !== next.currentTier) {
      console.log(`⬇️ ABR downgrading: ${oldTier} → ${next.currentTier} (loss: ${inputs.lossPercent2s.toFixed(1)}%, buffer: ${inputs.bufferMs}ms, missing: ${next.consecutiveLateOrMissing})`);
    }
    next.stableMs = 0;
    next.consecutiveLateOrMissing = 0;
    return next;
  }

  const canUp =
    next.stableMs >= 15_000 && inputs.lossPercent2s < 1 && inputs.bufferMs > 250;

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
for (let t = MIN_TIER; t <= MAX_TIER_ALLOWED; t++) {
  tiers.set(t, new JitterBuffer(300));
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

async function loadChannels() {
  try {
    const res = await fetch(`${API_URL}/api/channels/live`, {
      cache: "no-cache",
      headers: {
        "Cache-Control": "no-cache"
      }
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    const channels: LiveChannel[] = await res.json();
    console.log(`Loaded ${channels.length} live channels`);
    
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
      const card = document.createElement("div");
      card.className = "channel-card";
      card.innerHTML = `
        <div class="channel-title">${escapeHtml(c.title)}</div>
        <div class="channel-desc">${escapeHtml(c.description || "")}</div>
        <span class="live-badge">LIVE</span>
      `;
      card.onclick = () => selectChannel(c);
      channelsGrid.appendChild(card);
    });
    
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
  } catch (err) {
    console.error("Failed to load channels:", err);
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

  if (!audioCtx) {
    audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
    // Resume audio context if suspended (browser autoplay policy)
    if (audioCtx.state === "suspended") {
      await audioCtx.resume();
      console.log("Audio context resumed");
    }
    playheadTime = audioCtx.currentTime;
  } else if (audioCtx.state === "suspended") {
    await audioCtx.resume();
    console.log("Audio context resumed");
  }
  
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
    loopRunning = false; // Stop the loop
    updatePlayerStatus("stopped", "Disconnected");
    btnStart.disabled = false;
    btnStart.classList.remove("hidden");
    btnStop.classList.add("hidden");
    playerLiveBadge.classList.add("hidden");
    playIcon.textContent = "▶️";
    playText.textContent = "Reconnect";
  };

  ws.onmessage = (ev) => {
    if (!(ev.data instanceof ArrayBuffer)) {
      console.warn("Received non-ArrayBuffer message");
      return;
    }
    
    const pkt = decodeLAF(ev.data);
    if (!pkt) {
      console.warn("Failed to decode LAF packet, data size:", ev.data.byteLength);
      return;
    }
    
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
      console.log("✅ Jitter buffer initialized! playbackSeq:", playbackSeqAfter, "playback starts in 300ms");
    }
    
    // Log first few packets and periodically
    if (pkt.seq <= 5 || pkt.seq % 50 === 0 || beforePush === 0) {
      console.log("📦 Pushed packet to tier", pkt.tier, ":", { 
        seq: pkt.seq, 
        payloadSize: pkt.opusPayload.length, 
        receivedCount: buf.receivedCount,
        bufferSize: (buf as any).packets.size
      });
    }
  };

  // Loop will be started when WebSocket opens
}

function schedulePcm(ctx: AudioContext, pcm: Float32Array) {
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
    channelData.set(pcm);
    
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    
    // Schedule slightly ahead to avoid gaps
    const now = ctx.currentTime;
    const startTime = Math.max(playheadTime, now + 0.01);
    src.connect(ctx.destination);
    
    src.start(startTime);
    playheadTime = startTime + buffer.duration;
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
  const startTime = Math.max(playheadTime, now + 0.01);
  src.connect(ctx.destination);
  
  try {
    src.start(startTime);
    playheadTime = startTime + buffer.duration;
  } catch (err) {
    console.error("Failed to start silence:", err);
  }
}

async function loop() {
  if (!loopRunning) {
    console.log("Loop stopped");
    return;
  }
  
  if (!audioCtx || !opusDecoder) {
    if (loopRunning) setTimeout(loop, 20);
    return;
  }

  const now = performance.now();
  const deltaMs = now - lastStatsTime;
  lastStatsTime = now;

  // Check if current tier has packets, if not try to find a tier that does
  let tierBuf = tiers.get(abrState.currentTier)!;
  let tierToUse = abrState.currentTier;
  
  // If current tier has no packets, check if a lower tier has packets
  if ((tierBuf as any).packets.size === 0 && (tierBuf as any).playbackSeq === null) {
    for (let t = abrState.currentTier - 1; t >= MIN_TIER; t--) {
      const buf = tiers.get(t);
      if (buf && (buf as any).packets.size > 0) {
        tierBuf = buf;
        tierToUse = t;
        if (t !== abrState.currentTier) {
          console.log(`⚠️ Tier ${abrState.currentTier} has no packets, using tier ${t} instead`);
        }
        break;
      }
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
  
  const pkt = tierBuf.popForPlayback(now);

  if (!pkt) {
    abrState.consecutiveLateOrMissing++;
    lossCountWindow++;
    // Only log missing packets occasionally
    if (lossCountWindow % 10 === 0) {
      console.log("Missing packet, scheduling silence");
    }
    scheduleSilence(audioCtx);
  } else {
    // Log first few packets to verify they're being processed
    if (pkt.seq <= 5 || (pkt.seq > 0 && pkt.seq % 100 === 0)) {
      console.log("🎵 Processing packet:", { seq: pkt.seq, tier: pkt.tier, payloadSize: pkt.opusPayload.length });
    }
    abrState.consecutiveLateOrMissing = 0;
    try {
      // Try to decode as Opus first
      const decoded = await opusDecoder.decode(pkt.opusPayload);
      // opus-decoder returns Float32Array[] (one per channel)
      schedulePcm(audioCtx, decoded[0]);
    } catch (err) {
      // If Opus decode fails, try to handle as raw PCM (Int16)
      // Only log first failure to reduce spam
      if (pkt.seq === 1 || pkt.seq % 100 === 0) {
        console.log("Opus decode failed, trying raw PCM (payload size:", pkt.opusPayload.length, ")");
      }
      try {
        // The broadcaster sends Int16 PCM as bytes - convert back to Int16Array
        const byteLength = pkt.opusPayload.length;
        if (byteLength % 2 !== 0) {
          console.warn("Odd byte length for PCM:", byteLength);
          scheduleSilence(audioCtx);
          return;
        }
        
        const sampleCount = byteLength / 2;
        const pcm16 = new Int16Array(pkt.opusPayload.buffer, pkt.opusPayload.byteOffset, sampleCount);
        
        // Convert Int16 to Float32 (-1.0 to 1.0)
        const pcmFloat = new Float32Array(sampleCount);
        let maxSample = 0;
        for (let i = 0; i < sampleCount; i++) {
          const normalized = pcm16[i] / (pcm16[i] < 0 ? 0x8000 : 0x7fff);
          pcmFloat[i] = Math.max(-1, Math.min(1, normalized));
          maxSample = Math.max(maxSample, Math.abs(pcmFloat[i]));
        }
        
        // Only log occasionally
        if (pkt.seq <= 10 || pkt.seq % 100 === 0) {
          console.log("Decoded raw PCM:", sampleCount, "samples, max amplitude:", maxSample.toFixed(3));
        }
        
        // Check if we have actual audio data (not silence)
        if (maxSample < 0.001 && pkt.seq % 50 === 0) {
          console.warn("⚠️ Very quiet audio detected (max:", maxSample.toFixed(4), "), might be silence or mic issue");
        }
        
        schedulePcm(audioCtx, pcmFloat);
      } catch (pcmErr) {
        console.error("Failed to decode raw PCM:", pcmErr);
        scheduleSilence(audioCtx);
      }
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

  const oldTier = abrState.currentTier;
  abrState = updateAbr(abrState, {
    lossPercent2s: lossPercent,
    bufferMs: stats.bufferMs,
    lateRate,
    deltaMs
  }, tierBuf);
  
  // Log tier changes
  if (abrState.currentTier !== oldTier) {
    console.log(`🔄 ABR tier changed: ${oldTier} → ${abrState.currentTier}`);
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
  if (loopRunning) {
    setTimeout(loop, 20);
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
  if (ws) {
    loopRunning = false;
    ws.close();
    ws = null;
  }
  if (audioCtx && audioCtx.state !== "closed") {
    audioCtx.suspend();
  }
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

// Load channels on startup and refresh every 5s
loadChannels();
setInterval(loadChannels, 5000);
