// SIMPLIFIED APPROACH: Use ScriptProcessor with 16-bit PCM
// This is the simplest, most reliable approach that works across all browsers
// ScriptProcessor is deprecated but it works, and we can work around its limitations

// Convert Float32 PCM to Int16 PCM (16-bit, standard format)
function floatToPCM16(pcm: Float32Array): Int16Array {
  const pcm16 = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    let sample = Math.max(-1, Math.min(1, pcm[i]));
    // Convert to 16-bit: -1.0 -> -32768, 0.0 -> 0, 1.0 -> 32767
    pcm16[i] = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
  }
  return pcm16;
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
let processingActive = false; // Track if audio processing is active
let sampleBuffer: Float32Array = new Float32Array(0); // Module-level buffer for cleanup
let packetsSent = 0; // Module-level packet counter
let lastPacketTime = 0; // Module-level last packet timestamp
let processCount = 0; // Module-level process counter
let lastProcessTime = 0; // Module-level last process timestamp

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
    // Stream finished state - clear visual indication
    statusIcon.textContent = "✅";
    statusText.textContent = message || "Stream Finished";
    statusText.style.color = "#10b981"; // Green color for finished
    liveIndicator.classList.add("hidden");
    broadcastStats.classList.add("hidden");
    btnGoLive.classList.remove("hidden");
    btnGoLive.disabled = false;
    btnGoLive.textContent = "▶️ Start New Stream";
    btnStopLive.classList.add("hidden");
  } else {
    // Ready state - can start new stream
    statusIcon.textContent = "⏸️";
    statusText.textContent = message;
    statusText.style.color = ""; // Reset to default
    liveIndicator.classList.add("hidden");
    broadcastStats.classList.add("hidden");
    btnGoLive.classList.remove("hidden");
    btnGoLive.disabled = false;
    btnGoLive.textContent = "▶️ Go Live";
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

    // CRITICAL: Reuse existing mediaStream and AudioContext if available (for restart)
    // Only request new mediaStream if we don't have one
    if (!mediaStream) {
      console.log("📱 Requesting microphone access...");
      // Get microphone with optimized audio constraints
      mediaStream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: true,  // Keep enabled for better quality
          noiseSuppression: false,  // Disable for music (preserves dynamics)
          autoGainControl: false,   // Disable for music (preserves natural dynamics)
          sampleRate: SAMPLE_RATE,
          channelCount: CHANNELS
        } 
      });
      console.log("✅ Microphone access granted");
    } else {
      console.log("✅ Reusing existing mediaStream (restart)");
      // Check if tracks are still active
      const tracks = mediaStream.getAudioTracks();
      if (tracks.length === 0 || tracks[0].readyState === 'ended') {
        console.log("⚠️ MediaStream tracks ended, requesting new stream...");
        mediaStream = await navigator.mediaDevices.getUserMedia({ 
          audio: {
            echoCancellation: true,
            noiseSuppression: false,
            autoGainControl: false,
            sampleRate: SAMPLE_RATE,
            channelCount: CHANNELS
          } 
        });
      }
    }
    
    // Reuse or create AudioContext
    if (!audioCtx) {
      audioCtx = new AudioContext({ 
        sampleRate: SAMPLE_RATE,
        latencyHint: 'interactive' // Low latency for real-time streaming
      });
      console.log("✅ Created new AudioContext");
    } else {
      console.log("✅ Reusing existing AudioContext (restart)");
    }
    
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
    
    ws.onclose = async (event) => {
      console.log("🔌 WebSocket closed");
      console.log(`   Code: ${event.code}`);
      console.log(`   Reason: ${event.reason || "No reason"}`);
      console.log(`   Was clean: ${event.wasClean}`);
      console.log(`   Total packets sent: ${packetsSent}`);
      console.log(`   Last packet time: ${lastPacketTime ? `${(performance.now() - lastPacketTime).toFixed(0)}ms ago` : "never"}`);
      console.log(`   ScriptProcessor processes: ${processCount}`);
      
      // Stop audio processing if WebSocket closes
      processingActive = false;
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
      
      // If WebSocket closed unexpectedly (code 1000 = normal closure from stopBroadcast)
      // Only call stop-live API if it was an unexpected closure
      if (event.code !== 1000 && currentChannel && streamId) {
        try {
          console.log("🔄 WebSocket closed unexpectedly, calling stop-live API...");
          await apiCall(`/api/me/channels/${currentChannel.id}/stop-live`, {
            method: "POST",
          });
          console.log("✅ Stream marked as finished in database");
          updateBroadcastStatus("stopped", "✅ Stream Finished (unexpected closure)");
        } catch (err) {
          console.error("⚠️ Failed to call stop-live API:", err);
          updateBroadcastStatus("stopped", "⚠️ Stream finished (server update failed)");
        }
      } else if (event.code === 1000) {
        // Normal closure - stopBroadcast already handled the API call
        console.log("✅ WebSocket closed normally (stream finished)");
      }
      
      // Reset UI state
      btnStopLive.disabled = false;
      btnGoLive.disabled = false;
      meterBar.style.width = "0%";
    };
    
    // WebSocket health monitor - keep connection alive and detect issues
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
        console.error(`   This will cause the stream to disappear from client page!`);
      } else {
        const buffered = ws.bufferedAmount;
        if (buffered > 0) {
          console.warn(`⚠️ WebSocket buffer: ${buffered} bytes (${(buffered / 1024).toFixed(1)} KB)`);
        }
        // Log health every 10 seconds (every 500 packets at ~50 packets/sec = 10 seconds)
        if (packetsSent % 500 === 0 && packetsSent > 0) {
          console.log(`✅ WebSocket healthy: state=${wsState}, buffer=${buffered} bytes, packets=${packetsSent}, timeSinceLastCheck=${timeSinceLastCheck.toFixed(0)}ms`);
        }
        
        // CRITICAL: Send a keep-alive ping if no packets sent recently
        // This ensures the connection stays alive even if audio processing stops temporarily
        const timeSinceLastPacket = lastPacketTime ? (performance.now() - lastPacketTime) : Infinity;
        if (timeSinceLastPacket > 1000 && processingActive) {
          // Send a small keep-alive message to prevent connection timeout
          try {
            ws.send(new Uint8Array([0])); // Send minimal binary data as keep-alive
            console.log(`💓 Sent WebSocket keep-alive (no packets for ${timeSinceLastPacket.toFixed(0)}ms)`);
          } catch (err) {
            console.error("⚠️ Failed to send keep-alive:", err);
          }
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
    
    sampleBuffer = new Float32Array(0); // Reset module-level buffer
    
    // SIMPLIFIED: Use ScriptProcessor (deprecated but simple and reliable)
    // Workaround for 2-second stop: reconnect processor periodically
    console.log("✅ Using ScriptProcessor (simple, reliable approach)");
    
    // Reset state for fresh start - use module-level variables
    seq = 0;
    startTime = performance.now();
    sampleBuffer = new Float32Array(0); // Reset module-level buffer
    packetsSent = 0; // Reset module-level counter
    lastPacketTime = performance.now();
    processCount = 0; // Reset module-level counter
    lastProcessTime = performance.now();
    processingActive = true; // Use module-level variable
    
    function createProcessor() {
      const processor = audioCtx!.createScriptProcessor(4096, CHANNELS, CHANNELS);
      
      const dummyGain = audioCtx!.createGain();
      dummyGain.gain.value = 0;
      dummyGain.connect(audioCtx!.destination);
      
      processor.onaudioprocess = (ev) => {
        try {
          processCount++;
          lastProcessTime = performance.now();
          
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
            
            // Convert to 16-bit PCM (simple, standard format)
            const pcm16 = floatToPCM16(frame);
            const pcm16Bytes = new Uint8Array(pcm16.buffer);
            
            const ptsMs = BigInt(Math.round(performance.now() - startTime));
            seq++;
            
            const laf = buildLafPacket({
              tier: DEFAULT_TIER,
              flags: 0,
              streamId,
              seq,
              ptsMs,
              opusPayload: pcm16Bytes,
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
      return processor;
    }
    
    let processor = createProcessor();
    (audioCtx as any).processor = processor;
    
    // Workaround for ScriptProcessor stopping after 2 seconds: recreate it periodically
    const processorKeepAlive = setInterval(() => {
      const timeSinceLastProcess = performance.now() - lastProcessTime;
      if (timeSinceLastProcess > 3000 && processingActive) {
        console.log("🔄 Recreating ScriptProcessor (workaround for 2-second stop issue)");
        try {
          processor.disconnect();
          source.disconnect();
          processor = createProcessor();
          (audioCtx as any).processor = processor;
          lastProcessTime = performance.now();
        } catch (err) {
          console.error("Failed to recreate processor:", err);
        }
      }
    }, 1000);
    (audioCtx as any).processorKeepAlive = processorKeepAlive;
    
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
  if (!confirm("Are you sure you want to finish this livestream?")) {
    return;
  }

  console.log("🛑 Starting 5-second countdown before finishing livestream...");
  btnStopLive.disabled = true;
  
  // Send "stream ending" message to clients so they can fade out gracefully
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ type: "stream_ending", countdown: 5 }));
      console.log("📤 Sent stream ending notification to clients");
    } catch (err) {
      console.error("⚠️ Failed to send stream ending message:", err);
    }
  }
  
  // Show countdown UI
  let countdown = 5;
  const countdownInterval = setInterval(() => {
    countdown--;
    statusText.textContent = `Finishing stream in ${countdown}...`;
    console.log(`⏱️ Countdown: ${countdown} seconds remaining`);
    
    if (countdown <= 0) {
      clearInterval(countdownInterval);
      actuallyStopBroadcast();
    }
  }, 1000);
  
  // Also set initial countdown display
  statusText.textContent = `Finishing stream in ${countdown}...`;
}

