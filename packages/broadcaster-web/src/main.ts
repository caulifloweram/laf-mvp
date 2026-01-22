// NEW APPROACH: Use 8-bit PCM instead of 16-bit to reduce bandwidth by 2x
// 8-bit PCM = 384 kbps vs 16-bit PCM = 768 kbps
// This is much simpler and more reliable than trying to encode Opus in the browser
// The client can easily convert 8-bit back to 16-bit for playback

// Type declaration for MediaStreamTrackProcessor (modern API)
declare global {
  interface Window {
    MediaStreamTrackProcessor?: any;
  }
}

// Convert Float32 PCM to Int8 PCM (8-bit, reduces bandwidth by 2x)
function floatToPCM8(pcm: Float32Array): Uint8Array {
  const pcm8 = new Uint8Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    let sample = Math.max(-1, Math.min(1, pcm[i]));
    // Convert to 8-bit: -1.0 -> 0, 0.0 -> 128, 1.0 -> 255
    pcm8[i] = Math.round((sample + 1) * 127.5);
  }
  return pcm8;
}

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:4000";
const RELAY_BASE = import.meta.env.VITE_LAF_RELAY_URL || "ws://localhost:9000";

const SAMPLE_RATE = 48000;
const CHANNELS = 1;
const FRAME_DURATION_MS = 20;
const SAMPLES_PER_FRAME = (SAMPLE_RATE * FRAME_DURATION_MS) / 1000;

// Tier configurations matching the Node broadcaster
const TIERS = [
  { tier: 1, bitrate: 12_000 }, // 12 kbps
  { tier: 2, bitrate: 24_000 }, // 24 kbps
  { tier: 3, bitrate: 32_000 }, // 32 kbps - good for music
  { tier: 4, bitrate: 48_000 }  // 48 kbps - best for music
];

// Default tier - use tier 2 to match client's starting tier
// Client starts at tier 2, so we should send tier 2 packets
const DEFAULT_TIER = 2;
const MAX_TIER = 4;

interface Channel {
  id: string;
  title: string;
  description?: string;
  created_at: string;
}

let token: string | null = localStorage.getItem("token");
let currentChannel: Channel | null = null;
let ws: WebSocket | null = null;
let audioCtx: AudioContext | null = null;
let mediaStream: MediaStream | null = null;
let streamId: number | null = null;
let seq = 0;
let startTime = 0;

// Note: @wasm-audio-decoders/opus doesn't have an encoder
// For MVP, we'll use a simple approach: encode via Web Audio and send raw PCM
// In production, you'd want a WASM Opus encoder
// For now, we'll simulate by sending small chunks

// DOM refs
const loginSection = document.getElementById("login-section")!;
const registerSection = document.getElementById("register-section")!;
const mainSection = document.getElementById("main-section")!;
const createChannelSection = document.getElementById("create-channel-section")!;
const broadcastSection = document.getElementById("broadcast-section")!;
const settingsSection = document.getElementById("settings-section")!;
const channelsList = document.getElementById("channels-list")!;
const broadcastChannelTitle = document.getElementById("broadcast-channel-title")!;
const broadcastChannelDesc = document.getElementById("broadcast-channel-desc")!;
const meterBar = document.getElementById("meter-bar")!;
const broadcastStatus = document.getElementById("broadcast-status")!;
const statusIcon = document.getElementById("status-icon")!;
const statusText = document.getElementById("status-text")!;
const liveIndicator = document.getElementById("live-indicator")!;
const broadcastStats = document.getElementById("broadcast-stats")!;
const broadcastDuration = document.getElementById("broadcast-duration")!;
const broadcastPackets = document.getElementById("broadcast-packets")!;
const broadcastLevel = document.getElementById("broadcast-level")!;
const goLiveIcon = document.getElementById("go-live-icon")!;

const btnLogin = document.getElementById("btn-login")!;
const btnRegister = document.getElementById("btn-register")!;
const btnCreateChannel = document.getElementById("btn-create-channel")!;
const btnSaveChannel = document.getElementById("btn-save-channel")!;
const btnCancelCreate = document.getElementById("btn-cancel-create")!;
const btnGoLive = document.getElementById("btn-go-live")!;
const btnStopLive = document.getElementById("btn-stop-live")!;
const btnLogout = document.getElementById("btn-logout")!;
const btnSettings = document.getElementById("btn-settings")!;
const btnCloseSettings = document.getElementById("btn-close-settings")!;
const btnChangePassword = document.getElementById("btn-change-password")!;
const btnDeleteAccount = document.getElementById("btn-delete-account")!;

