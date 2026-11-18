# 📡 AirGap Pulse — Trạm Modem Không Mạng (Ultrasonic & Optical Fountain)

Trạm truyền tin không cần kết nối mạng (Air-Gap Modem) chạy trên trình duyệt & Node.js:

- **Sóng âm cận siêu âm 18.5kHz (16-MFSK + Goertzel DSP)**: Tự sửa lỗi bit bằng mã **Hamming SECDED**.
- **Cổng quang học Fountain Matrix (Luby Transform / GF(2))**: Truyền dữ liệu qua chuỗi mã ma trận quang học chống rớt khung hình (Gaussian Elimination).
- **Khóa nhịp gõ mặt bàn (Acoustic Rhythm Vault)**: Mở khóa két dữ liệu bằng mẫu nhịp gõ vật lý.

## Khởi chạy nhanh

```bash
node server.js
# Mở trình duyệt tại http://127.0.0.1:4166
```

## Kiểm thử

```bash
npm test
```
