# BXH realtime — Trốn Sếp Tan Ca

## 1. Tạo database
Mở Supabase → SQL Editor → chạy toàn bộ file:

`supabase-leaderboard.sql`

## 2. Thêm Environment Variables trên Vercel
Vào Project → Settings → Environment Variables:

- `SUPABASE_URL` = URL project Supabase
- `SUPABASE_ANON_KEY` = anon/public key
- `SUPABASE_SERVICE_ROLE_KEY` = service_role key

**Không đưa `SUPABASE_SERVICE_ROLE_KEY` vào frontend.** File `api/leaderboard.js` chỉ dùng nó phía server.

## 3. Cách hoạt động
- Người chơi nhập nickname một lần.
- Game tự tạo `playerId` và lưu trên thiết bị.
- Khi thắng một màn, thời gian được gửi lên `/api/leaderboard`.
- Mỗi người chỉ giữ thành tích tốt nhất ở từng màn.
- BXH xếp từ thời gian thấp → cao.
- Màn khác nhau có BXH riêng.
- Trang BXH tự cập nhật khoảng 5 giây/lần và dùng Supabase Realtime khi cấu hình Realtime hoạt động.
- Nếu Supabase chưa cấu hình, game vẫn chơi bình thường; chỉ tính năng BXH online không hoạt động.

## 4. Chống gian lận cơ bản
Backend từ chối:
- thời gian dưới 2 giây;
- thời gian trên 15 phút;
- nickname sai độ dài;
- level/playerId không hợp lệ.

Đây là chống gian lận cơ bản. Nếu muốn chống hack mạnh hơn, bước tiếp theo là server xác thực toàn bộ lượt chơi thay vì tin thời gian do trình duyệt gửi lên.
