const API_URL = import.meta.env.VITE_API_URL || "http://localhost:4000";
const RELAY_BASE = import.meta.env.VITE_LAF_RELAY_URL || "ws://localhost:9000";

const SAMPLE_RATE = 48000;
const CHANNELS = 1;
const FRAME_DURATION_MS = 20;
const SAMPLES_PER_FRAME = (SAMPLE_RATE * FRAME_DURATION_MS) / 1000;

// Tier configurations matching the Node broadcaster
// For music, we want higher quality tiers
const TIERS = [
  { tier: 1, bitrate: 12_000 }, // 12 kbps - lowest quality
  { tier: 2, bitrate: 24_000 }, // 24 kbps - low quality
  { tier: 3, bitrate: 32_000 }, // 32 kbps - medium quality (good for music)
  { tier: 4, bitrate: 48_000 }  // 48 kbps - high quality (best for music)
];

// Default tier for music - use tier 3 or 4 for better quality
const DEFAULT_TIER = 3; // 32 kbps - good balance for music
const MAX_TIER = 4; // Support up to tier 4

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

// Improved PCM to Int16 encoding with subtle dithering
// TODO: Replace with real Opus encoding for production
function encodePcmToInt16(pcm: Float32Array): Int16Array {
  const pcm16 = new Int16Array(pcm.length);
  const scale = 0x7fff;
  
  for (let i = 0; i < pcm.length; i++) {
    // Clamp to [-1, 1] range
    let sample = Math.max(-1, Math.min(1, pcm[i]));
    
    // Subtle dithering - reduced to prevent muffling
    // Only add minimal dithering to reduce quantization artifacts without affecting sound quality
    const dither = (Math.random() - Math.random()) * (0.5 / scale); // Reduced from 1.0 to 0.5
    sample += dither;
    
    // Convert to Int16 with proper scaling
    // Use symmetric scaling for better quality
    if (sample >= 0) {
      pcm16[i] = Math.min(0x7fff, Math.round(sample * scale));
    } else {
      pcm16[i] = Math.max(-0x8000, Math.round(sample * scale));
    }
  }
  
  return pcm16;
}

