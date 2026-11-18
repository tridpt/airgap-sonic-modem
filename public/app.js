/* ==========================================================================
 * AirGap Pulse — Interactive Physical Modem Controller (Port 4225)
 * ========================================================================== */

(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  let toastTimer = null;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 3300);
  }

  async function apiPost(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function bytesToB64(bytes) {
    let bin = '';
    const CHUNK = 8192;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }

  function downloadBytes(bytes, filename, mime) {
    const url = URL.createObjectURL(new Blob([bytes], { type: mime || 'application/octet-stream' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  // Tab Switching
  $$('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('.tab').forEach((b) => b.classList.toggle('active', b === btn));
      $$('.panel').forEach((p) => p.classList.toggle('active', p.id === btn.dataset.tab));
    });
  });

  // ==========================================================================
  // TRẠM 01: ULTRASONIC & CYBERPUNK 16-MFSK ACOUSTIC MODEM
  // ==========================================================================

  const mfskCanvas = $('#mfsk-canvas');
  const mCtx = mfskCanvas.getContext('2d');
  let lastTxWavBytes = null;

  $('#sonic-snr').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    const desc = v >= 18 ? 'Phòng yên tĩnh' : v >= 8 ? 'Quán cà phê ồn' : 'Nhiễu bão khắc nghiệt';
    $('#snr-val-lbl').textContent = `${v} dB (${desc})`;
  });

  function renderMfskSpectra(symbolSpectra = []) {
    mCtx.fillStyle = '#030711';
    mCtx.fillRect(0, 0, mfskCanvas.width, mfskCanvas.height);

    if (!symbolSpectra || symbolSpectra.length === 0) return;

    const cols = symbolSpectra.length;
    const rows = 16;
    const cellW = mfskCanvas.width / cols;
    const cellH = mfskCanvas.height / rows;

    for (let c = 0; c < cols; c++) {
      const colBins = symbolSpectra[c];
      for (let b = 0; b < rows; b++) {
        // Draw high bin at top (row 0 = bin 15)
        const val = colBins[15 - b] || 0;
        const norm = val / 255;
        const r = Math.round(norm > 0.7 ? (norm - 0.7) * 800 : 12);
        const g = Math.round(norm * 235);
        const bl = Math.round(Math.min(255, norm * 310));
        mCtx.fillStyle = `rgb(${r},${g},${bl})`;
        mCtx.fillRect(c * cellW, b * cellH, Math.ceil(cellW), Math.ceil(cellH) - 1);
      }
    }
  }

  function displaySonicRxReport(rep) {
    renderMfskSpectra(rep.symbolSpectra || []);
    $('#rx-prof').textContent = rep.detectedProfile === 'ultrasonic' ? '18.5kHz Stealth' : (rep.detectedProfile === 'cyber' ? 'Cyber MFSK' : '—');
    $('#rx-snr').textContent = rep.estimatedSnrDb !== undefined ? `${rep.estimatedSnrDb} dB` : '—';
    $('#rx-ecc').textContent = `${rep.fecCorrectedBits || 0} bits đã vá`;
    $('#rx-crc').textContent = rep.packet?.ok ? '✅ HỢP LỆ' : '❌ LỖI';

    if (rep.packet && rep.packet.ok) {
      $('#sonic-rx-output').textContent = rep.packet.text;
    } else {
      $('#sonic-rx-output').textContent = `⚠️ ${rep.packet?.error || rep.error || 'Không giải mã được gói tin.'}`;
    }
  }

  $('#btn-sonic-play-tx').addEventListener('click', async () => {
    try {
      const data = await apiPost('/api/sonic/modulate', {
        text: $('#sonic-msg').value,
        password: $('#sonic-pass').value,
        profileId: $('#sonic-profile').value
      });
      lastTxWavBytes = b64ToBytes(data.wavBase64);
      const audio = $('#sonic-audio-el');
      audio.src = URL.createObjectURL(new Blob([lastTxWavBytes], { type: 'audio/wav' }));
      audio.classList.remove('hidden');
      audio.play().catch(() => {});
      $('#btn-sonic-dl-wav').disabled = false;
      toast(`🔊 Đang phát ${data.telemetry.totalSymbols} nốt MFSK (${data.telemetry.durationSec}s, ${data.telemetry.effectiveBps} bps)!`);
    } catch (err) {
      toast('❌ ' + err.message);
    }
  });

  $('#btn-sonic-dl-wav').addEventListener('click', () => {
    if (!lastTxWavBytes) return;
    downloadBytes(lastTxWavBytes, 'airgap-sonic-packet.wav', 'audio/wav');
  });

  async function runSonicChannelSim() {
    try {
      const data = await apiPost('/api/sonic/simulate-channel', {
        text: $('#sonic-msg').value,
        password: $('#sonic-pass').value,
        profileId: $('#sonic-profile').value,
        snrDb: Number($('#sonic-snr').value),
        echoGain: 0.2,
        corruptSymbolBurst: $('#sonic-burst').checked
      });

      lastTxWavBytes = b64ToBytes(data.noisyWavBase64);
      const audio = $('#sonic-audio-el');
      audio.src = URL.createObjectURL(new Blob([lastTxWavBytes], { type: 'audio/wav' }));
      audio.classList.remove('hidden');
      $('#btn-sonic-dl-wav').disabled = false;

      // Sync password field for convenience if user entered one
      if ($('#sonic-pass').value && !$('#sonic-rx-pass').value) {
        $('#sonic-rx-pass').value = $('#sonic-pass').value;
      }

      displaySonicRxReport(data.rxReport);
      toast(`✅ Đã giải mã qua nhiễu phòng! Hamming(8,4) đã tự vá ${data.rxReport.fecCorrectedBits || 0} bit hỏng!`);
    } catch (err) {
      toast('❌ ' + err.message);
    }
  }

  $('#btn-sonic-sim').addEventListener('click', runSonicChannelSim);
  $('#btn-sonic-quick').addEventListener('click', runSonicChannelSim);

  $('#sonic-wav-upload').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const buf = new Uint8Array(await file.arrayBuffer());
    const rep = await apiPost('/api/sonic/demodulate', {
      wavBase64: bytesToB64(buf),
      profileId: 'auto',
      password: $('#sonic-rx-pass').value
    });
    displaySonicRxReport(rep);
    toast('📂 Đã phân tích xong file .WAV!');
  });

  // Live 5-Second Microphone Capture -> PCM WAV -> Goertzel Demodulate
  function encodeFloat32ToWavBytes(samples, sampleRate) {
    const len = samples.length * 2;
    const buf = new ArrayBuffer(44 + len);
    const dv = new DataView(buf);
    const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
    writeStr(0, 'RIFF');
    dv.setUint32(4, 36 + len, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true);
    dv.setUint16(22, 1, true);
    dv.setUint32(24, sampleRate, true);
    dv.setUint32(28, sampleRate * 2, true);
    dv.setUint16(32, 2, true);
    dv.setUint16(34, 16, true);
    writeStr(36, 'data');
    dv.setUint32(40, len, true);
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      dv.setInt16(44 + i * 2, Math.round(s * 32767), true);
    }
    return new Uint8Array(buf);
  }

  $('#btn-mic-rx').addEventListener('click', async () => {
    const btn = $('#btn-mic-rx');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      });
      const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
      const src = ctx.createMediaStreamSource(stream);
      const proc = ctx.createScriptProcessor(4096, 1, 1);
      const chunks = [];

      proc.onaudioprocess = (ev) => {
        chunks.push(new Float32Array(ev.inputBuffer.getChannelData(0)));
      };
      src.connect(proc);
      proc.connect(ctx.destination);

      btn.disabled = true;
      btn.textContent = '🔴 Đang lắng nghe sóng âm (5s)...';
      toast('🎙️ Hãy phát sóng âm từ thiết bị phát ngay bây giờ!');

      setTimeout(async () => {
        proc.disconnect();
        src.disconnect();
        stream.getTracks().forEach((t) => t.stop());
        const total = chunks.reduce((s, c) => s + c.length, 0);
        const merged = new Float32Array(total);
        let off = 0;
        for (const c of chunks) { merged.set(c, off); off += c.length; }

        const wavBytes = encodeFloat32ToWavBytes(merged, ctx.sampleRate);
        ctx.close();
        btn.disabled = false;
        btn.textContent = '🎙️ Thu Sóng Âm Qua Micro (5 Giây)';

        const rep = await apiPost('/api/sonic/demodulate', {
          wavBase64: bytesToB64(wavBytes),
          profileId: 'auto',
          password: $('#sonic-rx-pass').value
        });
        displaySonicRxReport(rep);
      }, 5000);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = '🎙️ Thu Sóng Âm Qua Micro (5 Giây)';
      toast('❌ Lỗi mở Micro: ' + err.message);
    }
  });

  // ==========================================================================
  // TRẠM 02: OPTICAL FOUNTAIN 4-COLOR MATRIX & GF(2) SOLVER
  // ==========================================================================

  const ftCanvas = $('#ft-matrix-canvas');
  const ftCtx = ftCanvas.getContext('2d');
  const GRID_N = 18; // 18x18 cells (4 corners 3x3 = 36 fiducial cells -> 288 data cells = 72 bytes!)
  const PALETTE_4 = [
    '#070b14', // 00: Deep Black
    '#00e5ff', // 01: Electric Cyan
    '#00e676', // 10: Bio Emerald
    '#ffd54f'  // 11: Solar Amber
  ];

  let activeFountainStream = null;
  let ftTimer = null;
  let ftFrameIdx = 0;
  let uploadedFtFile = null;
  let recoveredFileBundle = null;

  $('#ft-drop-rate').addEventListener('input', (e) => {
    $('#drop-rate-lbl').textContent = `${e.target.value}%`;
  });

  $('#ft-file-upload').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 14000) {
      toast('⚠️ Vui lòng chọn tệp <= 14 KB cho luồng quang học!');
      return;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    uploadedFtFile = { name: file.name, b64: bytesToB64(bytes) };
    $('#ft-filename').value = file.name;
    $('#ft-content').value = `[Tệp nhị phân đã nạp: ${file.name} (${file.size} bytes)]`;
    toast(`📎 Đã nạp tệp "${file.name}" vào bộ phát Fountain!`);
  });

  function isCornerFiducial(r, c) {
    const tl = r < 3 && c < 3;
    const tr = r < 3 && c >= GRID_N - 3;
    const bl = r >= GRID_N - 3 && c < 3;
    const br = r >= GRID_N - 3 && c >= GRID_N - 3;
    return tl || tr || bl || br;
  }

  function drawBullseye(x0, y0, cellPx, outerColor) {
    ftCtx.fillStyle = outerColor;
    ftCtx.fillRect(x0, y0, cellPx * 3, cellPx * 3);
    ftCtx.fillStyle = '#04070f';
    ftCtx.fillRect(x0 + cellPx * 0.55, y0 + cellPx * 0.55, cellPx * 1.9, cellPx * 1.9);
    ftCtx.fillStyle = '#ffffff';
    ftCtx.fillRect(x0 + cellPx * 1.05, y0 + cellPx * 1.05, cellPx * 0.9, cellPx * 0.9);
  }

  function drawOpticalDropletFrame(frameBytes) {
    const cellPx = ftCanvas.width / GRID_N;
    ftCtx.fillStyle = '#04070f';
    ftCtx.fillRect(0, 0, ftCanvas.width, ftCanvas.height);

    // 4 Orientation-Unique Color Bullseyes!
    drawBullseye(0, 0, cellPx, '#00e5ff');
    drawBullseye((GRID_N - 3) * cellPx, 0, cellPx, '#00e676');
    drawBullseye(0, (GRID_N - 3) * cellPx, cellPx, '#ffd54f');
    drawBullseye((GRID_N - 3) * cellPx, (GRID_N - 3) * cellPx, cellPx, '#ff4081');

    // Pack bytes into 2-bit symbols (4 symbols per byte)
    const dibits = [];
    for (let i = 0; i < frameBytes.length; i++) {
      const b = frameBytes[i];
      dibits.push((b >> 6) & 3, (b >> 4) & 3, (b >> 2) & 3, b & 3);
    }

    let dPtr = 0;
    for (let r = 0; r < GRID_N; r++) {
      for (let c = 0; c < GRID_N; c++) {
        if (isCornerFiducial(r, c)) continue;
        const sym = dPtr < dibits.length ? dibits[dPtr++] : 0;
        ftCtx.fillStyle = PALETTE_4[sym];
        ftCtx.fillRect(c * cellPx + 1, r * cellPx + 1, cellPx - 2, cellPx - 2);
      }
    }
  }

  // Draw initial idle pattern
  drawOpticalDropletFrame(new Uint8Array(44).map((_, i) => (i * 73) & 0xff));

  async function ensureFountainStream() {
    const isBin = Boolean(uploadedFtFile && $('#ft-content').value.startsWith('[Tệp nhị phân'));
    const data = await apiPost('/api/fountain/encode', {
      filename: $('#ft-filename').value,
      content: isBin ? uploadedFtFile.b64 : $('#ft-content').value,
      isBase64: isBin,
      password: $('#ft-pass').value,
      dropletCount: 90
    });
    activeFountainStream = data.stream;
    return activeFountainStream;
  }

  $('#btn-ft-start').addEventListener('click', async () => {
    try {
      clearInterval(ftTimer);
      const stream = await ensureFountainStream();
      ftFrameIdx = 0;
      const fps = Number($('#ft-fps').value) || 12;
      $('#btn-ft-stop').disabled = false;

      ftTimer = setInterval(() => {
        const drop = stream.droplets[ftFrameIdx % stream.droplets.length];
        drawOpticalDropletFrame(b64ToBytes(drop.frameBase64));
        $('#ft-tx-info').textContent =
          `Giọt #${drop.seq} • Trộn XOR d=${drop.degree} khối [${drop.indices.join(',')}] • K=${stream.K} khối`;
        ftFrameIdx++;
      }, Math.round(1000 / fps));

      toast(`🌈 Đang chiếu luồng Fountain (${stream.K} khối nguồn, ${fps} FPS)!`);
    } catch (err) {
      toast('❌ ' + err.message);
    }
  });

  $('#btn-ft-stop').addEventListener('click', () => {
    clearInterval(ftTimer);
    ftTimer = null;
    $('#btn-ft-stop').disabled = true;
  });

  async function runFountainLossSimulation() {
    try {
      clearInterval(ftTimer);
      const stream = await ensureFountainStream();
      const dropRate = (Number($('#ft-drop-rate').value) || 38) / 100;

      // Randomly drop `dropRate` fraction of droplets to simulate camera glare / missed frames!
      const survivingDroplets = stream.droplets.filter(() => Math.random() >= dropRate);
      if (survivingDroplets.length === 0) {
        toast('⚠️ Tỷ lệ rớt quá cao khiến 0 khung nào lọt qua — Hãy thử lại!');
        return;
      }

      const decodeRes = await apiPost('/api/fountain/decode', {
        framesBase64: survivingDroplets.map((d) => d.frameBase64),
        password: $('#ft-pass').value
      });

      // Animate rank growth step by step so user sees Gauss-Jordan elimination live!
      const gridEl = $('#ft-blocks-grid');
      gridEl.innerHTML = Array.from({ length: stream.K }, (_, i) =>
        `<div class="blk-cell" id="ft-blk-${i}">B${i}</div>`
      ).join('');

      const timeline = decodeRes.rankTimeline || [];
      let step = 0;

      const anim = setInterval(() => {
        if (step >= timeline.length) {
          clearInterval(anim);
          if (decodeRes.ok && decodeRes.result.ok) {
            recoveredFileBundle = decodeRes.result;
            $('#ft-rx-output').textContent =
              `✅ ĐÃ GIẢI XONG HỆ PHƯƠNG TRÌNH GF(2) (Dù bị rớt mất ${Math.round(dropRate * 100)}% khung hình)!\n` +
              `• Khối nguồn K = ${stream.K} | Số giọt thu được = ${decodeRes.result.stats.receivedDroplets} (Chỉ cần dư +${decodeRes.result.stats.overheadDroplets} giọt!)\n` +
              `• Tên tệp: ${decodeRes.result.filename} (${decodeRes.result.byteLength} bytes)\n\n` +
              decodeRes.result.textPreview;
            $('#btn-ft-download').classList.remove('hidden');
            toast('🎉 Khôi phục 100% tệp gốc bất chấp rớt khung hình!');
          } else {
            $('#ft-rx-output').textContent = `⚠️ ${decodeRes.result?.error || 'Chưa đủ giọt độc lập tuyến tính.'}`;
          }
          return;
        }

        const item = timeline[step];
        const dropObj = survivingDroplets[step];
        if (dropObj) {
          drawOpticalDropletFrame(b64ToBytes(dropObj.frameBase64));
        }

        const pct = Math.round((item.rank / Math.max(1, item.K)) * 100);
        $('#ft-rank-fill').style.width = `${pct}%`;
        $('#ft-rank-text').textContent = `GF(2) Rank: ${item.rank} / ${item.K} khối (${pct}%)`;

        for (let b = 0; b < item.rank; b++) {
          $(`#ft-blk-${b}`)?.classList.add('solved');
        }
        step++;
      }, 55);
    } catch (err) {
      toast('❌ ' + err.message);
    }
  }

  $('#btn-ft-sim-rx').addEventListener('click', runFountainLossSimulation);
  $('#btn-fountain-quick').addEventListener('click', runFountainLossSimulation);

  $('#btn-ft-download').addEventListener('click', () => {
    if (!recoveredFileBundle) return;
    downloadBytes(
      b64ToBytes(recoveredFileBundle.dataBase64),
      recoveredFileBundle.filename,
      'application/octet-stream'
    );
  });

  // Webcam Scanner for 18x18 4-Color Optical Fountain Frames
  let webcamStream = null;
  let webcamTimer = null;

  $('#btn-ft-webcam').addEventListener('click', async () => {
    const video = $('#ft-video');
    if (webcamStream) {
      clearInterval(webcamTimer);
      webcamStream.getTracks().forEach((t) => t.stop());
      webcamStream = null;
      video.classList.add('hidden');
      $('#btn-ft-webcam').textContent = '📷 Quét Bằng Webcam Thật';
      return;
    }

    try {
      webcamStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 } }
      });
      video.srcObject = webcamStream;
      video.classList.remove('hidden');
      $('#btn-ft-webcam').textContent = '⏹️ Tắt Webcam';
      toast('📷 Hãy đưa khung mã 4 màu vào chính giữa khung hình Webcam!');

      const capCanvas = document.createElement('canvas');
      capCanvas.width = 360;
      capCanvas.height = 360;
      const capCtx = capCanvas.getContext('2d', { willReadFrequently: true });
      const collectedB64 = [];

      webcamTimer = setInterval(async () => {
        if (!video.videoWidth) return;
        const side = Math.min(video.videoWidth, video.videoHeight) * 0.75;
        const sx = (video.videoWidth - side) / 2;
        const sy = (video.videoHeight - side) / 2;
        capCtx.drawImage(video, sx, sy, side, side, 0, 0, 360, 360);

        const cellPx = 360 / GRID_N;
        const dibits = [];
        for (let r = 0; r < GRID_N; r++) {
          for (let c = 0; c < GRID_N; c++) {
            if (isCornerFiducial(r, c)) continue;
            const px = capCtx.getImageData(Math.floor((c + 0.5) * cellPx), Math.floor((r + 0.5) * cellPx), 1, 1).data;
            const [red, green, blue] = px;
            // Classify nearest 4-color symbol
            let sym = 0;
            if (red + green + blue < 140) sym = 0;           // Black
            else if (red > 165 && green > 150) sym = 3;      // Amber
            else if (blue > green + 25) sym = 1;             // Cyan
            else sym = 2;                                    // Emerald
            dibits.push(sym);
          }
        }

        const byteLen = Math.floor(dibits.length / 4);
        const raw = new Uint8Array(byteLen);
        for (let i = 0; i < byteLen; i++) {
          raw[i] = (dibits[i * 4] << 6) | (dibits[i * 4 + 1] << 4) | (dibits[i * 4 + 2] << 2) | dibits[i * 4 + 3];
        }

        // Check FOUNTAIN_MAGIC (0x46) & plausible blockSize
        if (raw[0] === 0x46 && (raw[4] === 32 || raw[4] === 52)) {
          const frameLen = 12 + raw[4];
          const frameSlice = raw.subarray(0, frameLen);
          collectedB64.push(bytesToB64(frameSlice));
          if (collectedB64.length >= raw[3] + 2) {
            const dec = await apiPost('/api/fountain/decode', {
              framesBase64: collectedB64,
              password: $('#ft-pass').value
            });
            $('#ft-rank-text').textContent = `Webcam GF(2) Rank: ${dec.rank} / ${dec.K}`;
            if (dec.ok && dec.result.ok) {
              recoveredFileBundle = dec.result;
              $('#ft-rx-output').textContent = dec.result.textPreview;
              $('#btn-ft-download').classList.remove('hidden');
              clearInterval(webcamTimer);
              toast('🎉 Đã quét & khôi phục thành công qua Webcam!');
            }
          }
        }
      }, 95);
    } catch (err) {
      toast('❌ Không mở được Webcam: ' + err.message);
    }
  });

  // ==========================================================================
  // TRẠM 03: ACOUSTIC DESK-TAP RHYTHM VAULT
  // ==========================================================================

  let tapTimestamps = [];
  let activeVaultId = 'DEFAULT-VAULT';
  let autoEvalTimer = null;
  let knockMicStream = null;
  let knockAnimId = null;

  function recordTapImpulse() {
    const now = performance.now();
    if (tapTimestamps.length > 0 && now - tapTimestamps[tapTimestamps.length - 1] < 130) {
      return; // Debounce desk acoustic ringing
    }

    tapTimestamps.push(now);
    const pad = $('#knock-pad');
    pad.classList.add('flash');
    setTimeout(() => pad.classList.remove('flash'), 95);
    $('#knock-count').textContent = `${tapTimestamps.length} tiếng gõ`;

    renderTapTimeline();

    clearTimeout(autoEvalTimer);
    if (tapTimestamps.length >= 3) {
      autoEvalTimer = setTimeout(evaluateKnockSequence, 1250);
    }
  }

  function renderTapTimeline() {
    const el = $('#knock-timeline');
    el.innerHTML = '';
    for (let i = 0; i < tapTimestamps.length; i++) {
      const dot = document.createElement('div');
      dot.className = 'tap-dot';
      el.appendChild(dot);

      if (i < tapTimestamps.length - 1) {
        const dt = tapTimestamps[i + 1] - tapTimestamps[i];
        const gap = document.createElement('div');
        gap.className = 'tap-gap';
        gap.style.width = `${Math.min(140, Math.max(12, Math.round(dt * 0.16)))}px`;
        gap.title = `${Math.round(dt)} ms`;
        el.appendChild(gap);
      }
    }
  }

  function getIntervalsFromTaps() {
    const out = [];
    for (let i = 0; i < tapTimestamps.length - 1; i++) {
      out.push(Math.round(tapTimestamps[i + 1] - tapTimestamps[i]));
    }
    return out;
  }

  async function evaluateKnockSequence() {
    const intervals = getIntervalsFromTaps();
    if (intervals.length < 2) return;
    try {
      const res = await apiPost('/api/rhythm/unlock', {
        vaultId: activeVaultId,
        intervalsMs: intervals
      });
      $('#knock-output').textContent = res.unlocked
        ? `${res.message}\n\n${res.secretNote}`
        : `${res.message}\n• Tỷ lệ chuẩn: [${(res.expectedRatios || []).join(', ')}]\n• Tỷ lệ bạn gõ: [${(res.actualRatios || []).join(', ')}]`;

      if (res.unlocked) toast('🔓 Đúng tiết tấu mật ước — Két sắt đã mở!');
    } catch (err) {
      toast('❌ ' + err.message);
    }
  }

  $('#knock-pad').addEventListener('pointerdown', recordTapImpulse);
  $('#btn-knock-pad').addEventListener('click', recordTapImpulse);

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && $('#panel-knock').classList.contains('active') && document.activeElement?.tagName !== 'INPUT') {
      e.preventDefault();
      recordTapImpulse();
    }
  });

  $('#btn-knock-reset').addEventListener('click', () => {
    tapTimestamps = [];
    $('#knock-count').textContent = '0 tiếng gõ';
    $('#knock-timeline').innerHTML = '';
  });

  $('#btn-knock-save-custom').addEventListener('click', async () => {
    const intervals = getIntervalsFromTaps();
    try {
      const res = await apiPost('/api/rhythm/lock', {
        intervalsMs: intervals,
        secretNote: $('#knock-custom-secret').value
      });
      activeVaultId = res.vaultId;
      tapTimestamps = [];
      $('#knock-count').textContent = '0 tiếng gõ (Đã lưu khóa mới!)';
      $('#knock-timeline').innerHTML = '';
      $('#knock-output').textContent = `🔐 Đã tạo Két mới [${res.vaultId}] gồm ${res.tapCount} tiếng gõ! Hãy gõ lại đúng tiết tấu vừa rồi để mở khóa!`;
      toast('💾 Đã lưu nhịp gõ riêng của bạn làm chìa khóa!');
    } catch (err) {
      toast('❌ ' + err.message);
    }
  });

  // Real Microphone Desk-Knock Transient Detector
  $('#btn-knock-mic').addEventListener('click', async () => {
    const btn = $('#btn-knock-mic');
    if (knockMicStream) {
      cancelAnimationFrame(knockAnimId);
      knockMicStream.getTracks().forEach((t) => t.stop());
      knockMicStream = null;
      btn.textContent = '🎙️ Bật Micro Nghe Tiếng Gõ Mặt Bàn';
      return;
    }

    try {
      knockMicStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const src = ctx.createMediaStreamSource(knockMicStream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);

      const buf = new Float32Array(analyser.fftSize);
      let rollingAvg = 0.01;
      btn.textContent = '⏹️ Đang Nghe Tiếng Gõ Bàn (Bấm để tắt)';
      toast('✊ Hãy gõ ngón tay lên mặt bàn gỗ theo nhịp mật ước!');

      function detectTransient() {
        if (!knockMicStream) return;
        analyser.getFloatTimeDomainData(buf);
        let peak = 0;
        for (let i = 0; i < buf.length; i++) {
          const a = Math.abs(buf[i]);
          if (a > peak) peak = a;
        }
        if (peak > Math.max(0.14, rollingAvg * 4.2)) {
          recordTapImpulse();
        }
        rollingAvg = rollingAvg * 0.94 + peak * 0.06;
        knockAnimId = requestAnimationFrame(detectTransient);
      }
      knockAnimId = requestAnimationFrame(detectTransient);
    } catch (err) {
      toast('❌ Không mở được Micro: ' + err.message);
    }
  });
})();
