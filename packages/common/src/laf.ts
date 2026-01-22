import { LAF_MAGIC, LAF_VERSION, LAFPacket } from "./types";

/**
 * Layout (big-endian):
 * u32 magic
 * u8  version
 * u8  tier
 * u16 flags
 * u32 streamId
 * u32 seq
 * u64 ptsMs
 * u16 opusLen
 * [opusLen] opusPayload
 */
export function encodeLAF(packet: Omit<LAFPacket, "magic" | "version">): Buffer {
  const opusLen = packet.opusPayload.length;
  const headerLen = 4 + 1 + 1 + 2 + 4 + 4 + 8 + 2;
  const buf = Buffer.allocUnsafe(headerLen + opusLen);
  let offset = 0;

  buf.writeUInt32BE(LAF_MAGIC, offset); offset += 4;
  buf.writeUInt8(LAF_VERSION, offset); offset += 1;
  buf.writeUInt8(packet.tier, offset); offset += 1;
  buf.writeUInt16BE(packet.flags, offset); offset += 2;
  buf.writeUInt32BE(packet.streamId, offset); offset += 4;
  buf.writeUInt32BE(packet.seq, offset); offset += 4;
  buf.writeBigUInt64BE(packet.ptsMs, offset); offset += 8;
  buf.writeUInt16BE(opusLen, offset); offset += 2;

  packet.opusPayload.copy(buf, offset);
  return buf;
}

export function decodeLAF(buf: Buffer): LAFPacket {
  let offset = 0;

  const magic = buf.readUInt32BE(offset); offset += 4;
  if (magic !== LAF_MAGIC) throw new Error(`Invalid LAF magic: 0x${magic.toString(16)}`);

  const version = buf.readUInt8(offset); offset += 1;
  if (version !== LAF_VERSION) throw new Error(`Unsupported LAF version: ${version}`);

  const tier = buf.readUInt8(offset); offset += 1;
  const flags = buf.readUInt16BE(offset); offset += 2;
  const streamId = buf.readUInt32BE(offset); offset += 4;
  const seq = buf.readUInt32BE(offset); offset += 4;
  const ptsMs = buf.readBigUInt64BE(offset); offset += 8;
  const opusLen = buf.readUInt16BE(offset); offset += 2;

  if (buf.length < offset + opusLen) {
    throw new Error("Buffer too short for opus payload");
  }

  const opusPayload = buf.subarray(offset, offset + opusLen);

  return {
    magic,
    version,
    tier,
    flags,
    streamId,
    seq,
    ptsMs,
    opusPayload
  };
}
