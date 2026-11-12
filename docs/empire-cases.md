# Tự mở rương thưởng CSGOEmpire

Trong **Auto trade → Tài khoản**, sửa tài khoản CSGOEmpire và bật riêng **Daily Case** và/hoặc **Bonus Cases**, rồi lưu. Daily Case luôn chọn mức **Medium**. Bonus Cases chỉ mở tier đã mở khóa, có ít nhất một key và nút Open đang khả dụng. Các công tắc mặc định tắt cho tài khoản cũ và mới.

Backend kiểm tra mỗi 5 phút (lần đầu khoảng 45 giây sau khi khởi động) qua trang `https://csgoempire.com/rewards` trên đúng hồ sơ Chromium của tài khoản. Cần `REDIS_URL`, `TRADING_SECRET_KEY`, thông tin đăng nhập đã lưu và phiên CSGOEmpire hoạt động. Nếu trang không xác nhận đúng tài khoản, mức Medium hoặc trạng thái có thể mở, lượt đó bỏ qua và ghi lý do vào log `Trading`.

Chức năng chỉ bấm nút **Open** của rương thưởng. Nó không mua key, không bấm **Cash Out**, không bán hay chuyển vật phẩm. Không có migration database vì hai lựa chọn được lưu trong `trading_accounts.config` (JSONB). Khi CSGOEmpire thay đổi giao diện Rewards, cần kiểm tra lại bộ nhận diện nút trong `empire-case-opener.ts`.

Tham khảo: [Daily Cases](https://help.csgoempire.com/en/articles/10491100-daily-cases), [XP & Bonus Cases](https://help.csgoempire.com/en/articles/6089429-xp-bonus-cases).
