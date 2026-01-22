const API_URL = import.meta.env.VITE_API_URL || "http://localhost:4000";
const RELAY_BASE = import.meta.env.VITE_LAF_RELAY_URL || "ws://localhost:9000";

const SAMPLE_RATE = 48000;
const CHANNELS = 1;
const FRAME_DURATION_MS = 20;
const SAMPLES_PER_FRAME = (SAMPLE_RATE * FRAME_DURATION_MS) / 1000;

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
const channelsList = document.getElementById("channels-list")!;
const broadcastChannelTitle = document.getElementById("broadcast-channel-title")!;
const meterBar = document.getElementById("meter-bar")!;
const broadcastStatus = document.getElementById("broadcast-status")!;

const btnLogin = document.getElementById("btn-login")!;
const btnRegister = document.getElementById("btn-register")!;
const btnCreateChannel = document.getElementById("btn-create-channel")!;
const btnSaveChannel = document.getElementById("btn-save-channel")!;
const btnCancelCreate = document.getElementById("btn-cancel-create")!;
const btnGoLive = document.getElementById("btn-go-live")!;
const btnStopLive = document.getElementById("btn-stop-live")!;

const linkRegister = document.getElementById("link-register")!;
const linkLogin = document.getElementById("link-login")!;

function showSection(section: string) {
  loginSection.classList.add("hidden");
  registerSection.classList.add("hidden");
  mainSection.classList.add("hidden");
  createChannelSection.classList.add("hidden");
  broadcastSection.classList.add("hidden");

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
  const result = await apiCall("/api/register", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  token = result.token;
  localStorage.setItem("token", token);
  await loadChannels();
  showSection("main");
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

function selectChannel(ch: Channel) {
  currentChannel = ch;
  broadcastChannelTitle.textContent = `Broadcasting: ${ch.title}`;
  showSection("broadcast");
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

// Simple PCM to "fake Opus" for MVP (just send PCM chunks)
// In production, replace with real Opus encoding
function encodePcmToFakeOpus(pcm: Float32Array): Uint8Array {
  // Convert float32 to int16 PCM
  const pcm16 = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  // For MVP, just send raw PCM (relay/client will need to handle this)
  // In production, encode with Opus here
  return new Uint8Array(pcm16.buffer);
}

async function startBroadcast() {
  if (!currentChannel) {
    alert("No channel selected");
    return;
  }

  try {
    btnGoLive.disabled = true;
    btnGoLive.textContent = "Starting...";
    
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

    // Get microphone
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
    const source = audioCtx.createMediaStreamSource(mediaStream);

    // Create analyzer for meter
    const analyzer = audioCtx.createAnalyser();
    analyzer.fftSize = 256;
    source.connect(analyzer);

    // Connect to relay
    ws = new WebSocket(wsUrl);
    await new Promise<void>((res, rej) => {
      ws!.onopen = () => res();
      ws!.onerror = (e) => rej(e);
    });

    startTime = performance.now();

    // Process audio - use power-of-2 buffer size (1024) and accumulate to 960 samples
    const processor = audioCtx.createScriptProcessor(1024, CHANNELS, CHANNELS);
    let sampleBuffer = new Float32Array(0);
    
    processor.onaudioprocess = (ev) => {
      if (!ws || ws.readyState !== WebSocket.OPEN || !streamId) return;
      
      const input = ev.inputBuffer.getChannelData(0);
      
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

        const laf = buildLafPacket({
          tier: 2, // Start with tier 2
          flags: 0,
          streamId,
          seq,
          ptsMs,
          opusPayload: fakeOpus,
        });
        ws.send(laf);
      }
    };

    source.connect(processor);
    processor.connect(audioCtx.destination);

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

    broadcastStatus.className = "status success";
    broadcastStatus.textContent = "🔴 LIVE - Broadcasting...";
    btnGoLive.classList.add("hidden");
    btnStopLive.classList.remove("hidden");
  } catch (err: any) {
    console.error("Broadcast start error:", err);
    alert(`Failed to start broadcast: ${err.message}`);
    broadcastStatus.className = "status error";
    broadcastStatus.textContent = `Error: ${err.message}`;
    btnGoLive.disabled = false;
    btnGoLive.textContent = "Go Live";
  }
}

async function stopBroadcast() {
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
  if (currentChannel && streamId) {
    try {
      await apiCall(`/api/me/channels/${currentChannel.id}/stop-live`, {
        method: "POST",
      });
    } catch (err) {
      console.error("Failed to stop stream:", err);
    }
  }
  streamId = null;
  seq = 0;
  meterBar.style.width = "0%";
  broadcastStatus.className = "status info";
  broadcastStatus.textContent = "Ready to go live";
  btnGoLive.classList.remove("hidden");
  btnStopLive.classList.add("hidden");
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
