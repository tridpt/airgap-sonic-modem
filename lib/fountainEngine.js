/**
 * ⛲ Luby-Transform Optical Fountain Engine + Gauss-Jordan GF(2) Solver
 * - Chia tệp / văn bản mật thành K khối nguồn, sinh vô hạn giọt dữ liệu XOR (Rateless Droplets)
 * - Bất chấp rớt 30%–60% khung hình hay bắt đầu quét giữa chừng, chỉ cần thu đủ K + ~2 giọt bất kỳ
 *   là hệ phương trình tuyến tính trên trường hữu hạn GF(2) giải ra 100% tệp gốc!
 */

const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { crc16Ccitt } = require('./sonicModem');

const FOUNTAIN_MAGIC = 0x46; // 'F'
const FLAG_COMPRESSED = 0x01;
const FLAG_ENCRYPTED = 0x02;

function xorshift32(seed) {
  let x = (seed >>> 0) || 0x9e3779b9;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 0x100000000;
  };
}

/**
 * Deterministically pick XOR block indices from (transferId, dropletSeq, K)
 * Hybrid Soliton + Bridge degree distribution ensures near-zero rank stall!
 */
function pickDropletIndices(transferId, dropletSeq, K) {
  if (K <= 1) return [0];

  // First K droplets include systematic coverage if camera catches from frame 0,
  // while >= K (or missed frames) use full rateless fountain mixing!
  if (dropletSeq < K && dropletSeq % 3 === 0) {
    return [dropletSeq];
  }

  const seed = (((transferId & 0xffff) * 2654435761) ^ ((dropletSeq + 1) * 2246822519) ^ (K * 3266489917)) >>> 0;
  const rand = xorshift32(seed);
  const u = rand();

  let degree = 1;
  if (u < 0.22) {
    degree = 1;
  } else if (u < 0.64) {
    degree = Math.min(K, 2);
  } else if (u < 0.85) {
    degree = Math.min(K, 3);
  } else if (u < 0.94) {
    degree = Math.min(K, 4);
  } else {
    degree = Math.min(K, Math.max(2, Math.ceil(K * 0.5)));
  }

  const chosen = new Set();
  while (chosen.size < degree) {
    chosen.add(Math.floor(rand() * K));
  }
  return Array.from(chosen).sort((a, b) => a - b);
}

function xorInPlace(target, source) {
  for (let i = 0; i < target.length; i++) {
    target[i] ^= source[i];
  }
}

