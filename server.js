/**
 * 📡🔊📷 AirGap Pulse — Trạm Modem Truyền Tin & Bắn File Không Mạng (Port 4225)
 * ----------------------------------------------------------------------------
 *   1. SonicBeam 16-MFSK Modem: Truyền tin nhắn mật qua sóng âm cận siêu âm 18.5kHz
 *      (hoặc chế độ Cyberpunk Chirp) kèm mã tự sửa lỗi Hamming(8,4) SECDED & giải mã Goertzel.
 *   2. Optical Fountain Stream: Truyền tệp qua chuỗi mã ma trận 4 màu (Luby-Transform
 *      Rateless Fountain Codes + Khử Gauss-Jordan GF(2)) bất chấp rớt 40% khung hình Webcam!
 *   3. Acoustic Knock Vault   : Mở két sắt mật mã chỉ bằng nhịp gõ tay lên mặt bàn gỗ
 *      thu qua Micro (chuẩn hóa tỷ lệ nhịp bất biến tốc độ Tempo-Invariant).
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const {
  modulateAcousticPacket,
  applyRoomChannelNoise,
  floatSamplesToWav,
  demodulateAcousticWav
} = require('./lib/sonicModem');

const {
  createFountainStream,
  FountainGaussSolver
} = require('./lib/fountainEngine');

const PORT = Number(process.env.PORT || 4166);
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 24 * 1024 * 1024;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav'
};

// Pre-seeded Shave-and-a-Haircut rhythm vault ("Cốc - Cốc-Cốc - Cốc - Cốc ... Cốc - Cốc")
const RHYTHM_VAULTS = new Map();

function normalizeRhythmRatios(intervalsMs = []) {
  const clean = intervalsMs.map((v) => Math.max(40, Number(v) || 0)).filter((v) => v > 0);
  if (clean.length < 2) return null;
  const sum = clean.reduce((s, v) => s + v, 0);
  return clean.map((v) => Number((v / sum).toFixed(4)));
}

function registerDefaultKnockVault() {
  // Classic 5-tap secret knock (4 intervals: [1, 0.5, 0.5, 1] -> "Cốc ... Cốc-Cốc-Cốc ... Cốc")
  const defaultRatios = normalizeRhythmRatios([400, 200, 200, 400]);
  RHYTHM_VAULTS.set('DEFAULT-VAULT', {
    vaultId: 'DEFAULT-VAULT',
    label: 'Nhịp Mặc Định 5 Tiếng ("Cốc — Cốc·Cốc·Cốc — Cốc")',
    tapCount: 5,
    ratios: defaultRatios,
    secretNote: '🔓 KÉT SẮT GÕ BÀN ĐÃ MỞ! Mã truy cập kho lạnh Air-Gap: SONIC-VAULT-4225'
  });
}
registerDefaultKnockVault();

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > MAX_BODY) {
        reject(new Error('Dữ liệu gửi lên vượt quá 24 MB.'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('Định dạng JSON không hợp lệ.'));
      }
    });
    req.on('error', reject);
  });
}

function stripDataUrl(str) {
  if (!str || typeof str !== 'string') return '';
  const idx = str.indexOf(',');
  return idx !== -1 && str.startsWith('data:') ? str.slice(idx + 1) : str;
}

function createAppServer() {
  return http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      });
      res.end();
      return;
    }

    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = parsedUrl.pathname;

    try {
      if (req.method === 'GET' && pathname === '/api/health') {
        return sendJson(res, 200, {
          ok: true,
          app: 'AirGap Pulse — Ultrasonic & Optical Fountain Modem',
          port: PORT,
          channels: ['ultrasonic-16mfsk-secded', 'optical-gf2-fountain', 'acoustic-knock-vault']
        });
      }

      // ----------------------------------------------------------------------
      // 1. SONIC 16-MFSK MODEM + AWGN CHANNEL LAB
      // ----------------------------------------------------------------------
      if (req.method === 'POST' && pathname === '/api/sonic/modulate') {
        const body = await readJsonBody(req);
        if (!String(body.text ?? '').trim()) {
          return sendJson(res, 400, { ok: false, error: 'Vui lòng nhập bản tin cần phát qua sóng âm.' });
        }
        const mod = modulateAcousticPacket({
          text: body.text,
          password: body.password || '',
          profileId: body.profileId || 'ultrasonic'
        });
        return sendJson(res, 200, {
          ok: true,
          wavBase64: mod.wavBuffer.toString('base64'),
          telemetry: mod.telemetry
        });
      }

      if (req.method === 'POST' && pathname === '/api/sonic/demodulate') {
        const body = await readJsonBody(req);
        const rawB64 = stripDataUrl(body.wavBase64);
        if (!rawB64) {
          return sendJson(res, 400, { ok: false, error: 'Thiếu dữ liệu âm thanh .WAV để giải điều chế.' });
        }
        const wavBuf = Buffer.from(rawB64, 'base64');
        const result = demodulateAcousticWav(wavBuf, {
          profileId: body.profileId || 'auto',
          password: body.password || ''
        });
        return sendJson(res, 200, result);
      }

      if (req.method === 'POST' && pathname === '/api/sonic/simulate-channel') {
        const body = await readJsonBody(req);
        const mod = modulateAcousticPacket({
          text: body.text || 'AIRGAP PING 4225',
          password: body.password || '',
          profileId: body.profileId || 'ultrasonic'
        });

        const noisyPcm = applyRoomChannelNoise(mod.pcmSamples, {
          snrDb: body.snrDb ?? 10,
          echoGain: body.echoGain ?? 0.18,
          echoDelayMs: body.echoDelayMs ?? 14,
          corruptSymbolBurst: Boolean(body.corruptSymbolBurst),
          profileId: mod.telemetry.profile,
          symbolsPreview: mod.telemetry.symbolsPreview
        });

        const noisyWav = floatSamplesToWav(noisyPcm, mod.telemetry.sampleRate);
        const decoded = demodulateAcousticWav(noisyWav, {
          profileId: body.profileId || 'ultrasonic',
          password: body.password || ''
        });

        return sendJson(res, 200, {
          ok: true,
          noisyWavBase64: noisyWav.toString('base64'),
          txTelemetry: mod.telemetry,
          rxReport: decoded
        });
      }

      // ----------------------------------------------------------------------
      // 2. OPTICAL LUBY-TRANSFORM FOUNTAIN STREAM
      // ----------------------------------------------------------------------
      if (req.method === 'POST' && pathname === '/api/fountain/encode') {
        const body = await readJsonBody(req);
        if (!String(body.content ?? '').trim()) {
          return sendJson(res, 400, { ok: false, error: 'Vui lòng nhập dữ liệu hoặc chọn tệp để phát luồng Fountain.' });
        }
        const stream = createFountainStream({
          filename: body.filename || 'airgap-secret.txt',
          content: body.isBase64 ? stripDataUrl(body.content) : body.content,
          isBase64: Boolean(body.isBase64),
          password: body.password || '',
          dropletCount: body.dropletCount
        });
        return sendJson(res, 200, { ok: true, stream });
      }

      if (req.method === 'POST' && pathname === '/api/fountain/decode') {
        const body = await readJsonBody(req);
        const frames = Array.isArray(body.framesBase64) ? body.framesBase64 : [];
        if (frames.length === 0) {
          return sendJson(res, 400, { ok: false, error: 'Chưa có khung hình Fountain nào được thu nhận.' });
        }

        const solver = new FountainGaussSolver();
        const rankTimeline = [];

        for (const fB64 of frames) {
          const buf = Buffer.from(stripDataUrl(fB64), 'base64');
          const step = solver.ingestFrame(buf);
          rankTimeline.push({
            rank: solver.rank,
            K: solver.K,
            innovative: Boolean(step.innovative)
          });
          if (step.complete) break;
        }

        const reconstructed = solver.reconstructResult(body.password || '');
        return sendJson(res, 200, {
          ok: reconstructed.ok,
          rank: solver.rank,
          K: solver.K,
          rankTimeline,
          result: reconstructed
        });
      }

      // ----------------------------------------------------------------------
      // 3. TEMPO-INVARIANT ACOUSTIC KNOCK RHYTHM VAULT
      // ----------------------------------------------------------------------
      if (req.method === 'POST' && pathname === '/api/rhythm/lock') {
        const body = await readJsonBody(req);
        const ratios = normalizeRhythmRatios(body.intervalsMs);
        if (!ratios) {
          return sendJson(res, 400, { ok: false, error: 'Cần gõ ít nhất 3 tiếng (2 khoảng nghỉ) để tạo khóa nhịp!' });
        }
        const vaultId = 'VLT-' + crypto.randomBytes(3).toString('hex').toUpperCase();
        RHYTHM_VAULTS.set(vaultId, {
          vaultId,
          label: `Khóa Nhịp Tự Tạo (${ratios.length + 1} tiếng gõ)`,
          tapCount: ratios.length + 1,
          ratios,
          secretNote: String(body.secretNote || 'Bí mật được bảo vệ bằng nhịp gõ mặt bàn!')
        });
        return sendJson(res, 200, {
          ok: true,
          vaultId,
          tapCount: ratios.length + 1,
          ratios
        });
      }

      if (req.method === 'POST' && pathname === '/api/rhythm/unlock') {
        const body = await readJsonBody(req);
        const vault = RHYTHM_VAULTS.get(body.vaultId || 'DEFAULT-VAULT') || RHYTHM_VAULTS.get('DEFAULT-VAULT');
        const candidate = normalizeRhythmRatios(body.intervalsMs);

        if (!candidate || candidate.length !== vault.ratios.length) {
          return sendJson(res, 200, {
            ok: true,
            unlocked: false,
            similarityPct: 0,
            message: `Số tiếng gõ chưa khớp! Két này yêu cầu đúng ${vault.tapCount} tiếng gõ (${vault.ratios.length} khoảng nghỉ).`
          });
        }

        let l1Diff = 0;
        for (let i = 0; i < vault.ratios.length; i++) {
          l1Diff += Math.abs(vault.ratios[i] - candidate[i]);
        }
        const similarityPct = Math.max(0, Math.round((1 - l1Diff * 1.25) * 100));
        const unlocked = similarityPct >= 80;

        return sendJson(res, 200, {
          ok: true,
          unlocked,
          similarityPct,
          expectedRatios: vault.ratios,
          actualRatios: candidate,
          secretNote: unlocked ? vault.secretNote : null,
          message: unlocked
            ? `✅ Khớp nhịp ${similarityPct}%! Đã mở khóa két sắt âm học!`
            : `❌ Độ khớp nhịp chỉ đạt ${similarityPct}% (Cần >= 80%). Hãy gõ đều nhịp hơn!`
        });
      }

      // ----------------------------------------------------------------------
      // STATIC FRONTEND
      // ----------------------------------------------------------------------
      if (req.method === 'GET' || req.method === 'HEAD') {
        const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
        const safePath = path.normalize(path.join(PUBLIC_DIR, rel));
        if (!safePath.startsWith(PUBLIC_DIR)) {
          res.writeHead(403);
          res.end('Forbidden');
          return;
        }
        if (fs.existsSync(safePath) && fs.statSync(safePath).isFile()) {
          const ext = path.extname(safePath).toLowerCase();
          res.writeHead(200, {
            'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
            'Cache-Control': 'no-cache'
          });
          if (req.method === 'HEAD') res.end();
          else fs.createReadStream(safePath).pipe(res);
          return;
        }
      }

      sendJson(res, 404, { ok: false, error: '404 Not Found' });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message || 'Internal Server Error' });
    }
  });
}

if (require.main === module) {
  const server = createAppServer();
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`\n📡🔊📷 AirGap Pulse đang chạy tại: http://127.0.0.1:${PORT}`);
    console.log('   • Trạm 01: Modem Sóng Âm 16-MFSK (Cận siêu âm 18.5kHz / Cyber) + Tự sửa lỗi Hamming SECDED');
    console.log('   • Trạm 02: Cổng Quang Học Fountain Matrix (GF(2) Gauss-Jordan chống rớt khung hình)');
    console.log('   • Trạm 03: Két Sắt Mở Bằng Nhịp Gõ Mặt Bàn Không Chạm (Acoustic Knock Vault)\n');
  });
}

module.exports = { createAppServer };
