/**
 * 🔊 SonicBeam 16-MFSK Acoustic Modem + Hamming(8,4) SECDED + Goertzel DSP
 * - Hỗ trợ 2 dải vật lý:
 *     1. 'ultrasonic' (17.55 kHz – 19.575 kHz): Cận siêu âm tàng hình với tai người lớn
 *     2. 'cyber'      (1.65 kHz – 4.35 kHz)   : Âm thanh Chirp/Modem xuyên phòng cực khỏe
 * - Mã tự sửa lỗi tiến Hamming(8,4) SECDED (tự vá lỗi đảo bit trên không trung) + CRC-16-CCITT
 * - Tích hợp bộ mô phỏng Kênh Nhiễu Phòng Thật (AWGN + Dội tường Multipath Echo)
 */

const crypto = require('node:crypto');
const zlib = require('node:zlib');

const SAMPLE_RATE = 48000;
const PACKET_MAGIC = 0xa5;

const FLAG_COMPRESSED = 0x01;
const FLAG_ENCRYPTED = 0x02;

const PROFILES = {
  ultrasonic: {
    id: 'ultrasonic',
    name: 'Tàng Hình Cận Siêu Âm (17.55 – 19.58 kHz)',
    fSyncA: 17100,
    fSyncB: 17310,
    f0: 17550,
    fStep: 135, // 16 bins: 17550 .. 19575 Hz (safely < 22050 Hz Nyquist!)
    symbolMs: 52,
    guardMs: 12
  },
  cyber: {
    id: 'cyber',
    name: 'Cyberpunk Acoustic Modem (1.65 – 4.35 kHz)',
    fSyncA: 1180,
    fSyncB: 1390,
    f0: 1650,
    fStep: 180, // 16 bins: 1650 .. 4350 Hz
    symbolMs: 42,
    guardMs: 10
  }
};

// ============================================================================
// 1. CRC-16-CCITT & HAMMING(8,4) SECDED FORWARD ERROR CORRECTION
// ============================================================================

function crc16Ccitt(buf) {
  let crc = 0xffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i] << 8;
    for (let b = 0; b < 8; b++) {
      if (crc & 0x8000) {
        crc = ((crc << 1) ^ 0x1021) & 0xffff;
      } else {
        crc = (crc << 1) & 0xffff;
      }
    }
  }
  return crc & 0xffff;
}

function hammingEncodeNibble(nibble) {
  const d0 = nibble & 1;
  const d1 = (nibble >> 1) & 1;
  const d2 = (nibble >> 2) & 1;
  const d3 = (nibble >> 3) & 1;

  const p1 = d0 ^ d1 ^ d3;
  const p2 = d0 ^ d2 ^ d3;
  const p4 = d1 ^ d2 ^ d3;

  const b0 = p1;
  const b1 = p2;
  const b2 = d0;
  const b3 = p4;
  const b4 = d1;
  const b5 = d2;
  const b6 = d3;
  const p8 = b0 ^ b1 ^ b2 ^ b3 ^ b4 ^ b5 ^ b6;

  return (b0 | (b1 << 1) | (b2 << 2) | (b3 << 3) | (b4 << 4) | (b5 << 5) | (b6 << 6) | (p8 << 7)) & 0xff;
}

function hammingDecodeByte(codeByte) {
  let c = codeByte & 0xff;
  const b = (idx) => (c >> idx) & 1;

  const s1 = b(0) ^ b(2) ^ b(4) ^ b(6);
  const s2 = b(1) ^ b(2) ^ b(5) ^ b(6);
  const s4 = b(3) ^ b(4) ^ b(5) ^ b(6);
  const syndrome = s1 | (s2 << 1) | (s4 << 2);

  let overallParity = 0;
  for (let i = 0; i < 8; i++) overallParity ^= b(i);

  let corrected = 0;
  let doubleError = 0;

  if (syndrome !== 0) {
    if (overallParity === 1) {
      // Single-bit error at 1-indexed position `syndrome` -> flip bit (syndrome - 1)
      c ^= 1 << (syndrome - 1);
      corrected = 1;
    } else {
      // Double-bit error detected
      doubleError = 1;
    }
  } else if (overallParity === 1) {
    // Parity bit b7 itself flipped
    corrected = 1;
  }

  const nibble = ((c >> 2) & 1) | (((c >> 4) & 1) << 1) | (((c >> 5) & 1) << 2) | (((c >> 6) & 1) << 3);
  return { nibble, corrected, doubleError };
}