// Encode PCM to "fake Opus" (raw PCM for now, will be replaced with real Opus)
function encodePcmToFakeOpus(pcm: Float32Array): Uint8Array {
  const pcm16 = encodePcmToInt16(pcm);
  // Return as Uint8Array for compatibility
  return new Uint8Array(pcm16.buffer);
}

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
      console.error("WebSocket error:", error);
      updateBroadcastStatus("stopped", "WebSocket error - check console");
    };
    
    ws.onclose = (event) => {
      console.error("WebSocket closed:", event.code, event.reason || "No reason");
      console.error("Close was clean:", event.wasClean);
      updateBroadcastStatus("stopped", `Connection closed (code: ${event.code})`);
      // Stop audio processing if WebSocket closes
      const processor = (audioCtx as any)?.processor;
      if (processor) {
        processor.disconnect();
        if ((processor as any).keepAliveInterval) {
          clearInterval((processor as any).keepAliveInterval);
        }
      }
    };

    startTime = performance.now();

    // Process audio - use ScriptProcessor (deprecated but works, will migrate to AudioWorklet later)
    // Buffer size 4096 gives us better stability than 1024
    const processor = audioCtx.createScriptProcessor(4096, CHANNELS, CHANNELS);
    let sampleBuffer = new Float32Array(0);
    let lastProcessTime = performance.now();
    let errorCount = 0;
    
    let lastPacketTime = performance.now();
    let packetsSent = 0;
    
    processor.onaudioprocess = (ev) => {
      try {
        const now = performance.now();
        
        // Check WebSocket state
        if (!ws || ws.readyState !== WebSocket.OPEN || !streamId) {
          // If WebSocket is closed, log and stop
          if (ws) {
            console.error(`WebSocket not ready: state=${ws.readyState}, streamId=${streamId}`);
            if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
              console.error("WebSocket closed, stopping audio processing");
              processor.disconnect();
              return;
            }
          }
          return;
        }
        
        const input = ev.inputBuffer.getChannelData(0);
        if (!input || input.length === 0) {
          console.warn("Empty input buffer");
          return;
        }
        
        // Accumulate samples
        const newBuffer = new Float32Array(sampleBuffer.length + input.length);
        newBuffer.set(sampleBuffer);
        newBuffer.set(input, sampleBuffer.length);
        sampleBuffer = newBuffer;
        
        // Process complete 20ms frames (960 samples)
        while (sampleBuffer.length >= SAMPLES_PER_FRAME) {
          const frame = sampleBuffer.subarray(0, SAMPLES_PER_FRAME);
          sampleBuffer = sampleBuffer.subarray(SAMPLES_PER_FRAME);
          
          const ptsMs = BigInt(Math.round(performance.now() - startTime));
          const fakeOpus = encodePcmToFakeOpus(frame);
          seq++;

          // For music quality, use tier 3 (32 kbps equivalent) or tier 4 (48 kbps equivalent)
          // Note: Since we're sending raw PCM (not Opus), the actual bitrate is much higher
          // TODO: Implement real Opus encoding to reduce bandwidth and improve quality
          const tier = DEFAULT_TIER; // Use tier 3 for better music quality
          
          const laf = buildLafPacket({
            tier,
            flags: 0,
            streamId,
            seq,
            ptsMs,
            opusPayload: fakeOpus,
          });
          
          try {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(laf);
              broadcastPacketCount++;
              packetsSent++;
              errorCount = 0; // Reset error count on success
              lastPacketTime = now;
            } else {
              console.error(`Cannot send: WebSocket state is ${ws.readyState}`);
              errorCount++;
            }
          } catch (sendErr) {
            errorCount++;
            console.error("Failed to send packet:", sendErr, "WebSocket state:", ws?.readyState);
            if (errorCount > 10) {
              console.error("Too many send errors, stopping");
              processor.disconnect();
              return;
            }
          }
        }
        
        // Log processing health every 2 seconds
        if (now - lastProcessTime > 2000) {
          const timeSinceLastPacket = now - lastPacketTime;
          console.log(`Audio processing: buffer=${sampleBuffer.length}, seq=${seq}, packetsSent=${packetsSent}, errors=${errorCount}, wsState=${ws?.readyState}, timeSinceLastPacket=${timeSinceLastPacket.toFixed(0)}ms`);
          lastProcessTime = now;
          packetsSent = 0;
          
          // Warn if no packets sent recently
          if (timeSinceLastPacket > 100) {
            console.warn(`⚠️ No packets sent for ${timeSinceLastPacket.toFixed(0)}ms`);
          }
        }
      } catch (err) {
        errorCount++;
        console.error("Error in audio processing:", err);
        if (errorCount > 10) {
          console.error("Too many processing errors, stopping");
          processor.disconnect();
        }
      }
    };

    // Connect processor and keep it alive
    source.connect(processor);
    processor.connect(audioCtx.destination);
    
    // Store processor reference for cleanup
    (audioCtx as any).processor = processor;
    
    // Keep processor alive by ensuring audio context stays active
    // This helps prevent ScriptProcessor from stopping after a few seconds
    const keepAlive = setInterval(() => {
      if (audioCtx.state === 'suspended') {
        console.warn("AudioContext suspended, resuming...");
        audioCtx.resume().catch(console.error);
      }
      // Log health check every 2 seconds
      console.log(`Keep-alive: audioCtx=${audioCtx.state}, ws=${ws?.readyState}, seq=${seq}, processor connected=${source.context === audioCtx}`);
      
      // Check if processor is still connected
      if (!processor.numberOfInputs || !processor.numberOfOutputs) {
        console.error("⚠️ ScriptProcessor disconnected! Reconnecting...");
        // Try to reconnect
        try {
          source.disconnect();
          processor.disconnect();
          source.connect(processor);
          processor.connect(audioCtx.destination);
          console.log("✅ ScriptProcessor reconnected");
        } catch (reconnectErr) {
          console.error("Failed to reconnect ScriptProcessor:", reconnectErr);
        }
      }
    }, 2000);
    
    // Store keepAlive interval ID for cleanup
    (processor as any).keepAliveInterval = keepAlive;

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
  } catch (err: any) {
    console.error("Broadcast start error:", err);
    alert(`Failed to start broadcast: ${err.message}`);
    updateBroadcastStatus("ready", `Error: ${err.message}`);
    btnGoLive.disabled = false;
    goLiveIcon.textContent = "▶️";
  }
}

async function stopBroadcast() {
  if (!confirm("Are you sure you want to stop broadcasting?")) {
    return;
  }

  btnStopLive.disabled = true;
  statusText.textContent = "Stopping broadcast...";
  
  // Clean up processor and keepAlive interval
  const processor = (audioCtx as any)?.processor;
  if (processor) {
    if ((processor as any).keepAliveInterval) {
      clearInterval((processor as any).keepAliveInterval);
    }
    processor.disconnect();
  }
  
  if (ws) {
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
