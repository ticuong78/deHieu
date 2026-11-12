# Sports tags và phạm vi ghép kèo

`tagIds` là tag của **Polymarket Gamma**, không phải sport ID của SPTPUB hay `series`.
Tạo một `polymarket.descriptor` cho mỗi phạm vi muốn theo dõi; ví dụ `tagIds: [100350]`
quét bóng đá, `tagIds: [82]` chỉ Premier League. Giữ `polymarket.stream` và feed
`sptpub.live` / `sptpub.prematch` chạy để có odds hai bên.

## Tag tổng hợp

| Môn / giải                    |    tagId | Mã Polymarket | Sport ID SPTPUB | Kèo được ghép                                                              |
| ----------------------------- | -------: | ------------- | --------------: | -------------------------------------------------------------------------- |
| Bóng đá (mọi giải)            | `100350` | theo giải     |             `1` | Tổng bàn thắng 0.5–6.5; cả hai đội ghi bàn                                 |
| Premier League                |     `82` | `epl`         |             `1` | Như bóng đá                                                                |
| La Liga                       |    `780` | `lal`         |             `1` | Như bóng đá                                                                |
| Bundesliga                    |   `1494` | `bun`         |             `1` | Như bóng đá                                                                |
| Serie A                       | `100618` | `sea`         |             `1` | Như bóng đá                                                                |
| Ligue 1                       | `102070` | `fl1`         |             `1` | Như bóng đá                                                                |
| Champions League              |   `1234` | `ucl`         |             `1` | Như bóng đá                                                                |
| MLS                           | `100100` | `mls`         |             `1` | Như bóng đá                                                                |
| Bóng rổ (các giải có tag này) |     `28` | theo giải     |             `2` | Thắng trận gồm hiệp phụ                                                    |
| NBA                           |    `745` | `nba`         |             `2` | Thắng trận gồm hiệp phụ                                                    |
| WNBA                          | `100254` | `wnba`        |             `2` | Thắng trận gồm hiệp phụ                                                    |
| Tennis                        |    `864` | theo giải     |             `5` | Thắng trận                                                                 |
| Bóng bầu dục Mỹ / NFL         |    `450` | `nfl`         |            `16` | Thắng trận gồm hiệp phụ                                                    |
| Khúc côn cầu / NHL            |    `899` | `nhl`         |             `4` | Thắng trận gồm hiệp phụ và shootout                                        |
| Bóng chày / MLB               | `100381` | `mlb`         |             `3` | Thắng trận gồm extra innings; chưa có trận MLB hiện tại để kiểm chứng feed |
| MMA / UFC                     |    `279` | `ufc`         |           `117` | Thắng trận                                                                 |
| Formula 1                     |    `435` | `f1`          |            `40` | Chưa hỗ trợ: market winner nhiều tay đua                                   |
| Cricket                       |    `517` | theo giải     |            `21` | Chưa hỗ trợ: cần xác minh quy tắc hòa / super over                         |

Các tag esports hiện có: CS2 `100780`, LoL `65`, Dota 2 `102366`, Valorant `101672`.
Không dùng `1` (Sports) hay `100639` (Games) để chọn riêng một môn.

## Để có tín hiệu kèo

Polymarket trả **mã giải** (`epl`, `lal`...) trong event. Translator phân loại môn
từ `sports.sport.tags`; SPTPUB dùng bảng sport ID trong `sptpub-odds.mapping.ts`.
Hai nguồn phải cùng có trận, cùng cặp đội, giờ bắt đầu gần nhau và **cùng loại
kèo**. Tên đội khác nhau (ví dụ tên viết tắt) cần thêm bí danh qua Team Aliases.
Các market ngoài bảng hỗ trợ tiếp tục được đếm `unsupported_market` hoặc
`unsupported_line`.
Các môn truyền thống mới tạo room, tín hiệu và lệnh giấy. Mặc định worker chặn
lệnh thật cho các môn này bằng `SPORT_LIVE_DISABLED`. Để cho phép riêng môn đã
đối chiếu quy tắc thanh toán và hai cửa trên cả hai sàn, đặt
`TRADING_LIVE_SPORTS=soccer` (hoặc danh sách mã môn ngăn bằng dấu phẩy) trong môi
trường của tiến trình chạy trader rồi khởi động lại. Các mã được phép chọn:
`soccer,basketball,tennis,american-football,ice-hockey,baseball,mma`. Bốn môn
esports hiện có vẫn có thể giao dịch thật mà không cần biến này.

Bóng đá có kèo thắng trận ba cửa (chủ nhà / hòa / khách), còn engine hiện tính
kèo hai cửa. Vì vậy translator **không** coi `moneyline` bóng đá là `game-winner`;
chỉ ghép các market hai cửa tương ứng. Không dùng tag F1 để kỳ vọng kèo đua xe
cho đến khi có mô hình nhiều outcome và quy tắc thị trường tương ứng ở hai nguồn.

Lấy danh mục cập nhật từ Gamma API:

```powershell
$sports = Invoke-RestMethod 'https://gamma-api.polymarket.com/sports'
$sports | Select-Object sport, name, tags, series | Format-Table -AutoSize
Invoke-RestMethod 'https://gamma-api.polymarket.com/tags/100350' |
  Select-Object id, slug, label
```

File `samples/polymarket/sports/sports.json` của project cũ là ảnh chụp tại
một thời điểm; API có thể thêm giải và tag mới. `sports.market_types.json` chứa
tên **market type**, không chứa tag. `samples/sptpub/descriptor.json` là mô tả
**market ID** (ví dụ `18` = Total, `219` = Winner gồm hiệp phụ), không phải
danh sách sport ID.