function encodeBytesWithFec(buf) {
  const symbols = [];
  for (let i = 0; i < buf.length; i++) {
    const hiNib = (buf[i] >> 4) & 0x0f;
    const loNib = buf[i] & 0x0f;
    const cHi = hammingEncodeNibble(hiNib);
    const cLo = hammingEncodeNibble(loNib);
    // Each 8-bit Hamming codeword splits into two 4-bit MFSK symbols (0..15)
    symbols.push((cHi >> 4) & 0x0f, cHi & 0x0f, (cLo >> 4) & 0x0f, cLo & 0x0f);
  }
  return symbols;
}

function decodeSymbolsWithFec(symbols) {
  const byteCount = Math.floor(symbols.length / 4);
  const out = Buffer.alloc(byteCount);
  let correctedBits = 0;
  let doubleErrors = 0;

  for (let i = 0; i < byteCount; i++) {
    const cHi = ((symbols[i * 4] & 0x0f) << 4) | (symbols[i * 4 + 1] & 0x0f);
    const cLo = ((symbols[i * 4 + 2] & 0x0f) << 4) | (symbols[i * 4 + 3] & 0x0f);

    const dHi = hammingDecodeByte(cHi);
    const dLo = hammingDecodeByte(cLo);
    correctedBits += dHi.corrected + dLo.corrected;
    doubleErrors += dHi.doubleError + dLo.doubleError;

    out[i] = ((dHi.nibble & 0x0f) << 4) | (dLo.nibble & 0x0f);
  }

  return { buffer: out, correctedBits, doubleErrors };
}

// ============================================================================
// 2. PACKET ENVELOPE (DEFLATE + OPTIONAL AES-256-GCM)
// ============================================================================

function packAirPacket(text, password = '') {
  const raw = Buffer.from(String(text ?? ''), 'utf8');
  const deflated = zlib.deflateRawSync(raw, { level: 9 });

  let flags = 0;
  let body = raw;
  if (deflated.length + 2 < raw.length) {
    flags |= FLAG_COMPRESSED;
    body = deflated;
  }

  const cleanPass = String(password || '').trim();
  if (cleanPass) {
    flags |= FLAG_ENCRYPTED;
    const salt = crypto.randomBytes(6);
    const iv = crypto.randomBytes(12);
    const key = crypto.scryptSync(cleanPass, salt, 32, { N: 16384, r: 8, p: 1 });
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(body), cipher.final()]);
    const tag = cipher.getAuthTag().subarray(0, 12); // 96-bit GCM tag keeps acoustic burst brisk
    body = Buffer.concat([salt, iv, tag, ct]);
  }

  if (body.length > 1024) {
    throw new Error('Gói sóng âm tối đa 1 KB. Với dữ liệu lớn hơn hãy dùng Cổng Quang Học Fountain (Trạm 02)!');
  }

  const headerNoCrc = Buffer.from([
    PACKET_MAGIC,
    flags,
    (body.length >> 8) & 0xff,
    body.length & 0xff
  ]);
  const crc = crc16Ccitt(Buffer.concat([headerNoCrc, body]));
  const crcBuf = Buffer.from([(crc >> 8) & 0xff, crc & 0xff]);

  return {
    frame: Buffer.concat([headerNoCrc, crcBuf, body]),
    rawBytes: raw.length,
    compressed: Boolean(flags & FLAG_COMPRESSED),
    encrypted: Boolean(flags & FLAG_ENCRYPTED)
  };
}

