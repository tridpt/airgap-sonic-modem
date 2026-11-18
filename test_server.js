/**
 * 🧪 Mathematical & DSP Verification Suite for AirGap Pulse (Port 4225)
 * Kiểm chứng toàn diện:
 *   1. Toàn bộ 128 trường hợp đảo bit đơn của mã tự sửa lỗi Hamming(8,4) SECDED
 *   2. Truyền sóng âm cận siêu âm 18.5kHz (16-MFSK + AES-256-GCM) xuyên nhiễu AWGN & Echo
 *   3. Mã vòi phun quang học Fountain GF(2) khôi phục 100% file dù rớt mất 45% khung hình
 *   4. Két sắt nhịp gõ mặt bàn bất biến tốc độ (Tempo-Invariant Rhythm Matching)
 */

const assert = require('node:assert/strict');
const { createAppServer } = require('./server');
const { hammingEncodeNibble, hammingDecodeByte } = require('./lib/sonicModem');

async function postJson(baseUrl, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: res.status, json: await res.json() };
}

async function runTests() {
  const server = createAppServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  console.log(`🔍 Đang chạy bộ kiểm định DSP & Lý thuyết Thông tin AirGap Pulse trên :${port}...\n`);

  try {
    // 1. Exhaustive Hamming(8,4) SECDED Single-Bit Repair & Double-Bit Detection
    {
      for (let nib = 0; nib < 16; nib++) {
        const clean = hammingEncodeNibble(nib);
        assert.equal(hammingDecodeByte(clean).nibble, nib);
        assert.equal(hammingDecodeByte(clean).corrected, 0);

        // Flip every single bit 0..7 -> must recover exact nibble!
        for (let bit = 0; bit < 8; bit++) {
          const corrupted = clean ^ (1 << bit);
          const dec = hammingDecodeByte(corrupted);
          assert.equal(dec.nibble, nib, `Failed single-bit repair for nib=${nib}, bit=${bit}`);
          assert.equal(dec.corrected, 1);
        }

        // Flip 2 bits -> must flag doubleError!
        const twoFlip = clean ^ 0b00000101;
        assert.equal(hammingDecodeByte(twoFlip).doubleError, 1);
      }
      console.log('✅ [1/5] Kiểm chứng vét cạn 128/128 trường hợp đảo bit đơn Hamming(8,4) SECDED tự vá chuẩn 100%.');
    }

    // 2. Ultrasonic 18.5kHz 16-MFSK + AES-256-GCM through AWGN Room Noise + Multipath Echo
    {
      const secretMsg = 'TỌA ĐỘ MẬT: 10.7769N, 106.7009E // AIRGAP ULTRASONIC OK!';
      const sim = await postJson(baseUrl, '/api/sonic/simulate-channel', {
        text: secretMsg,
        password: 'ultra-key-4225',
        profileId: 'ultrasonic',
        snrDb: 9,
        echoGain: 0.18,
        corruptSymbolBurst: true
      });
      assert.equal(sim.status, 200);
      assert.equal(sim.json.rxReport.detectedProfile, 'ultrasonic');
      assert.equal(sim.json.rxReport.packet.ok, true);
      assert.equal(sim.json.rxReport.packet.text, secretMsg);
      console.log(
        `✅ [2/5] Sóng âm cận siêu âm 18.5kHz xuyên nhiễu phòng (SNR thực=${sim.json.rxReport.estimatedSnrDb}dB, ECC tự vá=${sim.json.rxReport.fecCorrectedBits} bit) giải mã chuẩn AES-256-GCM!`
      );
    }

    // 3. Audible Cyberpunk Profile Auto-Detection
    {
      const mod = await postJson(baseUrl, '/api/sonic/modulate', {
        text: 'CYBER MODEM BURST #99',
        profileId: 'cyber'
      });
      assert.equal(mod.status, 200);

      const dem = await postJson(baseUrl, '/api/sonic/demodulate', {
        wavBase64: mod.json.wavBase64,
        profileId: 'auto'
      });
      assert.equal(dem.json.detectedProfile, 'cyber');
      assert.equal(dem.json.packet.text, 'CYBER MODEM BURST #99');
      console.log('✅ [3/5] Bộ thu Goertzel tự động nhận diện dải tần Cyber/Ultrasonic & giải điều chế thành công.');
    }

    // 4. Luby-Transform Fountain Code with 45% Dropped Frames + Corrupted Glare Frame + AES-256-GCM
    {
      const bigConfig = JSON.stringify({
        cluster: 'AIRGAP-ZERO-TRUST',
        keys: Array.from({ length: 18 }, (_, i) => `NODE_${i}_KEY_${(i * 987654321).toString(16)}`),
        message: 'Khôi phục nguyên vẹn từ hệ phương trình tuyến tính trên trường hữu hạn GF(2)!'
      }, null, 2);

      const enc = await postJson(baseUrl, '/api/fountain/encode', {
        filename: 'cluster-keys.json',
        content: bigConfig,
        password: 'fountain-pass',
        dropletCount: 95
      });
      assert.equal(enc.status, 200);
      const { K, droplets } = enc.json.stream;
      assert.ok(K >= 6, `Expected multi-block K >= 6, got ${K}`);

      // Drop first 5 frames (camera started late!) + drop every 2nd frame (~45% loss!)
      const surviving = droplets
        .slice(5)
        .filter((_, idx) => idx % 2 === 0 || idx % 5 === 0)
        .map((d) => d.frameBase64);

      // Inject 1 corrupted glare frame in the middle -> CRC-16 must reject it cleanly!
      const badBytes = Buffer.from(surviving[2], 'base64');
      badBytes[12] ^= 0xff;
      surviving.splice(2, 0, badBytes.toString('base64'));

      const dec = await postJson(baseUrl, '/api/fountain/decode', {
        framesBase64: surviving,
        password: 'fountain-pass'
      });
      assert.equal(dec.json.ok, true);
      assert.equal(dec.json.rank, K);
      assert.equal(dec.json.result.filename, 'cluster-keys.json');
      assert.equal(Buffer.from(dec.json.result.dataBase64, 'base64').toString('utf8'), bigConfig);
      assert.equal(dec.json.result.stats.crcRejected, 1);
      console.log(
        `✅ [4/5] Mã vòi phun Fountain GF(2) (K=${K} khối) lọc bỏ khung nhiễu CRC & khôi phục 100% file dù mất ~45% khung hình!`
      );
    }

    // 5. Tempo-Invariant Acoustic Desk-Knock Vault
    {
      const lock = await postJson(baseUrl, '/api/rhythm/lock', {
        intervalsMs: [300, 150, 150, 300],
        secretNote: 'KNOCK_SECRET_UNLOCKED_999'
      });
      assert.equal(lock.status, 200);

      // Knock 1.6x slower -> should STILL unlock thanks to tempo-invariant normalization!
      const goodKnock = await postJson(baseUrl, '/api/rhythm/unlock', {
        vaultId: lock.json.vaultId,
        intervalsMs: [485, 238, 244, 478]
      });
      assert.equal(goodKnock.json.unlocked, true);
      assert.equal(goodKnock.json.secretNote, 'KNOCK_SECRET_UNLOCKED_999');

      // Wrong rhythm -> must reject!
      const badKnock = await postJson(baseUrl, '/api/rhythm/unlock', {
        vaultId: lock.json.vaultId,
        intervalsMs: [200, 500, 500, 150]
      });
      assert.equal(badKnock.json.unlocked, false);
      console.log(`✅ [5/5] Két sắt nhịp gõ mặt bàn khớp chuẩn tỷ lệ tiết tấu (${goodKnock.json.similarityPct}%) bất chấp nhanh/chậm!`);
    }

    console.log('\n🎉 TẤT CẢ 5/5 BÀI KIỂM ĐỊNH TOÁN HỌC & TÍN HIỆU AIRGAP PULSE ĐỀU VƯỢT QUA XUẤT SẮC!');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

runTests().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