function createFountainStream({
  filename = 'secret-drop.txt',
  content = '',
  isBase64 = false,
  password = '',
  dropletCount = 60
}) {
  const payloadBytes = isBase64
    ? Buffer.from(String(content || ''), 'base64')
    : Buffer.from(String(content ?? ''), 'utf8');

  const bundleJson = Buffer.from(
    JSON.stringify({
      filename: String(filename || 'secret.txt'),
      size: payloadBytes.length,
      dataB64: payloadBytes.toString('base64')
    }),
    'utf8'
  );

  const deflated = zlib.deflateRawSync(bundleJson, { level: 9 });
  let flags = 0;
  let streamBody = bundleJson;
  if (deflated.length < bundleJson.length) {
    flags |= FLAG_COMPRESSED;
    streamBody = deflated;
  }

  const cleanPass = String(password || '').trim();
  if (cleanPass) {
    flags |= FLAG_ENCRYPTED;
    const salt = crypto.randomBytes(8);
    const iv = crypto.randomBytes(12);
    const key = crypto.scryptSync(cleanPass, salt, 32, { N: 16384, r: 8, p: 1 });
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(streamBody), cipher.final()]);
    const tag = cipher.getAuthTag();
    streamBody = Buffer.concat([salt, iv, tag, ct]);
  }

  if (streamBody.length > 16384) {
    throw new Error('Cổng quang học Fountain hỗ trợ gói tối đa 16 KB mỗi phiên.');
  }

  // Fit inside 18x18 4-Color Fiducial Matrix (72 bytes max frame -> 56 bytes max blockSize!)
  const blockSize = streamBody.length <= 768 ? 32 : 52;
  const K = Math.max(1, Math.ceil(streamBody.length / blockSize));

  if (K > 240) {
    throw new Error('Số khối vượt giới hạn khung ma trận quang học (K <= 240).');
  }

  const blocks = [];
  for (let i = 0; i < K; i++) {
    const blk = Buffer.alloc(blockSize);
    const start = i * blockSize;
    const end = Math.min(streamBody.length, start + blockSize);
    if (end > start) {
      streamBody.copy(blk, 0, start, end);
    }
    blocks.push(blk);
  }

  const transferId = crypto.randomInt(1, 65535);
  const totalDroplets = Math.max(K + 18, Number(dropletCount) || K * 3);
  const droplets = [];

  for (let seq = 0; seq < totalDroplets; seq++) {
    const indices = pickDropletIndices(transferId, seq, K);
    const xorBuf = Buffer.alloc(blockSize);
    for (const idx of indices) {
      xorInPlace(xorBuf, blocks[idx]);
    }

    // Header (10 bytes): [0x46, tIdHi, tIdLo, K, blockSize, totalHi, totalLo, flags, seqHi, seqLo]
    const hdr = Buffer.from([
      FOUNTAIN_MAGIC,
      (transferId >> 8) & 0xff,
      transferId & 0xff,
      K & 0xff,
      blockSize & 0xff,
      (streamBody.length >> 8) & 0xff,
      streamBody.length & 0xff,
      flags & 0xff,
      (seq >> 8) & 0xff,
      seq & 0xff
    ]);

    const bodyNoCrc = Buffer.concat([hdr, xorBuf]);
    const crc = crc16Ccitt(bodyNoCrc);
    const frameBuf = Buffer.concat([bodyNoCrc, Buffer.from([(crc >> 8) & 0xff, crc & 0xff])]);

    droplets.push({
      seq,
      degree: indices.length,
      indices,
      frameBase64: frameBuf.toString('base64')
    });
  }

  return {
    transferId,
    K,
    blockSize,
    totalStreamBytes: streamBody.length,
    rawPayloadBytes: payloadBytes.length,
    frameBytes: 12 + blockSize,
    compressed: Boolean(flags & FLAG_COMPRESSED),
    encrypted: Boolean(flags & FLAG_ENCRYPTED),
    droplets
  };
}

/**
 * Online Gauss-Jordan Elimination Decoder over GF(2)
 */
class FountainGaussSolver {
  constructor() {
    this.reset();
  }

  reset() {
    this.transferId = null;
    this.K = 0;
    this.blockSize = 0;
    this.totalBytes = 0;
    this.flags = 0;
    this.pivots = [];
    this.rank = 0;
    this.receivedDroplets = 0;
    this.redundantDroplets = 0;
    this.crcRejected = 0;
    this.seenSeqs = new Set();
  }

