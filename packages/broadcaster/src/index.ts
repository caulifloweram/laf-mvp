import fs from "fs";
import { WebSocket } from "ws";
import { decode } from "wav-decoder";
import OpusScript from "opusscript";
import { encodeLAF } from "@laf/common/src/laf";
import { TIERS, FRAME_DURATION_MS, SAMPLES_PER_FRAME, SAMPLE_RATE } from "./tiers";

const RELAY_URL = process.env.LAF_RELAY_URL ?? "ws://localhost:9000/?role=broadcaster&streamId=1";
const WAV_PATH = process.env.LAF_WAV_PATH ?? "input.wav";
const STREAM_ID = Number(process.env.LAF_STREAM_ID ?? 1);

async function loadWavMono(): Promise<Float32Array> {
  const buf = fs.readFileSync(WAV_PATH);
  const decoded = await decode(buf);
  const channelData = decoded.channelData[0];
  const srcRate = decoded.sampleRate;

  if (srcRate === SAMPLE_RATE) {
    return channelData;
  }

  // Naive resample
  const ratio = SAMPLE_RATE / srcRate;
  const outLength = Math.floor(channelData.length * ratio);
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    out[i] = channelData[Math.min(Math.floor(i / ratio), channelData.length - 1)];
  }
  return out;
}

function floatToPCM16(frame: Float32Array): Buffer {
  const buf = Buffer.allocUnsafe(frame.length * 2);
  for (let i = 0; i < frame.length; i++) {
    let s = frame[i];
    if (s > 1) s = 1;
    if (s < -1) s = -1;
    const v = s < 0 ? s * 0x8000 : s * 0x7fff;
    buf.writeInt16LE(v | 0, i * 2);
  }
  return buf;
}

async function main() {
  if (!fs.existsSync(WAV_PATH)) {
    console.error(`WAV file not found: ${WAV_PATH}`);
    console.error("Set LAF_WAV_PATH environment variable or place input.wav in current directory");
    process.exit(1);
  }

  const samples = await loadWavMono();
  const frames: Float32Array[] = [];
  for (let i = 0; i + SAMPLES_PER_FRAME <= samples.length; i += SAMPLES_PER_FRAME) {
    frames.push(samples.subarray(i, i + SAMPLES_PER_FRAME));
  }
  if (frames.length === 0) throw new Error("WAV too short");

  const encoders = TIERS.map((t) => {
    const enc = new (OpusScript as any)(SAMPLE_RATE, t.channels, OpusScript.Application.AUDIO);
    enc.setBitrate(t.bitrate);
    return { tier: t.tier, encoder: enc, config: t };
  });

  const ws = new WebSocket(RELAY_URL);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", (err) => reject(err));
  });
  console.log("Broadcaster connected to relay", RELAY_URL);

  let baseStartMs = Date.now();
  let seqByTier = new Map<number, number>();

  async function loop() {
    let frameIndex = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const now = Date.now();
      const elapsed = now - baseStartMs;
      const targetFrameIndex = Math.floor(elapsed / FRAME_DURATION_MS);
      if (frameIndex > targetFrameIndex) {
        await new Promise((r) => setTimeout(r, 2));
        continue;
      }

      const frame = frames[frameIndex % frames.length];
      const pcm = floatToPCM16(frame);
      const ptsMs = BigInt(elapsed);

      for (const { tier, encoder } of encoders) {
        const seq = (seqByTier.get(tier) ?? 0) + 1;
        seqByTier.set(tier, seq);

        const opus = Buffer.from(encoder.encode(pcm, SAMPLES_PER_FRAME));
        const laf = encodeLAF({
          tier,
          flags: 0,
          streamId: STREAM_ID,
          seq,
          ptsMs,
          opusPayload: opus
        });

        if (ws.readyState === WebSocket.OPEN) {
          ws.send(laf, { binary: true });
        }
      }

      frameIndex++;
    }
  }

  loop().catch((err) => {
    console.error("Broadcaster loop error", err);
    process.exit(1);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