function unpackAirPacket(frameBuf, password = '') {
  if (!frameBuf || frameBuf.length < 6 || frameBuf[0] !== PACKET_MAGIC) {
    return { ok: false, error: 'Không bắt được đầu gói chuẩn (Magic 0xA5).' };
  }

  const flags = frameBuf[1];
  const bodyLen = (frameBuf[2] << 8) | frameBuf[3];
  const expectedCrc = (frameBuf[4] << 8) | frameBuf[5];

  if (6 + bodyLen > frameBuf.length) {
    return { ok: false, error: 'Độ dài khung giải điều chế bị thiếu hụt.' };
  }

  const body = frameBuf.subarray(6, 6 + bodyLen);
  const actualCrc = crc16Ccitt(Buffer.concat([frameBuf.subarray(0, 4), body]));

  if (actualCrc !== expectedCrc) {
    return {
      ok: false,
      crcMismatch: true,
      error: `Sai lệch kiểm tra CRC-16 (0x${actualCrc.toString(16)} != 0x${expectedCrc.toString(16)}). Nhiễu vượt ngưỡng sửa lỗi.`
    };
  }

  let payload = body;
  if (flags & FLAG_ENCRYPTED) {
    const cleanPass = String(password || '').trim();
    if (!cleanPass) {
      return { ok: false, requiresPassword: true, error: 'Bản tin sóng âm đã khóa AES-256-GCM. Hãy nhập mật khẩu!' };
    }
    try {
      const salt = body.subarray(0, 6);
      const iv = body.subarray(6, 18);
      const tag = body.subarray(18, 30);
      const ct = body.subarray(30);
      const key = crypto.scryptSync(cleanPass, salt, 32, { N: 16384, r: 8, p: 1 });
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 12 });
      decipher.setAuthTag(tag);
      payload = Buffer.concat([decipher.update(ct), decipher.final()]);
    } catch {
      return { ok: false, wrongPassword: true, error: 'Sai mật khẩu giải mã AES-256-GCM!' };
    }
  }

  if (flags & FLAG_COMPRESSED) {
    try {
      payload = zlib.inflateRawSync(payload);
    } catch {
      return { ok: false, error: 'Lỗi giải nén Deflate.' };
    }
  }

  return {
    ok: true,
    encrypted: Boolean(flags & FLAG_ENCRYPTED),
    compressed: Boolean(flags & FLAG_COMPRESSED),
    text: payload.toString('utf8')
  };
}

// ============================================================================
// 3. 16-MFSK AUDIO SYNTHESIZER & ROOM NOISE CHANNEL SIMULATOR
// ============================================================================

function floatSamplesToWav(samples, sampleRate = SAMPLE_RATE) {
  const dataLen = samples.length * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataLen, 40);

  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  return buf;
}

function wavToFloatSamples(wavBuf) {
  if (!wavBuf || wavBuf.length < 44 || wavBuf.toString('ascii', 0, 4) !== 'RIFF') {
    throw new Error('Dữ liệu không phải định dạng chuẩn RIFF WAVE.');
  }
  let offset = 12;
  let sampleRate = SAMPLE_RATE;
  let channels = 1;
  let bitsPerSample = 16;
  let dataStart = 44;
  let dataLen = wavBuf.length - 44;

  while (offset + 8 <= wavBuf.length) {
    const id = wavBuf.toString('ascii', offset, offset + 4);
    const sz = wavBuf.readUInt32LE(offset + 4);
    if (id === 'fmt ') {
      channels = wavBuf.readUInt16LE(offset + 10);
      sampleRate = wavBuf.readUInt32LE(offset + 12);
      bitsPerSample = wavBuf.readUInt16LE(offset + 22);
    } else if (id === 'data') {
      dataStart = offset + 8;
      dataLen = Math.min(sz, wavBuf.length - dataStart);
      break;
    }
    offset += 8 + sz + (sz & 1);
  }

  const bytesPerSample = Math.max(1, bitsPerSample >> 3);
  const frameSize = bytesPerSample * channels;
  const count = Math.floor(dataLen / frameSize);
  const out = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    const pos = dataStart + i * frameSize;
    out[i] = bitsPerSample === 16
      ? wavBuf.readInt16LE(pos) / 32768
      : (wavBuf.readUInt8(pos) - 128) / 128;
  }
  return { samples: out, sampleRate };
}