const linkRegister = document.getElementById("link-register")!;
const linkLogin = document.getElementById("link-login")!;

function showSection(section: string) {
  loginSection.classList.add("hidden");
  registerSection.classList.add("hidden");
  mainSection.classList.add("hidden");
  createChannelSection.classList.add("hidden");
  broadcastSection.classList.add("hidden");
  settingsSection.classList.add("hidden");

  if (section === "login") {
    loginSection.classList.remove("hidden");
  } else if (section === "register") {
    registerSection.classList.remove("hidden");
  } else if (section === "main") {
    mainSection.classList.remove("hidden");
  } else if (section === "create") {
    mainSection.classList.remove("hidden");
    createChannelSection.classList.remove("hidden");
  } else if (section === "broadcast") {
    mainSection.classList.remove("hidden");
    broadcastSection.classList.remove("hidden");
  } else if (section === "settings") {
    mainSection.classList.remove("hidden");
    settingsSection.classList.remove("hidden");
    loadUserProfile();
  }
}

async function apiCall(endpoint: string, options: RequestInit = {}) {
  const headers: HeadersInit = {
    "Content-Type": "application/json",
    ...options.headers,
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  
  const url = `${API_URL}${endpoint}`;
  console.log("API call:", url, options.method || "GET");
  
  try {
    const res = await fetch(url, {
      ...options,
      headers,
    });
    
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}: ${res.statusText}` }));
      throw new Error(err.error || `Request failed with status ${res.status}`);
    }
    return res.json();
  } catch (err: any) {
    if (err.name === "TypeError" && err.message.includes("fetch")) {
      throw new Error(`Cannot connect to API at ${API_URL}. Make sure the API server is running.`);
    }
    throw err;
  }
}

async function login(email: string, password: string) {
  const result = await apiCall("/api/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  token = result.token;
  localStorage.setItem("token", token);
  await loadChannels();
  showSection("main");
}

async function register(email: string, password: string) {
  try {
    const result = await apiCall("/api/register", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    token = result.token;
    localStorage.setItem("token", token);
    await loadChannels();
    showSection("main");
  } catch (err: any) {
    throw new Error(err.message || "Registration failed");
  }
}

function logout() {
  if (confirm("Are you sure you want to logout?")) {
    token = null;
    localStorage.removeItem("token");
    currentChannel = null;
    if (ws) {
      ws.close();
      ws = null;
    }
    if (mediaStream) {
      mediaStream.getTracks().forEach(track => track.stop());
      mediaStream = null;
    }
    showSection("login");
  }
}

async function loadUserProfile() {
  try {
    const profile = await apiCall("/api/me/profile");
    const emailEl = document.getElementById("user-email")!;
    const createdEl = document.getElementById("user-created")!;
    emailEl.textContent = profile.email;
    const createdDate = new Date(profile.created_at);
    createdEl.textContent = createdDate.toLocaleDateString();
  } catch (err: any) {
    console.error("Failed to load profile:", err);
  }
}

async function handleChangePassword() {
  const currentPassword = (document.getElementById("current-password") as HTMLInputElement).value;
  const newPassword = (document.getElementById("new-password") as HTMLInputElement).value;
  const confirmPassword = (document.getElementById("confirm-password") as HTMLInputElement).value;
  const statusEl = document.getElementById("password-change-status")!;

  if (!currentPassword || !newPassword || !confirmPassword) {
    statusEl.innerHTML = '<div class="status error">Please fill in all fields</div>';
    return;
  }

  if (newPassword !== confirmPassword) {
    statusEl.innerHTML = '<div class="status error">New passwords do not match</div>';
    return;
  }

  try {
    btnChangePassword.disabled = true;
    btnChangePassword.textContent = "Changing...";
    
    await apiCall("/api/me/change-password", {
      method: "POST",
      body: JSON.stringify({ currentPassword, newPassword }),
    });

    statusEl.innerHTML = '<div class="status success">Password changed successfully!</div>';
    (document.getElementById("current-password") as HTMLInputElement).value = "";
    (document.getElementById("new-password") as HTMLInputElement).value = "";
    (document.getElementById("confirm-password") as HTMLInputElement).value = "";
    
    setTimeout(() => {
      statusEl.innerHTML = "";
    }, 3000);
  } catch (err: any) {
    statusEl.innerHTML = `<div class="status error">${err.message || "Failed to change password"}</div>`;
  } finally {
    btnChangePassword.disabled = false;
    btnChangePassword.textContent = "Change Password";
  }
}

async function handleDeleteAccount() {
  const password = (document.getElementById("delete-password") as HTMLInputElement).value;
  const statusEl = document.getElementById("delete-account-status")!;

  if (!password) {
    statusEl.innerHTML = '<div class="status error">Please enter your password to confirm</div>';
    return;
  }

  const confirmMessage = "Are you absolutely sure? This will permanently delete your account and all your channels. This action cannot be undone.";
  if (!confirm(confirmMessage)) {
    return;
  }

  try {
    btnDeleteAccount.disabled = true;
    btnDeleteAccount.textContent = "Deleting...";
    
    await apiCall("/api/me/delete-account", {
      method: "POST",
      body: JSON.stringify({ password }),
    });

    statusEl.innerHTML = '<div class="status success">Account deleted successfully. Redirecting...</div>';
    
    // Clear everything and redirect to login
    token = null;
    localStorage.removeItem("token");
    currentChannel = null;
    if (ws) {
      ws.close();
      ws = null;
    }
    if (mediaStream) {
      mediaStream.getTracks().forEach(track => track.stop());
      mediaStream = null;
    }
    
    setTimeout(() => {
      showSection("login");
      statusEl.innerHTML = "";
    }, 2000);
  } catch (err: any) {
    statusEl.innerHTML = `<div class="status error">${err.message || "Failed to delete account"}</div>`;
    btnDeleteAccount.disabled = false;
    btnDeleteAccount.textContent = "Delete My Account";
  }
}

async function loadChannels() {
  try {
    const channels: Channel[] = await apiCall("/api/me/channels");
    channelsList.innerHTML = "";
    if (channels.length === 0) {
      channelsList.innerHTML = "<p style='opacity: 0.7;'>No channels yet. Create one to start streaming!</p>";
      return;
    }
    channels.forEach((ch) => {
      const item = document.createElement("div");
      item.className = "channel-item";
      item.innerHTML = `
        <div>
          <strong>${escapeHtml(ch.title)}</strong>
          <p style="opacity: 0.7; font-size: 0.9rem; margin-top: 0.25rem;">${escapeHtml(ch.description || "")}</p>
        </div>
        <button style="width: auto; padding: 0.5rem 1rem;" data-channel-id="${ch.id}">Go Live</button>
      `;
      item.querySelector("button")!.onclick = () => selectChannel(ch);
      channelsList.appendChild(item);
    });
  } catch (err) {
    console.error("Failed to load channels:", err);
  }
}

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function updateBroadcastStatus(status: "ready" | "live" | "stopped", message: string) {
  broadcastStatus.className = `status ${status}`;
  if (status === "live") {
    statusIcon.textContent = "🔴";
    statusText.textContent = message;
    liveIndicator.classList.remove("hidden");
    broadcastStats.classList.remove("hidden");
    btnGoLive.classList.add("hidden");
    btnStopLive.classList.remove("hidden");
    btnStopLive.disabled = false;
  } else if (status === "stopped") {
    statusIcon.textContent = "⏹️";
    statusText.textContent = message;
    liveIndicator.classList.add("hidden");
    broadcastStats.classList.add("hidden");
    btnGoLive.classList.remove("hidden");
    btnStopLive.classList.add("hidden");
  } else {
    statusIcon.textContent = "⏸️";
    statusText.textContent = message;
    liveIndicator.classList.add("hidden");
    broadcastStats.classList.add("hidden");
    btnGoLive.classList.remove("hidden");
    btnStopLive.classList.add("hidden");
  }
}

let broadcastStartTime: number | null = null;
let broadcastPacketCount = 0;

function updateBroadcastStats() {
  if (broadcastStartTime && ws && ws.readyState === WebSocket.OPEN) {
    const elapsed = Math.floor((Date.now() - broadcastStartTime) / 1000);
    const minutes = Math.floor(elapsed / 60);
    const seconds = elapsed % 60;
    broadcastDuration.textContent = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    broadcastPackets.textContent = String(broadcastPacketCount);
    
    // Update audio level from meter
    const meterWidth = parseFloat(meterBar.style.width) || 0;
    if (meterWidth > 0) {
      broadcastLevel.textContent = `${Math.round(meterWidth)}%`;
    } else {
      broadcastLevel.textContent = "-";
    }
    
    requestAnimationFrame(updateBroadcastStats);
  }
}

function selectChannel(ch: Channel) {
  currentChannel = ch;
  broadcastChannelTitle.textContent = ch.title;
  broadcastChannelDesc.textContent = ch.description || "";
  showSection("broadcast");
  updateBroadcastStatus("ready", "Ready to go live");
}

async function createChannel() {
  const titleInput = document.getElementById("channel-title") as HTMLInputElement;
  const descInput = document.getElementById("channel-desc") as HTMLTextAreaElement;
  
  if (!titleInput) {
    console.error("channel-title input not found");
    alert("Page error: form elements not found");
    return;
  }
  
  const title = titleInput.value?.trim();
  const desc = descInput?.value?.trim();
  
  if (!title) {
    alert("Title is required");
    return;
  }
  
  try {
    btnSaveChannel.disabled = true;
    btnSaveChannel.textContent = "Creating...";
    
    console.log("Creating channel:", { title, desc });
    const result = await apiCall("/api/me/channels", {
      method: "POST",
      body: JSON.stringify({ title, description: desc || null }),
    });
    
    console.log("Channel created:", result);
    
    titleInput.value = "";
    if (descInput) descInput.value = "";
    
    await loadChannels();
    showSection("main");
  } catch (err: any) {
    console.error("Failed to create channel:", err);
    alert(err.message || "Failed to create channel. Please try again.");
  } finally {
    btnSaveChannel.disabled = false;
    btnSaveChannel.textContent = "Create Channel";
  }
}

function buildLafPacket(opts: {
  tier: number;
  flags: number;
  streamId: number;
  seq: number;
  ptsMs: bigint;
  opusPayload: Uint8Array;
}): ArrayBuffer {
  const opusLen = opts.opusPayload.length;
  const headerLen = 4 + 1 + 1 + 2 + 4 + 4 + 8 + 2;
  const buf = new ArrayBuffer(headerLen + opusLen);
  const view = new DataView(buf);
  let off = 0;

  view.setUint32(off, 0x4c414631); off += 4;
  view.setUint8(off, 1); off += 1;
  view.setUint8(off, opts.tier); off += 1;
  view.setUint16(off, opts.flags); off += 2;
  view.setUint32(off, opts.streamId); off += 4;
  view.setUint32(off, opts.seq); off += 4;
  const hi = Number((opts.ptsMs >> 32n) & 0xffffffffn);
  const lo = Number(opts.ptsMs & 0xffffffffn);
  view.setUint32(off, hi); off += 4;
  view.setUint32(off, lo); off += 4;
  view.setUint16(off, opusLen); off += 2;

  new Uint8Array(buf, off).set(opts.opusPayload);
  return buf;
}

// MediaRecorder API handles Opus encoding natively - no need for manual encoding!
// This is much simpler and more reliable than OpusScript or WASM

async function startBroadcast() {
  if (!currentChannel) {
    alert("No channel selected");
    return;
  }

  try {
    btnGoLive.disabled = true;
    goLiveIcon.textContent = "⏳";
    statusText.textContent = "Starting broadcast...";
    
    console.log("Starting broadcast for channel:", currentChannel.id);
    const result = await apiCall(`/api/me/channels/${currentChannel.id}/go-live`, {
      method: "POST",
    });
    
    console.log("Go-live result:", result);
    
    if (!result.streamId) {
      throw new Error("No streamId returned from server");
    }
    
    streamId = result.streamId;
    const wsUrl = `${RELAY_BASE}/?role=broadcaster&streamId=${streamId}`;
    console.log("Connecting to relay:", wsUrl);

    // Get microphone with optimized audio constraints
    // Keep some processing enabled for better quality, but optimize for music
    mediaStream = await navigator.mediaDevices.getUserMedia({ 
      audio: {
        echoCancellation: true,  // Keep enabled for better quality
        noiseSuppression: false,  // Disable for music (preserves dynamics)
        autoGainControl: false,   // Disable for music (preserves natural dynamics)
        sampleRate: SAMPLE_RATE,
        channelCount: CHANNELS
      } 
    });
    audioCtx = new AudioContext({ 
      sampleRate: SAMPLE_RATE,
      latencyHint: 'interactive' // Low latency for real-time streaming
    });
    
    // CRITICAL: Ensure AudioContext is running (browsers require user interaction)
    if (audioCtx.state === 'suspended') {
      console.log("AudioContext suspended, attempting to resume...");
      await audioCtx.resume();
      console.log("AudioContext state after resume:", audioCtx.state);
    }
    
    // Keep AudioContext alive with periodic resume attempts
    const audioContextKeepAlive = setInterval(() => {
      if (audioCtx && audioCtx.state === 'suspended') {
        console.warn("⚠️ AudioContext suspended, attempting to resume...");
        audioCtx.resume().then(() => {
          console.log("✅ AudioContext resumed");
        }).catch(err => {
          console.error("Failed to resume AudioContext:", err);
        });
      }
    }, 2000); // Check every 2 seconds
    (audioCtx as any).keepAliveInterval = audioContextKeepAlive;
    
    const source = audioCtx.createMediaStreamSource(mediaStream);

    // Create analyzer for meter
    const analyzer = audioCtx.createAnalyser();
    analyzer.fftSize = 256;
    source.connect(analyzer);

    // Connect to relay
    ws = new WebSocket(wsUrl);
    
    await new Promise<void>((res, rej) => {
      const timeout = setTimeout(() => {
        rej(new Error("WebSocket connection timeout"));
      }, 10000);
      
      ws!.onopen = () => {
        clearTimeout(timeout);
        console.log("✅ WebSocket connected successfully");
        res();
      };
      
      ws!.onerror = (e) => {
        clearTimeout(timeout);
        console.error("WebSocket error during connection:", e);
        updateBroadcastStatus("stopped", "WebSocket error - check console");
        rej(e);
      };
    });
    
    // Add WebSocket event handlers for debugging (after connection is established)
    ws.onerror = (error) => {
      console.error("❌ WebSocket error:", error);
      console.error("   WebSocket state:", ws?.readyState);
      console.error("   Stream ID:", streamId);
      console.error("   Packets sent:", packetsSent);
      updateBroadcastStatus("stopped", "WebSocket error - check console");
    };
    
    ws.onclose = (event) => {
      console.error("❌ WebSocket closed!");
      console.error("   Code:", event.code);
      console.error("   Reason:", event.reason || "No reason");
      console.error("   Was clean:", event.wasClean);
      console.error("   Total packets sent:", packetsSent);
      console.error("   Last packet time:", lastPacketTime ? `${(performance.now() - lastPacketTime).toFixed(0)}ms ago` : "never");
      console.error("   ScriptProcessor processes:", processCount);
      updateBroadcastStatus("stopped", `Connection closed (code: ${event.code})`);
      // Stop audio processing if WebSocket closes
      const processor = (audioCtx as any)?.processor;
      if (processor) {
        processor.disconnect();
        if ((processor as any).keepAliveInterval) {
          clearInterval((processor as any).keepAliveInterval);
        }
      }
      if ((audioCtx as any)?.keepAliveMonitor) {
        clearInterval((audioCtx as any).keepAliveMonitor);
      }
      if ((audioCtx as any)?.keepAliveInterval) {
        clearInterval((audioCtx as any).keepAliveInterval);
      }
    };
    
    // WebSocket health monitor
    let lastWsCheck = performance.now();
    const wsHealthMonitor = setInterval(() => {
      if (!ws) {
        console.error("⚠️ WebSocket is null!");
        clearInterval(wsHealthMonitor);
        return;
      }
      
      const wsState = ws.readyState;
      const timeSinceLastCheck = performance.now() - lastWsCheck;
      lastWsCheck = performance.now();
      
      if (wsState !== WebSocket.OPEN) {
        console.error(`⚠️ WebSocket not open: state=${wsState} (0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED)`);
      } else {
        const buffered = ws.bufferedAmount;
        if (buffered > 0) {
          console.warn(`⚠️ WebSocket buffer: ${buffered} bytes (${(buffered / 1024).toFixed(1)} KB)`);
        }
        // Log health every 10 seconds
        if (packetsSent % 500 === 0 && packetsSent > 0) {
          console.log(`✅ WebSocket healthy: state=${wsState}, buffer=${buffered} bytes, packets=${packetsSent}`);
        }
      }
    }, 2000); // Check every 2 seconds
    (ws as any).healthMonitor = wsHealthMonitor;

    startTime = performance.now();
    seq = 0;

    // NEW APPROACH: Use 8-bit PCM instead of 16-bit to reduce bandwidth by 2x
    // This is simpler and more reliable than Opus encoding
    // 8-bit PCM = 384 kbps vs 16-bit PCM = 768 kbps (2x reduction)
    console.log("🎙️ Using 8-bit PCM encoding (2x bandwidth reduction, 384 kbps)");
    console.log("📊 AudioContext state:", audioCtx.state);
    console.log("📊 MediaStream tracks:", mediaStream.getAudioTracks().length);
    console.log("📊 WebSocket state:", ws?.readyState);
    console.log("📊 Stream ID:", streamId);
    
    let sampleBuffer = new Float32Array(0);
    let lastPacketTime = performance.now();
    let packetsSent = 0;
    let processingActive = true;
    
    // CRITICAL FIX: ScriptProcessor is DEPRECATED and stops after 2 seconds
    // Use MediaStreamTrackProcessor (modern API) which is reliable
    // If not available, use a polling approach with MediaStream directly
    
    const audioTrack = mediaStream.getAudioTracks()[0];
    let lastProcessTime = performance.now();
    let processCount = 0;
    
    // Try MediaStreamTrackProcessor first (modern, reliable API)
    if (audioTrack && typeof (window as any).MediaStreamTrackProcessor !== 'undefined') {
      console.log("✅ Using MediaStreamTrackProcessor (modern, reliable API)");
      const trackProcessor = new (window as any).MediaStreamTrackProcessor({ track: audioTrack });
      const readable = trackProcessor.readable;
      const reader = readable.getReader();
      
      async function processAudioChunk() {
        try {
          while (processingActive) {
            const { done, value } = await reader.read();
            if (done) {
              console.log("Audio track ended");
              break;
            }
            
            if (!ws || ws.readyState !== WebSocket.OPEN || !streamId || !processingActive) {
              if (ws && (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING)) {
                console.error("WebSocket closed, stopping audio processing");
                processingActive = false;
                break;
              }
              await new Promise(r => setTimeout(r, 10));
              continue;
            }
            
            // value is an AudioData object
            const audioData = value;
            // AudioData.copyTo() requires 2 arguments: destination and options
            // For mono audio, we need numberOfFrames samples
            // For multi-channel, we need numberOfFrames * numberOfChannels
            const totalSamples = audioData.numberOfFrames * audioData.numberOfChannels;
            const frame = new Float32Array(totalSamples);
            
            // copyTo requires destination buffer and options object
            // Options: { planeIndex: number, format: string }
            // For interleaved format (default), use planeIndex 0
            try {
              audioData.copyTo(frame, { planeIndex: 0 });
            } catch (err) {
              console.error("Error copying AudioData:", err);
              audioData.close();
              continue;
            }
            audioData.close();
            
            // If multi-channel, convert to mono by taking first channel or averaging
            let monoFrame: Float32Array;
            if (audioData.numberOfChannels > 1) {
              monoFrame = new Float32Array(audioData.numberOfFrames);
              // Take first channel (interleaved: [L0, R0, L1, R1, ...])
              for (let i = 0; i < audioData.numberOfFrames; i++) {
                monoFrame[i] = frame[i * audioData.numberOfChannels];
              }
            } else {
              monoFrame = frame;
            }
            
            // Accumulate samples (use monoFrame which is always mono)
            const newBuffer = new Float32Array(sampleBuffer.length + monoFrame.length);
            newBuffer.set(sampleBuffer);
            newBuffer.set(monoFrame, sampleBuffer.length);
            sampleBuffer = newBuffer;
            
            // Process complete 20ms frames (960 samples)
            while (sampleBuffer.length >= SAMPLES_PER_FRAME) {
              const frame20ms = sampleBuffer.subarray(0, SAMPLES_PER_FRAME);
              sampleBuffer = sampleBuffer.subarray(SAMPLES_PER_FRAME);
              
              processCount++;
              lastProcessTime = performance.now();
              
              // Convert to 8-bit PCM
              const pcm8 = floatToPCM8(frame20ms);
              
              const ptsMs = BigInt(Math.round(performance.now() - startTime));
              seq++;
              
              const laf = buildLafPacket({
                tier: DEFAULT_TIER,
                flags: 0,
                streamId,
                seq,
                ptsMs,
                opusPayload: pcm8,
              });
              
              try {
                if (ws.bufferedAmount > 512 * 1024) {
                  console.warn(`⚠️ WebSocket buffer: ${ws.bufferedAmount} bytes, skipping packet`);
                  continue;
                }
                
                ws.send(laf);
                broadcastPacketCount++;
                packetsSent++;
                lastPacketTime = performance.now();
                
                if (seq % 250 === 0) {
                  const packetSize = laf.byteLength;
                  const kbps = (packetSize * 50 * 8) / 1000;
                  console.log(`📊 Bandwidth: ${kbps.toFixed(0)} kbps (8-bit PCM), packet size: ${packetSize} bytes, buffer: ${ws.bufferedAmount} bytes`);
                }
              } catch (sendErr) {
                console.error("Failed to send packet:", sendErr);
              }
            }
          }
        } catch (err) {
          console.error("Error in MediaStreamTrackProcessor:", err);
          processingActive = false;
        }
      }
      
      processAudioChunk();
      (audioCtx as any).processor = { stop: () => { processingActive = false; reader.cancel(); } };
      
    } else {
      // FALLBACK: Use ScriptProcessor (deprecated, but better than nothing)
      // This will stop after 2 seconds, but it's the only fallback
      console.warn("⚠️ MediaStreamTrackProcessor not available, using ScriptProcessor (deprecated, may stop after 2 seconds)");
      const processor = audioCtx.createScriptProcessor(4096, CHANNELS, CHANNELS);
      
      const dummyGain = audioCtx.createGain();
      dummyGain.gain.value = 0;
      dummyGain.connect(audioCtx.destination);
      
      processor.onaudioprocess = (ev) => {
        try {
          processCount++;
          lastProcessTime = performance.now();
          
          if (processCount % 50 === 0) {
            console.log(`🎤 ScriptProcessor active: processed ${processCount} times, ${packetsSent} packets sent`);
          }
          
          if (!ws || ws.readyState !== WebSocket.OPEN || !streamId || !processingActive) {
            if (ws && (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING)) {
              console.error("WebSocket closed, stopping audio processing");
              processingActive = false;
              return;
            }
            return;
          }
          
          const input = ev.inputBuffer.getChannelData(0);
          if (!input || input.length === 0) return;
          
          const newBuffer = new Float32Array(sampleBuffer.length + input.length);
          newBuffer.set(sampleBuffer);
          newBuffer.set(input, sampleBuffer.length);
          sampleBuffer = newBuffer;
          
          while (sampleBuffer.length >= SAMPLES_PER_FRAME) {
            const frame = sampleBuffer.subarray(0, SAMPLES_PER_FRAME);
            sampleBuffer = sampleBuffer.subarray(SAMPLES_PER_FRAME);
            
            const pcm8 = floatToPCM8(frame);
            const ptsMs = BigInt(Math.round(performance.now() - startTime));
            seq++;
            
            const laf = buildLafPacket({
              tier: DEFAULT_TIER,
              flags: 0,
              streamId,
              seq,
              ptsMs,
              opusPayload: pcm8,
            });
            
            try {
              if (ws.bufferedAmount > 512 * 1024) {
                console.warn(`⚠️ WebSocket buffer: ${ws.bufferedAmount} bytes, skipping packet`);
                continue;
              }
              
              ws.send(laf);
              broadcastPacketCount++;
              packetsSent++;
              lastPacketTime = performance.now();
              
              if (seq % 250 === 0) {
                const packetSize = laf.byteLength;
                const kbps = (packetSize * 50 * 8) / 1000;
                console.log(`📊 Bandwidth: ${kbps.toFixed(0)} kbps (8-bit PCM), packet size: ${packetSize} bytes, buffer: ${ws.bufferedAmount} bytes`);
              }
            } catch (sendErr) {
              console.error("Failed to send packet:", sendErr);
            }
          }
        } catch (err) {
          console.error("Error in audio processing:", err);
        }
      };
      
      source.connect(processor);
      processor.connect(dummyGain);
      (audioCtx as any).processor = processor;
    }
    
    // Health monitor
    const keepAliveMonitor = setInterval(() => {
      const timeSinceLastProcess = performance.now() - lastProcessTime;
      
      if (timeSinceLastProcess > 500) {
        console.error(`⚠️ Audio processing appears to have stopped! Last process: ${timeSinceLastProcess.toFixed(0)}ms ago`);
        console.error(`   Process count: ${processCount}, Packets sent: ${packetsSent}`);
        console.error(`   WebSocket state: ${ws?.readyState}, Processing active: ${processingActive}`);
        console.error(`   AudioContext state: ${audioCtx?.state}`);
        
        if (audioCtx && audioCtx.state === 'suspended') {
          audioCtx.resume().then(() => {
            console.log("✅ AudioContext resumed");
          }).catch(err => {
            console.error("Failed to resume AudioContext:", err);
          });
        }
      } else if (processCount % 250 === 0 && processCount > 0) {
        console.log(`✅ Audio processing healthy: ${processCount} processes, ${packetsSent} packets sent, WS: ${ws?.readyState}`);
      }
    }, 1000);
    
    (audioCtx as any).keepAliveMonitor = keepAliveMonitor;

    // Update meter
    const dataArray = new Uint8Array(analyzer.frequencyBinCount);
    function updateMeter() {
      if (!analyzer) return;
      analyzer.getByteFrequencyData(dataArray);
      const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
      meterBar.style.width = `${Math.min(100, (avg / 255) * 100)}%`;
      requestAnimationFrame(updateMeter);
    }
    updateMeter();

    broadcastStartTime = Date.now();
    broadcastPacketCount = 0;
    updateBroadcastStatus("live", "🔴 Broadcasting live");
    updateBroadcastStats();
    
    console.log("✅ Broadcast started successfully!");
    console.log("📊 All systems ready - audio processing should begin shortly");
  } catch (err: any) {
    console.error("❌ Broadcast start error:", err);
    console.error("   Error name:", err.name);
    console.error("   Error message:", err.message);
    console.error("   Error stack:", err.stack);
    alert(`Failed to start broadcast: ${err.message}`);
    updateBroadcastStatus("ready", `Error: ${err.message}`);
    btnGoLive.disabled = false;
    goLiveIcon.textContent = "▶️";
    
    // Clean up on error
    if (ws) {
      ws.close();
      ws = null;
    }
    if (mediaStream) {
      mediaStream.getTracks().forEach(t => t.stop());
      mediaStream = null;
    }
    if (audioCtx) {
      await audioCtx.close().catch(() => {});
      audioCtx = null;
    }
  }
}

async function stopBroadcast() {
  if (!confirm("Are you sure you want to stop broadcasting?")) {
    return;
  }

  btnStopLive.disabled = true;
  statusText.textContent = "Stopping broadcast...";
  
  // Clean up MediaRecorder
  const mediaRecorder = (audioCtx as any)?.mediaRecorder;
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  
  // Clean up processor if it exists (fallback)
  const processor = (audioCtx as any)?.processor;
  if (processor) {
    if (processor.stop) {
      processor.stop();
    } else {
      processor.disconnect();
    }
  }
  
  if ((audioCtx as any)?.keepAliveInterval) {
    clearInterval((audioCtx as any).keepAliveInterval);
  }
  
  if ((audioCtx as any)?.keepAliveMonitor) {
    clearInterval((audioCtx as any).keepAliveMonitor);
  }
  
  if (ws) {
    // Clean up WebSocket health monitor
    if ((ws as any).healthMonitor) {
      clearInterval((ws as any).healthMonitor);
    }
    ws.close();
    ws = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
  if (audioCtx) {
    await audioCtx.close();
    audioCtx = null;
  }
  
  meterBar.style.width = "0%";
  broadcastStartTime = null;
  broadcastPacketCount = 0;
  
  if (currentChannel) {
    try {
      const result = await apiCall(`/api/me/channels/${currentChannel.id}/stop-live`, {
        method: "POST",
      });
      console.log("Stop-live result:", result);
      updateBroadcastStatus("ready", "Stream stopped successfully");
    } catch (err: any) {
      console.error("Failed to stop stream:", err);
      alert(`Failed to stop stream: ${err.message || "Unknown error"}`);
      updateBroadcastStatus("ready", "Ready to go live (server stop failed)");
    }
  } else {
    updateBroadcastStatus("ready", "Ready to go live");
  }
  
  streamId = null;
  seq = 0;
  btnStopLive.disabled = false;
}

// Event handlers
btnLogin.onclick = () => {
  const email = (document.getElementById("login-email") as HTMLInputElement).value;
  const password = (document.getElementById("login-password") as HTMLInputElement).value;
  login(email, password).catch((err) => alert(err.message));
};

btnRegister.onclick = () => {
  const email = (document.getElementById("register-email") as HTMLInputElement).value;
  const password = (document.getElementById("register-password") as HTMLInputElement).value;
  register(email, password).catch((err) => alert(err.message));
};

linkRegister.onclick = (e) => {
  e.preventDefault();
  showSection("register");
};

linkLogin.onclick = (e) => {
  e.preventDefault();
  showSection("login");
};

btnCreateChannel.onclick = () => showSection("create");
btnSaveChannel.onclick = createChannel;
btnCancelCreate.onclick = () => showSection("main");
btnGoLive.onclick = startBroadcast;
btnStopLive.onclick = stopBroadcast;
btnLogout.onclick = logout;
btnSettings.onclick = () => showSection("settings");
btnCloseSettings.onclick = () => showSection("main");
btnChangePassword.onclick = handleChangePassword;
btnDeleteAccount.onclick = handleDeleteAccount;

// Check if already logged in
if (token) {
  loadChannels().then(() => showSection("main")).catch(() => {
    token = null;
    localStorage.removeItem("token");
    showSection("login");
  });
} else {
  showSection("login");
}
