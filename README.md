✅ Yêu cầu môi trường
Node.js ≥ 18 và npm
Hệ điều hành bất kỳ (Linux/Mac/Windows)
(Tùy chọn) Git để clone repo
⬇️ Cài đặt nhanh
# 1) Clone
git clone <URL-repo-của-bạn>.git
cd khkt-react
# 2) Cài đặt phụ thuộc
cd backend && npm i
cd ../frontend && npm i
🔐 Biến môi trường
Backend (backend/.env)
Tạo file backend/.env với nội dung:
# BẮT BUỘC: API key của nhà cung cấp OpenAI-compatible
OPENAI_API_KEY=sk-xxxxx
# Tuỳ chọn: cổng backend (mặc định 8787)
PORT=8787
Hiện tại server.js đang đặt baseURL cứng là:
baseURL: "https://gpt1.shupremium.com/v1"
Nếu bạn dùng nhà cung cấp khác (OpenAI chính thức hoặc 1 cổng tương thích), hãy mở backend/server.js và chỉnh baseURL + model cho phù hợp.
Frontend (frontend/.env – tuỳ chọn)
Nếu muốn trỏ Frontend tới backend không phải localhost:8787:
VITE_API_BASE=http://<host>:<port>
▶️ Chạy dự án
Mở 2 terminal:
Terminal 1 – Backend
cd backend
node server.js
# Server sẽ lắng nghe ở PORT (mặc định 8787)
Terminal 2 – Frontend
cd frontend
npm run dev
# Vite sẽ chạy ở http://localhost:5173 (mặc định)