function modulateAcousticPacket({
  text = 'AIRGAP PING 4225',
  password = '',
  profileId = 'ultrasonic'
}) {
  const profile = PROFILES[profileId] || PROFILES.ultrasonic;
  const packed = packAirPacket(text, password);
  const dataSymbols = encodeBytesWithFec(packed.frame);

  // Tone schedule: [Silence 60ms] + [SYNC_A, SYNC_B, SYNC_A, SYNC_B] + dataSymbols + [SYNC_A] + [Silence 60ms]
  const toneFreqs = [
    profile.fSyncA,
    profile.fSyncB,
    profile.fSyncA,
    profile.fSyncB,
    ...dataSymbols.map((sym) => profile.f0 + sym * profile.fStep),
    profile.fSyncA
  ];

  const symSamples = Math.round((profile.symbolMs / 1000) * SAMPLE_RATE);
  const guardSamples = Math.round((profile.guardMs / 1000) * SAMPLE_RATE);
  const strideSamples = symSamples + guardSamples;
  const padSamples = Math.round(0.06 * SAMPLE_RATE);

  const totalSamples = padSamples * 2 + toneFreqs.length * strideSamples;
  const pcm = new Float32Array(totalSamples);
  const ramp = Math.max(8, Math.floor(symSamples * 0.12));

  for (let t = 0; t < toneFreqs.length; t++) {
    const freq = toneFreqs[t];
    const start = padSamples + t * strideSamples;
    const omega = (2 * Math.PI * freq) / SAMPLE_RATE;

    for (let i = 0; i < symSamples; i++) {
      let env = 0.85;
      if (i < ramp) {
        env *= 0.5 * (1 - Math.cos((Math.PI * i) / ramp));
      } else if (i > symSamples - ramp) {
        env *= 0.5 * (1 - Math.cos((Math.PI * (symSamples - i)) / ramp));
      }
      pcm[start + i] = Math.sin(omega * i) * env;
    }
  }

  return {
    wavBuffer: floatSamplesToWav(pcm, SAMPLE_RATE),
    pcmSamples: pcm,
    telemetry: {
      profile: profile.id,
      profileName: profile.name,
      sampleRate: SAMPLE_RATE,
      durationSec: Number((totalSamples / SAMPLE_RATE).toFixed(2)),
      rawBytes: packed.rawBytes,
      frameBytes: packed.frame.length,
      totalSymbols: dataSymbols.length,
      effectiveBps: Math.round((packed.rawBytes * 8) / (totalSamples / SAMPLE_RATE)),
      compressed: packed.compressed,
      encrypted: packed.encrypted,
      freqRangeHz: [profile.f0, profile.f0 + 15 * profile.fStep],
      symbolsPreview: dataSymbols.slice(0, 64)
    }
  };
}

/**
 * Simulate real acoustic room propagation: AWGN noise + wall echo + narrowband spike
 */
