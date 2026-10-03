TRỐN SẾP TAN CA — Vercel + Gemini

CẤU TRÚC:
index.html
api/gemini.js

DEPLOY:
1. Commit cả index.html và thư mục api lên GitHub.
2. Import repository đó vào Vercel.
3. Vercel Project → Settings → Environment Variables.
4. Add:
   Name: GEMINI_API_KEY
   Value: API key Gemini của bạn
   Environment: Production (có thể chọn Preview/Development nếu cần)
   Type/Visibility: Secret
5. Save.
6. Redeploy.
7. Mở game → Cài đặt → AI trò chuyện → Thử kết nối.

KHÔNG commit API key vào GitHub và không dán API key vào index.html.
