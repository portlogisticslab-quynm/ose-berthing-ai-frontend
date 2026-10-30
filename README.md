# Berthing AI Advisory System – frontend (berthingai.ose.vn) · V3.6.3

Trang tĩnh (HTML/JS, không cần build) cho Cloudflare Pages: Build command `exit 0`, Output directory `.`.

| File | Vai trò |
|---|---|
| `index.html`, `css/app.css` | Giao diện (8 tab, trong đó có **Live Berthing** – demo) |
| `config.js` | `API_BASE_URL`: backend Berthing AI (relay Port-SHM). Chạy trên máy (127.0.0.1/localhost) → `http://127.0.0.1:8025` |
| `js/berthing-core.js` | Lõi tính toán dùng chung (bản sao y hệt trong backend) |
| `js/app.js`, `js/server-bridge.js` | Các tab Risk / Trajectory / Animation (CaseID) / Safe Policy |
| `js/live-berthing-core.js`, `js/live-berthing.js` | Tab Live Berthing: mô phỏng, dự báo, mặt bằng, gửi Port-SHM |
| `js/live-animation-integration.js` | Tab Animation – chế độ "Live Berthing" (cùng mặt bằng theo tỷ lệ) |
| `_headers` | CSP và các header bảo mật của Cloudflare Pages |

Chạy thử trên máy: `python -m http.server 5500`, mở `http://127.0.0.1:5500`.

Gửi sang Port-SHM: tab Live Berthing → tích **"Gửi dự báo (mô phỏng) → Port-SHM"** → nhập Relay Token → ▶ Phát.
Mỗi 5 s thời gian sự kiện có một bản tin. Các bản tin được gửi theo lô qua backend, và kết quả lúc chạm bến được gửi kèm lô cuối.