function applyRoomChannelNoise(cleanSamples, {
  snrDb = 12,
  echoGain = 0.18,
  echoDelayMs = 14,
  corruptSymbolBurst = false,
  profileId = 'ultrasonic',
  symbolsPreview = []
} = {}) {
  const n = cleanSamples.length;
  const noisy = new Float32Array(n);

  // Measure signal RMS
  let sigPow = 0;
  for (let i = 0; i < n; i++) sigPow += cleanSamples[i] * cleanSamples[i];
  sigPow /= Math.max(1, n);

  const snrLinear = Math.pow(10, Number(snrDb) / 10);
  const noiseStd = Math.sqrt(sigPow / Math.max(0.05, snrLinear));
  const delaySamples = Math.round((echoDelayMs / 1000) * SAMPLE_RATE);

  let seed = 0x2468ace1;
  const randUniform = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return (seed + 1) / 4294967297;
  };
  const randGaussian = () => {
    const u1 = randUniform();
    const u2 = randUniform();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  };

  for (let i = 0; i < n; i++) {
    const echo = i >= delaySamples ? cleanSamples[i - delaySamples] * echoGain : 0;
    noisy[i] = Math.max(-1, Math.min(1, cleanSamples[i] + echo + randGaussian() * noiseStd));
  }

  // Inject real in-band adjacent-bin tone interference (flips 1 bit in 2 distinct Hamming codewords!)
  if (corruptSymbolBurst && symbolsPreview.length >= 20) {
    const profile = PROFILES[profileId] || PROFILES.ultrasonic;
    const symSamples = Math.round((profile.symbolMs / 1000) * SAMPLE_RATE);
    const guardSamples = Math.round((profile.guardMs / 1000) * SAMPLE_RATE);
    const stride = symSamples + guardSamples;
    const padSamples = Math.round(0.06 * SAMPLE_RATE);

    for (const targetSymIdx of [10, 18]) {
      const origSym = symbolsPreview[targetSymIdx] ?? 0;
      const flippedSym = origSym ^ 0x01; // 1-bit flip into adjacent MFSK tone!
      const jamFreq = profile.f0 + flippedSym * profile.fStep;
      const start = padSamples + (4 + targetSymIdx) * stride;
      const omega = (2 * Math.PI * jamFreq) / SAMPLE_RATE;
      for (let i = 0; i < symSamples && start + i < n; i++) {
        noisy[start + i] = Math.sin(omega * i) * 0.92;
      }
    }
  }

  return noisy;
}

// ============================================================================
// 4. GOERTZEL NARROWBAND FILTER BANK & AUTOMATIC PREAMBLE SYNC DEMODULATOR
// ============================================================================

function goertzelPower(samples, start, length, targetFreq, sampleRate) {
  if (start < 0 || start + length > samples.length || length <= 0) return 0;
  const omega = (2 * Math.PI * targetFreq) / sampleRate;
  const coeff = 2 * Math.cos(omega);
  let s1 = 0;
  let s2 = 0;
  const end = start + length;

  for (let i = start; i < end; i++) {
    // Light Hann window reduces spectral leakage between adjacent MFSK bins!
    const rel = i - start;
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * rel) / length);
    const s0 = samples[i] * w + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }

  return (s1 * s1 + s2 * s2 - coeff * s1 * s2) / (length * length);
}