async function actuallyStopBroadcast() {
  console.log("🛑 Finishing livestream and cleaning up...");
  
  // CRITICAL: Stop audio processing NOW to prevent new packets
  processingActive = false;
  
  // CRITICAL: Call stop-live API BEFORE closing WebSocket
  // This ensures database is updated before relay removes the broadcaster
  // This prevents race conditions where client sees stream as live
  let stopLiveSuccess = false;
  if (currentChannel) {
    try {
      console.log(`🔄 Calling stop-live API for channel ${currentChannel.id}...`);
      const result = await apiCall(`/api/me/channels/${currentChannel.id}/stop-live`, {
        method: "POST",
      });
      console.log("✅ Stop-live API response:", result);
      
      // Verify the response indicates success
      if (result && (result.success || result.stoppedStreamIds)) {
        const stoppedCount = result.stoppedStreamIds?.length || 0;
        console.log(`✅ Successfully finished ${stoppedCount} stream(s) on server`);
        console.log(`   Finished stream IDs: ${result.stoppedStreamIds?.join(", ") || "N/A"}`);
        console.log(`   Verified: ${result.verified !== false ? "Yes" : "No"}`);
        stopLiveSuccess = true;
      } else {
        console.warn("⚠️ Stop-live API returned unexpected response:", result);
      }
    } catch (err: any) {
      console.error("❌ Failed to finish stream on server:", err);
      console.error("   Error details:", {
        message: err.message,
        status: err.status,
        response: err.response
      });
      // Continue with cleanup even if API call fails
    }
  } else {
    console.warn("⚠️ No currentChannel set, cannot call stop-live API");
  }
  
  // Now clean up local resources
  // Clean up processor if it exists
  const processor = (audioCtx as any)?.processor;
  if (processor) {
    try {
      if (processor.stop) {
        processor.stop();
      } else {
        processor.disconnect();
      }
      // Clean up processor keep-alive interval
      if ((processor as any).keepAliveInterval) {
        clearInterval((processor as any).keepAliveInterval);
      }
    } catch (err) {
      console.error("Error cleaning up processor:", err);
    }
    (audioCtx as any).processor = null;
  }
  
  // Clean up keep-alive intervals
  if ((audioCtx as any)?.keepAliveInterval) {
    clearInterval((audioCtx as any).keepAliveInterval);
    (audioCtx as any).keepAliveInterval = null;
  }
  
  if ((audioCtx as any)?.keepAliveMonitor) {
    clearInterval((audioCtx as any).keepAliveMonitor);
    (audioCtx as any).keepAliveMonitor = null;
  }
  
  // Close WebSocket connection AFTER database is updated
  // This ensures relay removal happens after DB update
  if (ws) {
    // Clean up WebSocket health monitor
    if ((ws as any).healthMonitor) {
      clearInterval((ws as any).healthMonitor);
    }
    // Close gracefully with code 1000 (normal closure)
    ws.close(1000, "Stream finished by broadcaster");
    ws = null;
  }
  
  // CRITICAL: Don't close AudioContext or stop mediaStream - keep them for restart
  // This allows user to restart without re-requesting microphone permission
  // Just suspend the AudioContext to stop processing
  if (audioCtx && audioCtx.state !== "closed") {
    await audioCtx.suspend();
    console.log("✅ AudioContext suspended (kept alive for restart)");
  }
  
  // Reset state variables
  meterBar.style.width = "0%";
  broadcastStartTime = null;
  broadcastPacketCount = 0;
  streamId = null;
  seq = 0;
  startTime = 0;
  sampleBuffer = new Float32Array(0);
  packetsSent = 0;
  lastPacketTime = 0;
  processCount = 0;
  lastProcessTime = 0;
  
  // Update UI based on success
  if (stopLiveSuccess) {
    // Show "finished" state (not "stopped")
    updateBroadcastStatus("stopped", "✅ Stream Finished Successfully");
    
    // After 2 seconds, show ready state with clear message
    setTimeout(() => {
      updateBroadcastStatus("ready", "Ready to start a new stream");
    }, 2000);
  } else {
    // API call failed, but still show finished state
    updateBroadcastStatus("stopped", "⚠️ Stream finished (server update may have failed)");
    setTimeout(() => {
      updateBroadcastStatus("ready", "Ready to start a new stream");
    }, 2000);
  }
  
  btnStopLive.disabled = false;
  btnGoLive.disabled = false;
  goLiveIcon.textContent = "▶️";
  console.log("✅ Broadcast finished - ready to restart");
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