  ingestFrame(frameBuf) {
    if (!frameBuf || frameBuf.length < 13 || frameBuf[0] !== FOUNTAIN_MAGIC) {
      this.crcRejected++;
      return { accepted: false, reason: 'invalid_magic' };
    }

    const bodyNoCrc = frameBuf.subarray(0, frameBuf.length - 2);
    const expectedCrc = (frameBuf[frameBuf.length - 2] << 8) | frameBuf[frameBuf.length - 1];
    if (crc16Ccitt(bodyNoCrc) !== expectedCrc) {
      this.crcRejected++;
      return { accepted: false, reason: 'crc_mismatch' };
    }

    const tId = (frameBuf[1] << 8) | frameBuf[2];
    const K = frameBuf[3];
    const blockSize = frameBuf[4];
    const totalBytes = (frameBuf[5] << 8) | frameBuf[6];
    const flags = frameBuf[7];
    const seq = (frameBuf[8] << 8) | frameBuf[9];

    if (frameBuf.length !== 12 + blockSize || K === 0) {
      this.crcRejected++;
      return { accepted: false, reason: 'size_mismatch' };
    }

    if (this.transferId !== tId) {
      this.reset();
      this.transferId = tId;
      this.K = K;
      this.blockSize = blockSize;
      this.totalBytes = totalBytes;
      this.flags = flags;
      this.pivots = new Array(K).fill(null);
    }

    if (this.seenSeqs.has(seq)) {
      return { accepted: true, duplicate: true, complete: this.rank === this.K, rank: this.rank, K: this.K };
    }
    this.seenSeqs.add(seq);
    this.receivedDroplets++;

    if (this.rank === this.K) {
      return { accepted: true, complete: true, rank: this.rank, K: this.K };
    }

    const indices = pickDropletIndices(tId, seq, K);
    let mask = 0n;
    for (const idx of indices) {
      mask |= 1n << BigInt(idx);
    }
    const data = Buffer.from(frameBuf.subarray(10, 10 + blockSize));

    // Step 1: Eliminate all columns that already have pivots
    for (let col = 0; col < K; col++) {
      if (this.pivots[col] && ((mask >> BigInt(col)) & 1n)) {
        mask ^= this.pivots[col].mask;
        xorInPlace(data, this.pivots[col].data);
      }
    }

    if (mask === 0n) {
      this.redundantDroplets++;
      return {
        accepted: true,
        innovative: false,
        complete: false,
        rank: this.rank,
        K: this.K
      };
    }

    // Step 2: Find leading non-zero bit `leadCol`
    let leadCol = -1;
    for (let col = 0; col < K; col++) {
      if ((mask >> BigInt(col)) & 1n) {
        leadCol = col;
        break;
      }
    }

    // Step 3: Gauss-Jordan upward/cross elimination so existing pivots remain diagonalized!
    for (let r = 0; r < K; r++) {
      if (this.pivots[r] && ((this.pivots[r].mask >> BigInt(leadCol)) & 1n)) {
        this.pivots[r].mask ^= mask;
        xorInPlace(this.pivots[r].data, data);
      }
    }

    this.pivots[leadCol] = { mask, data };
    this.rank++;

    return {
      accepted: true,
      innovative: true,
      leadCol,
      complete: this.rank === this.K,
      rank: this.rank,
      K: this.K
    };
  }

  reconstructResult(password = '') {
    if (this.K === 0 || this.rank < this.K) {
      return {
        ok: false,
        error: `Chưa thu đủ hạng ma trận GF(2): hiện đạt ${this.rank}/${this.K} khối độc lập.`
      };
    }

    const joined = Buffer.concat(this.pivots.map((p) => p.data)).subarray(0, this.totalBytes);
    let payload = joined;

    if (this.flags & FLAG_ENCRYPTED) {
      const cleanPass = String(password || '').trim();
      if (!cleanPass) {
        return { ok: false, requiresPassword: true, error: 'Luồng Fountain được khóa bằng AES-256-GCM. Hãy nhập mật khẩu!' };
      }
      try {
        const salt = payload.subarray(0, 8);
        const iv = payload.subarray(8, 20);
        const tag = payload.subarray(20, 36);
        const ct = payload.subarray(36);
        const key = crypto.scryptSync(cleanPass, salt, 32, { N: 16384, r: 8, p: 1 });
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(tag);
        payload = Buffer.concat([decipher.update(ct), decipher.final()]);
      } catch {
        return { ok: false, wrongPassword: true, error: 'Sai mật khẩu giải mã luồng Fountain!' };
      }
    }

    if (this.flags & FLAG_COMPRESSED) {
      payload = zlib.inflateRawSync(payload);
    }

    const bundle = JSON.parse(payload.toString('utf8'));
    const rawBuf = Buffer.from(bundle.dataB64, 'base64');

    return {
      ok: true,
      filename: bundle.filename,
      byteLength: rawBuf.length,
      textPreview: rawBuf.subarray(0, 2000).toString('utf8'),
      dataBase64: bundle.dataB64,
      stats: {
        K: this.K,
        receivedDroplets: this.receivedDroplets,
        redundantDroplets: this.redundantDroplets,
        crcRejected: this.crcRejected,
        overheadDroplets: this.receivedDroplets - this.K
      }
    };
  }
}

module.exports = {
  FOUNTAIN_MAGIC,
  pickDropletIndices,
  createFountainStream,
  FountainGaussSolver
};