function demodulateAcousticSamples(samples, sampleRate, {
  profileId = 'auto',
  password = ''
} = {}) {
  const candidates = profileId === 'auto'
    ? [PROFILES.ultrasonic, PROFILES.cyber]
    : [PROFILES[profileId] || PROFILES.ultrasonic];

  let bestAttempt = null;

  for (const profile of candidates) {
    const symSamples = Math.round((profile.symbolMs / 1000) * sampleRate);
    const guardSamples = Math.round((profile.guardMs / 1000) * sampleRate);
    const stride = symSamples + guardSamples;
    const hop = Math.max(16, Math.round(0.004 * sampleRate)); // 4ms fine sync search

    // Scan first 60% of audio for 4-symbol [SYNC_A, SYNC_B, SYNC_A, SYNC_B] preamble peak
    const maxSearch = Math.max(hop, samples.length - stride * 8);
    let bestScore = -1;
    let bestSyncStart = 0;

    for (let pos = 0; pos < maxSearch; pos += hop) {
      const pA1 = goertzelPower(samples, pos, symSamples, profile.fSyncA, sampleRate);
      if (pA1 < 1e-7) continue;
      const pB1 = goertzelPower(samples, pos + stride, symSamples, profile.fSyncB, sampleRate);
      const pA2 = goertzelPower(samples, pos + stride * 2, symSamples, profile.fSyncA, sampleRate);
      const pB2 = goertzelPower(samples, pos + stride * 3, symSamples, profile.fSyncB, sampleRate);
      // Contrast score rejects broadband claps!
      const cross = goertzelPower(samples, pos, symSamples, profile.fSyncB, sampleRate);
      const score = (pA1 + pB1 + pA2 + pB2) - cross * 2.5;
      if (score > bestScore) {
        bestScore = score;
        bestSyncStart = pos;
      }
    }

    if (bestScore <= 1e-6) continue;

    const dataStart = bestSyncStart + stride * 4;
    const maxSymbols = Math.floor((samples.length - dataStart) / stride);
    if (maxSymbols < 24) continue; // Minimum 6 header bytes = 24 symbols

    const readSymbolAt = (symIdx) => {
      const sPos = dataStart + symIdx * stride;
      let maxP = -1;
      let winner = 0;
      const energies = new Array(16);
      let sumP = 0;

      for (let bin = 0; bin < 16; bin++) {
        const p = goertzelPower(samples, sPos, symSamples, profile.f0 + bin * profile.fStep, sampleRate);
        energies[bin] = p;
        sumP += p;
        if (p > maxP) {
          maxP = p;
          winner = bin;
        }
      }
      const noiseAvg = (sumP - maxP) / 15 + 1e-12;
      const snrEstDb = 10 * Math.log10(maxP / noiseAvg);
      return { winner, energies, snrEstDb };
    };

    // Decode first 24 symbols (6 header bytes!) to learn exact packet byte length!
    const hdrSyms = [];
    const symbolSpectra = [];
    let snrAccum = 0;

    for (let s = 0; s < 24; s++) {
      const r = readSymbolAt(s);
      hdrSyms.push(r.winner);
      snrAccum += r.snrEstDb;
      // Normalize energies 0..255 for UI waterfall
      const peak = Math.max(...r.energies, 1e-9);
      symbolSpectra.push(r.energies.map((e) => Math.round((e / peak) * 255)));
    }

    const hdrDecoded = decodeSymbolsWithFec(hdrSyms);
    if (hdrDecoded.buffer[0] !== PACKET_MAGIC) {
      continue;
    }

    const bodyLen = (hdrDecoded.buffer[2] << 8) | hdrDecoded.buffer[3];
    const totalPacketBytes = 6 + bodyLen;
    const totalNeededSyms = totalPacketBytes * 4;

    if (totalNeededSyms > maxSymbols || bodyLen > 1024) {
      continue;
    }

    const allSyms = [...hdrSyms];
    for (let s = 24; s < totalNeededSyms; s++) {
      const r = readSymbolAt(s);
      allSyms.push(r.winner);
      snrAccum += r.snrEstDb;
      if (symbolSpectra.length < 96) {
        const peak = Math.max(...r.energies, 1e-9);
        symbolSpectra.push(r.energies.map((e) => Math.round((e / peak) * 255)));
      }
    }

    const fullFec = decodeSymbolsWithFec(allSyms);
    const unpacked = unpackAirPacket(fullFec.buffer, password);

    const attempt = {
      detectedProfile: profile.id,
      profileName: profile.name,
      estimatedSnrDb: Number((snrAccum / totalNeededSyms).toFixed(1)),
      totalSymbolsDecoded: totalNeededSyms,
      fecCorrectedBits: fullFec.correctedBits,
      fecDoubleErrors: fullFec.doubleErrors,
      symbolSpectra,
      packet: unpacked
    };

    if (unpacked.ok || !bestAttempt) {
      bestAttempt = attempt;
      if (unpacked.ok) break;
    }
  }

  if (!bestAttempt) {
    return {
      ok: false,
      error: 'Không tìm thấy chuỗi đồng bộ sóng âm MFSK hợp lệ trong bản thu.'
    };
  }

  return {
    ok: bestAttempt.packet.ok,
    ...bestAttempt
  };
}

function demodulateAcousticWav(wavBuffer, opts = {}) {
  const { samples, sampleRate } = wavToFloatSamples(wavBuffer);
  return demodulateAcousticSamples(samples, sampleRate, opts);
}

module.exports = {
  SAMPLE_RATE,
  PROFILES,
  crc16Ccitt,
  hammingEncodeNibble,
  hammingDecodeByte,
  modulateAcousticPacket,
  applyRoomChannelNoise,
  floatSamplesToWav,
  demodulateAcousticSamples,
  demodulateAcousticWav
};
