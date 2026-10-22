# Thuật ngữ và cách hệ thống chạy

Hệ thống nhận giá từ SptPub và Polymarket, gom các báo giá tương ứng, rồi tìm cơ hội arbitrage. Trang web giúp quan sát và điều khiển quá trình này. Các tên đội, ID và thời gian trong ví dụ là dữ liệu minh họa.

## Bắt đầu từ một ví dụ

Alliance gặp Sinners. Hai nền tảng đưa ra giá khác nhau cho cùng câu hỏi: **đội nào thắng trận?**

| Nguồn      | Alliance thắng | Sinners thắng |
| ---------- | -------------- | ------------- |
| SptPub     | 1.80           | 2.20          |
| Polymarket | 2.10           | 1.90          |

Chỉ cần nhớ bốn điều:

1. **Một ô số là một odds.** Ví dụ `1.80`: cược 100 và thắng thì nhận tổng 180, gồm 100 vốn và 80 lãi, trước phí.
2. **Một hàng là một báo giá của một nguồn.** Code gọi hàng đó là `OddsLine`, giao diện hiện gọi là **dòng kèo**. Bộ odds của SptPub là `[1.80, 2.20]`.
3. **Cả bảng nằm trong một room.** Room này chỉ dành cho trận Alliance gặp Sinners và loại cược thắng trận.
4. **Hệ thống thử ghép hai ô thuộc hai nguồn khác nhau.** Ví dụ Alliance thắng ở Polymarket (`2.10`) và Sinners thắng ở SptPub (`2.20`). Nếu đạt điều kiện, hệ thống phát một **tín hiệu cơ hội arbitrage**. Giao diện hiện gọi tín hiệu này là **kèo**.

Hai báo giá gốc vẫn nằm trong room sau khi phát tín hiệu. Một dòng kèo không bị lấy ra khỏi room hoặc biến thành tín hiệu.

## Những tên cần nhớ

### Về trận và giá

| Tên trên web hoặc trong code | Hiểu đơn giản                                                        | Ví dụ                                   |
| ---------------------------- | -------------------------------------------------------------------- | --------------------------------------- |
| Tenant                       | Nguồn cung cấp dữ liệu; không phải người dùng đăng nhập web          | `sptpub`, `polymarket`                  |
| Sport                        | Môn thi đấu                                                          | `cs2`, `lol`                            |
| Match / Trận đấu             | Một cặp đội trong một môn; có thể có nhiều loại cược                 | Alliance gặp Sinners                    |
| Market                       | Một loại cược cụ thể, gồm cả mức chấp, mốc tổng hoặc số map nếu có   | Thắng trận, thắng map 1, tổng map 2.5   |
| Side / Phía                  | Một trong hai kết quả của market                                     | `0` và `1`                              |
| Pick / Cửa chọn              | Tên dễ đọc của kết quả được chọn                                     | `alliance`, `over 2.5`                  |
| Odds                         | Hệ số trả thưởng cho một kết quả                                     | `2.20`                                  |
| Bộ odds                      | Hai odds theo thứ tự side 0, side 1                                  | `[1.80, 2.20]`                          |
| OddsLine / Dòng kèo          | Bộ odds của một tenant, kèm trạng thái, phase, thời gian và ID gốc   | Hàng SptPub trong bảng trên             |
| Room                         | Nơi giữ báo giá của các tenant cho cùng trận và market               | `room:cs2:alliance~sinners:game-winner` |
| Combo / Tổ hợp               | Chọn side 0 từ một tenant và side 1 từ tenant khác                   | `polymarket>0` kết hợp `sptpub>1`       |
| Leg / Chân                   | Một phía trong tổ hợp, có nguồn, cửa chọn và odds                    | Alliance thắng ở Polymarket, odds 2.10  |
| Margin                       | Lợi nhuận lý thuyết trên tổng vốn của tổ hợp, theo công thức backend | `0.02` là 2%                            |
| Signal / Kèo                 | Thông báo về cơ hội đạt điều kiện phát tín hiệu                      | Có `signalId`, hai chân và hạn hiệu lực |

### Về dữ liệu và vận hành

| Tên                       | Hiểu đơn giản                                                       | Vai trò                                                            |
| ------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Bản tin / Message         | Một lần task gửi dữ liệu về app                                     | Có thể chứa một giá, cả danh sách trận hoặc mốc kết thúc vòng quét |
| Payload                   | Phần dữ liệu nằm bên trong bản tin                                  | Nội dung parser cần đọc                                            |
| Publisher / Task          | Công việc chạy để lấy dữ liệu từ tenant                             | Lấy danh sách trận hoặc theo dõi giá                               |
| Kind                      | Loại công việc task thực hiện                                       | `polymarket.descriptor`, `polymarket.stream`                       |
| Descriptor                | Công việc lấy mô tả trận, market, token                             | Giúp app biết giá thuộc trận và đội nào                            |
| Stream / Feed             | Luồng giá cập nhật liên tục hoặc theo lần thăm dò                   | Cập nhật báo giá đang theo dõi                                     |
| Node                      | Máy chạy task từ xa                                                 | App gửi lệnh cho task thông qua node                               |
| Parser / Translator / ACL | Bộ phận đọc dữ liệu riêng của tenant và đổi sang dạng chung         | Dữ liệu hai nền tảng trở nên so sánh được                          |
| Lane / Làn                | Hàng xử lý cho một tenant và một phase                              | Ví dụ `sptpub:live`                                                |
| Evaluator                 | Bộ phận kiểm tra room và quyết định phát, làm mới hoặc hủy tín hiệu | Tìm cơ hội từ báo giá                                              |
| Consumer                  | Bot hoặc dịch vụ nhận tín hiệu từ app                               | Bot thông báo, dịch vụ giao dịch                                   |
| Delivery / ACK            | Một lần gửi thông báo / xác nhận đã nhận                            | Giúp theo dõi gửi lại và chống xử lý trùng                         |
| Incident / Sự cố          | Tình trạng vận hành được hệ thống theo dõi                          | Task chết, consumer mất kết nối                                    |
| Audit                     | Nhật ký thao tác API của người dùng                                 | Ai đã đổi cấu hình hoặc dừng task                                  |

**Bản tin, dòng kèo và tín hiệu là ba thứ khác nhau.** Một bản tin có thể không tạo dòng kèo nào, hoặc cập nhật nhiều dòng. Nhiều dòng kèo cũng chưa chắc tạo được tín hiệu.

## Dữ liệu đi qua những đâu

```text
Tenant -> Task -> Parser -> Lane -> Room -> Evaluator -> Consumer
```

1. **Tenant cung cấp dữ liệu.** SptPub và Polymarket có cấu trúc riêng.
2. **Task lấy dữ liệu rồi gửi bản tin.** Supervisor bổ sung thông tin task, thứ tự bản tin và thời điểm nhận.
3. **Parser đọc và chuẩn hóa.** Nó xác định môn, đội, market và odds. Kết quả có thể là `set`, `remove`, bỏ qua có chủ đích hoặc lỗi parse.
4. **Lane nhận cập nhật.** Các làn độc lập theo tenant và phase. Nếu đang bận mà có nhiều cập nhật cho cùng room và tenant, làn giữ bản mới nhất trong phần đang chờ. Số bản cũ được gộp nằm ở `coalesced`.
5. **Room được ghi báo giá.** `set` thêm hoặc thay báo giá hiện tại của tenant; `remove` gỡ báo giá của tenant khỏi room.
6. **Evaluator kiểm tra lại room.** Nó thử các tổ hợp hai chân, áp dụng ngưỡng lợi nhuận và chính sách tín hiệu. Một lượt quét định kỳ cũng đánh giá các room để làm mới tín hiệu đến hạn.
7. **Consumer nhận thông báo.** App gửi tín hiệu mới, tín hiệu làm mới hoặc thông báo hủy qua WebSocket. Consumer gửi ACK để xác nhận đã nhận.

Trang web dùng API và stream quản trị để quan sát các bước này. Bản tin trên stream quản trị dành cho web khác với bản tin giá từ task và bản tin tín hiệu gửi consumer.

## Room ghép dữ liệu như thế nào

### Một trận có thể có nhiều room

| Room                                          | Câu hỏi của market                 | Side 0 / Side 1                            |
| --------------------------------------------- | ---------------------------------- | ------------------------------------------ |
| `room:cs2:alliance~sinners:game-winner`       | Ai thắng trận?                     | Alliance thắng / Sinners thắng             |
| `room:cs2:alliance~sinners:map-1-winner`      | Ai thắng map 1?                    | Alliance thắng map 1 / Sinners thắng map 1 |
| `room:cs2:alliance~sinners:total-maps-2.5`    | Tổng map nhiều hơn hay ít hơn 2.5? | Over 2.5 / Under 2.5                       |
| `room:cs2:alliance~sinners:map-handicap-m1.5` | Ai thắng sau mức chấp map?         | Alliance -1.5 / Sinners +1.5               |

Tên hai đội được chuẩn hóa, áp dụng bí danh và sắp theo alphabet. Vì vậy hai tenant gửi đội theo thứ tự ngược nhau vẫn có thể vào cùng room; parser phải đảo odds và token tương ứng.

**Side 0 không phải lúc nào cũng là đội chủ nhà.** Với tổng map, side 0 là Over và side 1 là Under, không phụ thuộc tên đội. Với mức chấp, dấu của mức chấp được quy về đội đứng đầu trong khóa room.

### Room giữ báo giá hiện tại

Room có thể xuất hiện ngay khi mới có một tenant. Mỗi tenant có một dòng hiện tại trong room, không có một hàng mới cho mỗi bản tin. Phase là thuộc tính của dòng, không phải một phần của ID room.

Trong phiên bản này, ID room gồm môn, cặp đội và market; ID không chứa ngày hoặc giờ bắt đầu. Backend kiểm tra độ lệch giờ bắt đầu khi ghép hai báo giá và có tác vụ dọn các trận quá hạn.

### Đã ghép được chưa có nghĩa là có kèo

- **Matched:** room có ít nhất hai tenant. Hai dòng có thể đang tạm khóa hoặc lệch giờ.
- **Có tổ hợp hợp lệ:** hai dòng mở, khác tenant và giờ bắt đầu lệch trong giới hạn cho phép.
- **Đạt ngưỡng:** có tổ hợp đạt `minMargin`.
- **Có tín hiệu:** chính sách phát tín hiệu còn kiểm tra phase được bật và trạng thái tín hiệu trước đó.

Nếu tên đội khác nhau sau chuẩn hóa, hai nguồn có thể nằm ở hai room khác nhau. Trang [Ghép trượt](/ghep-truot) gợi ý cặp nghi ngờ; [Bí danh đội](/bi-danh) giúp khai báo tên chuẩn. Gợi ý không tự động hợp nhất room.

Khi bạn lưu bí danh, backend áp dụng ngay cho các dòng đang chạy và ghép lại room; không cần dừng publisher.
Nếu cả hai đội đều lệch tên, cần sửa cả hai. Xóa hoặc đổi bí danh cũng ghép lại theo bảng tên mới.
Giá vẫn giữ thời điểm nhận cũ, không biến thành báo giá mới chỉ vì đổi tên. Ghép được room rồi
vẫn phải qua các điều kiện phát kèo ở trên.

## Khi nào hệ thống phát kèo

Backend chọn side 0 từ tenant A và side 1 từ tenant B. A và B phải khác nhau; cả hai dòng phải `open`; giờ bắt đầu phải khớp trong `maxStartDriftMs`.

Trong ví dụ ban đầu, chọn Alliance ở Polymarket với `2.10`, Sinners ở SptPub với `2.20`:

```text
margin = 1 / (1 / oddsA + 1 / oddsB) - 1
       = 1 / (1 / 2.10 + 1 / 2.20) - 1
       ≈ 0.0744186 = 7.44%
```

Đây là công thức đang dùng trong code. Margin này chưa trừ phí, chưa kiểm tra khối lượng có thể khớp hoặc việc đặt lệnh thành công. Tín hiệu không phải xác nhận đã đặt cược.

### Chính sách tín hiệu

| Tình huống                                             | App làm gì?                                                |
| ------------------------------------------------------ | ---------------------------------------------------------- |
| Chưa có tín hiệu; margin đạt ngưỡng; phase được bật    | Phát mới: `issued`, tạo `signalId`                         |
| Margin tăng đủ `marginStep` so với lần phát mới gần nhất | Hủy tín hiệu cũ (`better_opportunity`), rồi phát mới |
| Margin giảm đủ `marginDropStep`, vẫn đạt ngưỡng | Hủy tín hiệu cũ (`margin_decreased`), rồi phát mới |
| Vẫn đạt ngưỡng và đã đến thời hạn làm mới              | `refreshed`, giữ `signalId`, cập nhật odds và hạn hiệu lực |
| Thay đổi chưa đủ bước, chưa đến hạn làm mới | Không gửi tín hiệu mới |
| Margin xuống dưới ngưỡng                               | Hủy: `below_threshold`                                     |
| Một chân tạm khóa hoặc bị gỡ                           | Hủy: `leg_suspended` hoặc lý do gỡ tương ứng               |
| Giờ bắt đầu lệch quá giới hạn                          | Hủy: `start_time_mismatch`                                 |
| Phase của tổ hợp bị tắt                                | Hủy: `phase_disabled`                                      |

Một tổ hợp có tối đa một tín hiệu hiệu lực trong trạng thái của evaluator. Một room có thể có nhiều tổ hợp và nhiều tín hiệu. Nếu bất kỳ chân nào live, phase của tổ hợp là live.
Mỗi lần phát mới đặt lại mốc margin cho cả hai chiều; refresh không đổi mốc. Một lần nhảy nhiều bước chỉ phát một tín hiệu mới tại margin hiện tại. Kênh đã nhận tín hiệu cũ nhận tin hủy; tín hiệu mới được gửi theo hạng khớp margin mới.

## Đọc các chỉ số trên web

### Nhận cuối và Đổi cuối

| Nhãn                           | Khi nào mốc này cập nhật?                                | Nó chứng minh điều gì?                                                    |
| ------------------------------ | -------------------------------------------------------- | ------------------------------------------------------------------------- |
| Nhận cuối / `lastReceivedAt`   | Ingest nhận bản tin thuộc kind có translator             | Dữ liệu đã đến bước ingest, kể cả bản tin sau đó bị bỏ qua hoặc parse lỗi |
| Đổi cuối / `lastChangeAt`      | Translator sinh ít nhất một cập nhật `set` hoặc `remove` | Bản tin đã tạo cập nhật báo giá; chưa chứng minh lane đã xử lý xong       |
| Xử lý cuối / `lastProcessedAt` | Lane kết thúc lượt xử lý                                 | Lane đã chạy lượt xử lý; lỗi riêng vẫn cần xem cùng các chỉ số khác       |

**Đổi cuối không chỉ đo lúc con số odds thay đổi.** `set` lại cùng odds, đổi trạng thái hoặc gỡ một dòng đều có thể cập nhật mốc này.

Ví dụ Nhận cuối là 2 giây trước, Đổi cuối là 5 phút trước: bản tin vẫn tới nhưng gần đây không tạo cập nhật báo giá. Có thể chỉ có bản tin bổ sung, dữ liệu không hỗ trợ, token chưa biết hoặc lỗi parse. Cần xem lý do, không thể chỉ từ hai mốc này kết luận API hỏng.

### Các bộ đếm không dùng cùng đơn vị

| Chỉ số              | Đếm cái gì?                                             |
| ------------------- | ------------------------------------------------------- |
| `received`          | Số bản tin ingest nhận                                  |
| `failed`            | Số lần translator ném ngoại lệ                          |
| `skipped`           | Số phần dữ liệu bị bỏ qua, theo từng lý do              |
| `set` / `remove`    | Số cập nhật báo giá translator sinh ra                  |
| `queued`            | Số cập nhật đang chờ trong lane                         |
| `processed`         | Số cập nhật lane đã chạy qua lượt xử lý                 |
| `coalesced`         | Số cập nhật cũ trong hàng chờ được gộp vì đã có bản mới |
| `activeSignals`     | Số tín hiệu đang hiệu lực ở thời điểm lấy dữ liệu       |
| `pendingDeliveries` | Số lần gửi consumer còn chờ ACK                         |

Một trang descriptor là **một bản tin** nhưng có thể chứa hàng trăm market. Vì vậy `set` hoặc `skipped` có thể lớn hơn `received`. Không nên xem mọi bộ đếm là các phần của cùng một tổng.

Các bộ đếm ingest và lane cộng dồn từ khi backend khởi động; `since` cho biết mốc bắt đầu. Tốc độ trên web được tính từ chênh lệch giữa các lần lấy mẫu. Số dòng hiện tại trong room và số tín hiệu hiện tại là trạng thái tại thời điểm xem, không phải số đã phát từ lúc khởi động.

**100% bên cạnh một lý do trong nhóm Lỗi nghĩa là lý do đó chiếm toàn bộ nhóm Lỗi**, không có nghĩa 100% bản tin nhận bị lỗi.

### Các lý do bỏ qua

| Mã                   | Hiểu đơn giản                                                                                 |
| -------------------- | --------------------------------------------------------------------------------------------- |
| `parse_failed`       | Dữ liệu không khớp schema parser đang đọc                                                     |
| `unsupported_event`  | Bản tin stream hợp lệ nhưng không dùng để cập nhật odds: giao dịch cuối, bước giá, market mới |
| `unsupported_sport`  | Môn chưa hỗ trợ                                                                               |
| `unsupported_market` | Loại cược chưa hỗ trợ                                                                         |
| `unsupported_line`   | Mức chấp, mốc tổng hoặc số map ngoài danh sách hỗ trợ                                         |
| `missing_fields`     | Thiếu ID, giờ bắt đầu, token hoặc dữ liệu cần thiết                                           |
| `same_team_names`    | Hai đội trở thành cùng một tên sau chuẩn hóa                                                  |
| `no_moneyline_teams` | Không xác định được cặp đội từ market thắng trận để gắn market tổng                           |
| `invalid_event`      | Sự kiện không phải trận hợp lệ theo quy tắc translator                                        |
| `unknown_asset`      | Stream gửi token chưa có trong bảng định tuyến của descriptor                                 |

Bỏ qua có chủ đích không phải ngoại lệ xử lý. Với Polymarket, cần descriptor nhận diện market và token trước khi stream có thể cập nhật đúng room.

## ID nào của tenant, ID nào của app

**`tAlliance` trong các ví dụ trò chuyện trước là tên mình tự đặt.** Chữ `t` chỉ gợi nhớ token, không phải tiền tố Polymarket gửi và cũng không phải quy tắc domain của app. Trong tài liệu này, ID token dạng số ngắn chỉ là minh họa; ID thực thường là chuỗi số dài.

| Trường hoặc ID                          | Ai đặt?              | App làm gì với nó?                                                        |
| --------------------------------------- | -------------------- | ------------------------------------------------------------------------- |
| Token ID / Asset ID của Polymarket      | Tenant               | Giữ nguyên giá trị để subscribe stream và xác định outcome                |
| Condition ID của Polymarket             | Tenant               | Nhận diện market gốc                                                      |
| `asset_id` thành `assetId`              | SDK Polymarket       | Chuẩn hóa tên trường; không thêm chữ `t` vào ID                           |
| `ref.t0`, `ref.t1`                      | App đặt tên trường   | Lưu nguyên token ID theo side 0 và side 1 của room                        |
| `ref.c`, `ref.slug`                     | App đặt tên trường   | Lưu condition ID và slug lấy từ tenant                                    |
| `room:cs2:alliance~sinners:game-winner` | App                  | Gom báo giá theo môn, đội chuẩn hóa và market chuẩn                       |
| `comboId`                               | App                  | Ghi tenant nào cung cấp side nào; ví dụ `polymarket>0` kết hợp `sptpub>1` |
| `signalId`                              | App                  | Định danh tín hiệu; evaluator tạo UUID khi phát mới                       |
| `deliveryId`                            | Consumer hub của app | Định danh một lần giao thông báo để nhận ACK                              |

Khóa `t0` nghĩa là **trường chứa token của phía 0**. Nó không có nghĩa giá trị token ID phải bắt đầu bằng `t0`.

## Payload minh họa

Các JSON dưới đây là ví dụ rút gọn để đọc cấu trúc, không phải dữ liệu live hoặc ID để sử dụng đặt lệnh. Timestamp dùng đơn vị mili giây.

### Bản tin nhận vào

Supervisor chuyển cho ingest một `TaskDataMessage`. `payload` bên ngoài là dữ liệu task gửi; `payload` bên trong là nội dung event mà SDK Polymarket chuẩn hóa.

```json
{
  "taskId": "poly-stream",
  "tenant": "polymarket",
  "kind": "polymarket.stream",
  "seq": 42,
  "sentAt": 1790318269481,
  "receivedAt": 1790318269500,
  "channel": "market",
  "payload": {
    "topic": "market",
    "type": "best_bid_ask",
    "payload": {
      "assetId": "123456789",
      "bestBid": "0.24",
      "bestAsk": "0.25"
    }
  }
}
```

Nhận cuối cập nhật. Nếu descriptor đã biết token `123456789` thuộc Alliance, parser lấy ask `0.25` và đổi thành decimal odds `1 / 0.25 = 4`.

### Cập nhật báo giá sinh ra

Giả sử token phía còn lại là `987654321`, có ask `0.50`. Kết quả `set` tương đương biểu diễn rút gọn sau:

```json
{
  "type": "set",
  "key": "room:cs2:alliance~sinners:game-winner",
  "line": {
    "tenant": "polymarket",
    "odds": [4, 2],
    "status": "open",
    "phase": "live",
    "updatedAt": 1790318269481,
    "startsAt": 1790310000000,
    "ref": {
      "c": "CONDITION_ID_MINH_HOA",
      "slug": "cs2-alliance-sinners",
      "t0": "123456789",
      "t1": "987654321"
    }
  }
}
```

Trong code, `key` là đối tượng `MatchKey`, `line` là `OddsLine`; JSON trên trình bày `key.toString()` và `line.props`. Đây không phải một response REST nguyên bản. Đổi cuối cập nhật ngay khi parser sinh kết quả này, trước khi lane ghi nó vào room.

### Bản tin hợp lệ nhưng không đổi báo giá

```json
{
  "topic": "market",
  "type": "last_trade_price",
  "payload": {
    "assetId": "123456789",
    "price": "0.23",
    "side": "BUY",
    "size": "100"
  }
}
```

Đây là phần `TaskDataMessage.payload`. `price` là giá của giao dịch đã khớp, không phải ask hiện tại. Nhận cuối cập nhật, `unsupported_event` tăng, Đổi cuối giữ nguyên. `tick_size_change` và `new_market` hợp lệ cũng được bỏ qua theo cách này.

### Market đã kết thúc

```json
{
  "topic": "market",
  "type": "market_resolved",
  "payload": { "assetIds": ["123456789", "987654321"] }
}
```

Nếu market đang được theo dõi, parser sinh `remove` cho báo giá Polymarket. Cả Nhận cuối và Đổi cuối đều cập nhật; evaluator kiểm tra để hủy những tín hiệu dựa vào chân đã mất. Nếu token chưa biết, không có báo giá tương ứng để gỡ.

### Descriptor và vòng quét

`polymarket.descriptor` gửi `cycle-start`, sau đó từng trang event qua channel `events`, cuối cùng `cycle-complete` nếu đã quét hết mà không lỗi. Trang `events` chứa một mảng event; mỗi event có schedule, sport và danh sách market.

```json
{
  "channel": "cycle-complete",
  "payload": { "cycle": 3, "pages": 2 }
}
```

Đây là mảnh rút gọn của bản tin task. Mốc hoàn tất không phải lỗi parse. Nó cho phép parser đối chiếu market nào biến mất khỏi danh sách. Polymarket mặc định chờ vắng hai vòng liên tiếp mới gỡ; khi tỷ lệ gỡ bất thường, cơ chế đối chiếu có thể giữ lại thêm một số vòng và báo sự cố.

## Consumer nhận tín hiệu thế nào

Consumer là đầu ra của hệ thống. Một frame tín hiệu gồm `deliveryId`, `kind` và `signal`. Trong `signal` có `signalId`, room, tổ hợp, margin, hai chân, `issuedAt` và `expiresAt`.

```json
{
  "type": "signal",
  "deliveryId": "DELIVERY_ID_MINH_HOA",
  "kind": "issued",
  "signal": {
    "signalId": "SIGNAL_ID_MINH_HOA",
    "room": "room:cs2:alliance~sinners:game-winner",
    "sport": "cs2",
    "market": "game-winner",
    "teams": ["alliance", "sinners"],
    "comboId": "polymarket>0|sptpub>1",
    "phase": "live",
    "margin": 0.0744186,
    "legs": [
      {
        "tenant": "polymarket",
        "side": 0,
        "pick": "alliance",
        "odds": 2.1,
        "ref": {}
      },
      {
        "tenant": "sptpub",
        "side": 1,
        "pick": "sinners",
        "odds": 2.2,
        "ref": {}
      }
    ],
    "issuedAt": 1790318269500,
    "expiresAt": 1790318299500
  }
}
```

`ref` được để trống cho gọn ví dụ; dữ liệu thực chứa các ID gốc để consumer xác định đúng market và outcome. Consumer xác nhận lần giao bằng:

```json
{ "type": "ack", "deliveryId": "DELIVERY_ID_MINH_HOA" }
```

Hub gửi lại những thông báo còn chờ ACK trong cửa sổ hiệu lực. Vì vậy consumer có thể nhận lại cùng thông báo và cần xử lý trùng. ACK xác nhận đã nhận thông báo, không chứng minh đặt lệnh thành công.

### Pause, resume và mất kết nối

- **Pause:** ngừng giao tín hiệu mới hoặc làm mới cho consumer đó. Thông báo hủy và thông báo đã chờ ACK vẫn có thể tiếp tục được gửi.
- **Resume:** bỏ trạng thái pause để nhận các lần phát tiếp theo. Lệnh resume hiện không tự phát lại ngay toàn bộ tín hiệu active.
- **Kết nối lại:** hub có cơ chế phát lại tín hiệu còn hiệu lực khi consumer kết nối và không bị pause.
- **Consumer offline:** có thể đổi pause/resume của session đã biết; trạng thái được hub giữ trong RAM. Mất kết nối và pause là hai trạng thái khác nhau.

Backend phát hiện và giao tín hiệu. Việc thông báo ra ngoài hoặc đặt lệnh thuộc phần triển khai của consumer; chỉ nhìn thấy kèo trên web chưa có nghĩa consumer đã hành động.

## Cài đặt và các màn hình

### Cài đặt arbitrage

Đây là giá trị mặc định trong code; giá trị đang chạy cần xem ở [Cài đặt arbitrage](/cai-dat).

| Trường            | Ý nghĩa                                                          | Mặc định                  |
| ----------------- | ---------------------------------------------------------------- | ------------------------- |
| `minMargin`       | Lợi nhuận tối thiểu để phát tín hiệu                             | `0.02` = 2%               |
| `marginStep`      | Bước tăng so với margin lần phát mới gần nhất để hủy cũ và phát mới | `0.01` = 1 điểm phần trăm |
| `marginDropStep`  | Bước giảm riêng để hủy cũ và phát mới nếu còn đạt ngưỡng | `0.01` = 1 điểm phần trăm |
| `signalTtlMs`     | Khoảng hiệu lực của tín hiệu và mốc làm mới khi còn đủ điều kiện | `300000` = 5 phút         |
| `maxStartDriftMs` | Độ lệch giờ bắt đầu tối đa giữa hai nguồn                        | `1200000` = 20 phút       |
| `enabledPhases`   | Phase được phép phát tín hiệu                                    | `live`, `prematch`        |

`prematch` nghĩa là trước trận; `live` nghĩa là đang diễn ra. Dòng `suspended` vẫn có thể nằm trong room nhưng không được ghép để tạo cơ hội. Với Polymarket, thiếu ask dùng được ở một phía sẽ tạo dòng suspended; giá 0 hoặc 1 không được dùng để tính odds mở.

Cài đặt arbitrage, hạng kèo, kênh thông báo và task có bật **Lưu bền** được ghi vào Postgres và tự nạp lại khi backend khởi động. Task lưu bền đã bị dừng vẫn giữ trạng thái dừng sau restart. Trạng thái tín hiệu active và các session consumer WebSocket vẫn chỉ nằm trong RAM; không nên nhầm chúng với lịch sử đã lưu.

### Mở màn hình nào để xem việc gì?

| Màn hình                       | Xem hoặc thao tác                                                            |
| ------------------------------ | ---------------------------------------------------------------------------- |
| [Tổng quan](/)                 | Tình trạng chung của hệ thống                                                |
| [Luồng dữ liệu](/ingest)       | Nhận, bỏ qua, lỗi, cập nhật báo giá và các làn xử lý                         |
| [Trận đấu](/tran-dau)          | Các market của một trận và báo giá từng tenant                               |
| [Ghép trượt](/ghep-truot)      | Cặp trận có thể bị tách do tên đội lệch; ẩn cặp là lựa chọn trên trình duyệt |
| [Kèo](/keo)                    | Tín hiệu active và lịch sử tín hiệu; xóa lịch sử theo trạng thái/thời gian hoặc từng kèo |
| [Publisher & Node](/publisher) | Task, node, bắt đầu, dừng, xóa task đã dừng hoặc lỗi; lệnh tùy kind          |
| [Consumer](/consumer)          | Kết nối, pause/resume và số thông báo chờ ACK                                |
| [On click](/on-click)          | Kèo giá bán Polymarket cao chờ người bấm vào lệnh (giấy) theo profile         |
| [Sự cố](/su-co)                | Sự cố đang mở và xác nhận đã xem                                             |
| [Audit](/audit)                | Nhật ký thao tác API                                                         |
| [Lịch sử odds](/lich-su-odds)  | Chuyển trạng thái báo giá như open, suspended hoặc removed                   |
| [Bí danh đội](/bi-danh)        | Thêm hoặc xóa cách quy tên khác nhau về tên chuẩn                            |

API chưa có lệnh restart task riêng. Thao tác Tạo lại trên web là xóa hồ sơ task đã dừng/lỗi rồi tạo mới với spec cũ. ACK sự cố chỉ đánh dấu đã xem, không sửa nguyên nhân gây sự cố.

Web yêu cầu đăng nhập và chuyển tiếp các thao tác backend qua BFF bằng token cấu hình phía server. Quyền API quyết định thao tác nào được phép. Khi dùng `ARB_MOCK=true`, dữ liệu và kết quả thao tác là dữ liệu mẫu, không chứng minh pipeline thật đang chạy.

## Auto trade: bảng tiền theo hạng và cách vào lệnh

Mỗi profile trader có một **bảng tiền theo hạng**: kèo thuộc hạng nào thì vào bao nhiêu tiền. Hạng (tên, khoảng margin) dùng chung với hạng kèo của kênh thông báo; profile chỉ quyết định tiền.

### Mọi số tiền là USD cược bên csgoempire

Cột **Tiền mục tiêu**, **Tiền mục tiêu tối thiểu**, **Tiền mục tiêu tối đa** đều là **USD cược ở chân csgoempire** cho một kèo, không phải số share Polymarket. Số share do worker tự tính:

- Cược `S` USD ở odds `O` bên csgoempire → thắng nhận `S × O`.
- Mua `N` share cửa ngược lại bên Polymarket → thắng nhận `N` USD (mỗi share 1$).
- Cân hai chân: `N = S × O`, nên cửa nào thắng cũng nhận về như nhau.

### Chọn hạng profile sẽ vào

Ô tick đầu mỗi dòng của bảng chọn hạng profile được vào; lựa chọn lưu trong profile nên task trader khởi động lại vẫn chạy đúng như vậy. Profile mới chưa chọn hạng nào và đứng yên (`NO_TIER_SELECTED`) cho tới khi chọn. Kèo không khớp hạng được chọn nào bị bỏ qua với lý do `TIER_NOT_SELECTED` (kèm tên hạng không tick mà kèo khớp). Hạng mới admin thêm sau không tự được chọn. Profile tạo trước khi có tính năng này vẫn vào mọi hạng cho tới khi sửa lựa chọn.

### Chọn market profile sẽ vào

Ô **Market sẽ vào** trong profile: **Mọi market** (mặc định, kể cả market thêm sau) hoặc **Chỉ market đã chọn**, ví dụ chỉ `game-winner` (Thắng trận) hoặc chỉ `map-handicap-p1.5` (Chấp +1.5, mức chấp tính cho đội đứng trước). Kèo ở market không chọn bị bỏ qua với lý do `MARKET_NOT_SELECTED`, trước cả khi đọc sổ lệnh. Chọn "Chỉ market đã chọn" mà không chọn market nào → profile đứng yên (`NO_MARKET_SELECTED`). Lựa chọn lưu trong profile, kết hợp với lựa chọn hạng: kèo phải thuộc cả market lẫn hạng được chọn.

### Bảng được tính từ đâu

| Trường | Ý nghĩa |
|---|---|
| Tiền hạng thấp nhất | Tiền của hạng có margin thấp nhất; các hạng khác tính từ số này theo xu hướng |
| Xu hướng + Bước mỗi hạng | Ngang: mọi hạng bằng nhau. Tăng dần: mỗi hạng × (1 + bước). Giảm dần: ÷ (1 + bước). Tùy chỉnh: tự nhập từng hạng |
| Tối thiểu (% tiền hạng) | Mức tối thiểu của mọi hạng = tiền hạng × %. Vào được ít hơn → bỏ qua. 0% = vào được bao nhiêu cũng vào |
| Tối đa (× tiền hạng) | Chỉ dùng khi bật **Tăng dần trong hạng**. ×1 = không tăng |
| Ô trong bảng | Ghi đè cho riêng hạng đó (để trống = tự tính theo các trường trên) |
| Số lệnh mỗi cửa | Số lệnh tối đa cho một cửa ở hạng đó; ô trống = theo "Số lệnh mỗi cửa mỗi hạng (mặc định)" của profile; **0 = không giới hạn** (chỉ còn hạn mức tiền theo trận chặn). Tính cả việc vào lặp lại cùng một kèo mỗi lần kèo được làm mới. Đủ số thì bỏ qua **im lặng** (không ghi dòng). Tăng số này thì kèo còn sống của cửa đó được xét lại ngay |
| Lãi tối thiểu / ngày (cột cuối) | Ghi đè "Lãi tối thiểu mỗi ngày" của profile cho riêng hạng đó; ô trống = theo profile; 0 = tắt cho hạng này. Xem mục **Ưu tiên kèo theo lãi mỗi ngày** |

**Tiền mục tiêu và Tối thiểu cùng đơn vị** (USD cược csgoempire), chỉ khác vai trò: mục tiêu là mức muốn vào (và không vượt), tối thiểu là mức thấp nhất còn chấp nhận. Ví dụ mục tiêu 50$, tối thiểu 35$, odds 2.0 → cần 100 share Polymarket:

| Share còn lãi trên sổ (cộng mọi người bán) | Chân csgoempire | Kết quả |
|---|---|---|
| ≥ 100 | 50$ | vào đủ mục tiêu |
| 80 | 80 ÷ 2.0 = 40$ | 40$ ≥ 35$ → vào 40$ |
| 60 | 30$ | 30$ < 35$ → bỏ qua cả hai chân |

Tiền chi bên Polymarket là số share × giá (cộng phí), một con số khác với tiền csgoempire.

**Tăng dần trong hạng**: chỉ thay đổi tiền mục tiêu, bên trong CÙNG một hạng. Tăng đều (tuyến tính, không theo bậc) từ cột Tiền mục tiêu ở cận dưới lên cột Tối đa ở cận trên:

`mục tiêu = Tiền mục tiêu + (Tối đa − Tiền mục tiêu) × (margin − cận dưới) ÷ (cận trên − cận dưới)`

Mỗi 0,1% margin tăng thêm `(Tối đa − Tiền mục tiêu) ÷ (độ rộng hạng tính bằng %) × 0,1`. Ví dụ hạng 1,5–3% (rộng 1,5%), mục tiêu 50$, tối đa 100$ → +3,33$ mỗi 0,1%:

| Margin | 1,5% | 2% | 2,5% | 2,9% |
|---|---|---|---|---|
| Tiền mục tiêu | 50$ | 66,67$ | 83,33$ | 96,67$ |
| Tối thiểu | không đổi | không đổi | không đổi | không đổi |

Bảng xem trước ghi sẵn mức tăng này dưới tên mỗi hạng. Hạng không có cận trên luôn dùng Tiền mục tiêu. Đừng nhầm với **Bước mỗi hạng**: bước là chênh lệch tiền GIỮA các hạng, tăng dần trong hạng là chênh lệch BÊN TRONG một hạng.

Hạng không được tick trong profile bị **loại trước**; trong các hạng được tick, nhiều hạng cùng khớp một margin (khoảng chồng nhau) → dùng hạng có **cận dưới cao nhất**. Ví dụ VIP 3–6% (không tick) và VIP cho giao dịch tự động 2–8% (tick): kèo 4,9% vào theo VIP cho giao dịch tự động.

### Ưu tiên kèo theo lãi mỗi ngày

Tiền vào lệnh bị **khóa** tới khi trận có kết quả. Kèo lãi 3% mà trận còn 5 ngày nữa mới đá giữ tiền 5 ngày, trong khi kèo 15–20% của trận sắp đá trả tiền về ngay. Ô **Lãi tối thiểu mỗi ngày (%/ngày)** của profile (và cột **Lãi tối thiểu / ngày** của từng hạng) bỏ qua kèo không đáng giữ tiền lâu:

`lãi/ngày = margin kèo ÷ số ngày`, với `số ngày = (giờ bắt đầu + 3 giờ − bây giờ) ÷ 24 giờ`, **tối thiểu 1 ngày** (trận trong ngày hoặc đang đá đều tính 1 ngày). Giờ bắt đầu lấy chân có giờ **muộn nhất**; kèo không có giờ bắt đầu thì không kiểm tra.

| Ngưỡng 1%/ngày | Margin | Cách giờ đá | Lãi/ngày | Kết quả |
|---|---|---|---|---|
| Trận xa, lãi mỏng | 3% | 5 ngày | 0,6%/ngày | bỏ qua (`LOW_DAILY_RETURN`) |
| Trận gần, lãi cao | 15% | 2 ngày | 7,5%/ngày | vào |
| Trận hôm nay | 0,8% | 4 giờ | 0,8%/ngày (tính 1 ngày) | bỏ qua |

- Thứ tự áp: hạng → **lãi/ngày** → số lệnh mỗi cửa → sổ lệnh. Hạng có ô riêng thì dùng ô của hạng, không thì dùng của profile. `0` = tắt (mặc định).
- Kèo bị bỏ vì lãi/ngày vẫn được **xét lại mỗi lần publisher làm mới kèo**: trận càng gần thì lãi/ngày càng cao nên tới lúc đạt ngưỡng sẽ tự vào. Lệnh giấy chỉ ghi **một** dòng *Lãi theo ngày thấp* cho mỗi kèo (các lần làm mới vẫn dưới ngưỡng không ghi thêm). Hạ ngưỡng thì kèo đang bị chặn được xét lại ngay.
- Người bấm **Vào lệnh** ở On click không bị chặn bởi ngưỡng này.
- Chi tiết lệnh ghi `detail.daily = { days, perDay }` để xem kèo đó được tính bao nhiêu ngày.

### Worker quyết định một lệnh như thế nào (chiến lược taker)

1. **Chọn hạng** theo margin kèo → tiền mục tiêu `S`. Không khớp hạng nào → bỏ qua (`NO_TIER`).
2. **Kiểm tra giới hạn**: lãi tối thiểu mỗi ngày (`LOW_DAILY_RETURN`), số lệnh tối đa mỗi cửa ở hạng này (0 = không giới hạn), hạn mức tổng theo trận (chung và của profile).
3. **Đọc sổ lệnh** Polymarket thật của cửa cần mua, cần `S × O` share.
4. **Ăn lệnh bán từ giá rẻ nhất lên**: mua hết mức giá rẻ nhất, chưa đủ thì sang mức rẻ thứ hai… Dừng khi:
   - đủ số share cần;
   - tới mức giá mà lãi ròng của cặp lệnh (đã trừ phí taker) **dưới ngưỡng lãi tối thiểu** của profile, các mức sau chỉ đắt hơn nên không ăn tiếp;
   - hết hạn mức theo trận.
5. **Cân lại chân csgoempire** theo số share mua được: `tiền csgoempire = share ÷ O`. Sổ mỏng thì cả hai chân cùng nhỏ lại, không bao giờ cược csgoempire nhiều hơn phần Polymarket cân được.
6. **Đối chiếu mức tối thiểu** (tính trên tiền csgoempire sau khi cân):
   - Tối thiểu so với **tổng** đã mua ở mọi mức giá cộng lại, không phải với từng người bán. Tối thiểu 40$: mức rẻ nhất cân được 20$, mức thứ hai 10$, mức thứ ba 15$ → tổng 45$ ≥ 40$ nên vào; nếu chỉ có hai mức đầu (30$) thì bỏ qua;
   - nhỏ hơn Tối thiểu của hạng → bỏ qua (`INSUFFICIENT_DEPTH`, hoặc `BUDGET_EXHAUSTED` nếu do hạn mức);
   - ít hơn số share tối thiểu một lệnh của market → bỏ qua (`BELOW_MIN_ORDER`);
   - ngay mức giá rẻ nhất đã không đủ lãi → bỏ qua (`NO_EDGE`).
7. Đạt hết → ghi lệnh **Vào (giấy)** với giá trung bình, phí, tổng tiền và lãi giả định.

Bỏ qua là bỏ cả hai chân: không có trường hợp vào csgoempire mà thiếu chân Polymarket.

### Ví dụ

Kèo margin 3%, hạng Thường: tiền 50$, tối thiểu 50% = 25$. Odds csgoempire 2.0 → cần 100 share. Ngưỡng lãi tối thiểu 1%, market không thu phí. Sổ lệnh bán:

| Giá | Share | Lãi ròng nếu ăn ở giá này | Ăn? |
|---|---|---|---|
| 0.45 | 60 | 5,26% | 60 |
| 0.47 | 30 | 3,09% | 30 |
| 0.52 | 100 | −1,96% | không (dưới 1%) |

Mua được 90 share (27$ + 14,1$ = 41,1$) → chân csgoempire = 90 ÷ 2.0 = **45$**. 45$ ≥ 25$ nên vào: tổng chi 86,1$, nhận về 90$, lãi 3,9$ (4,53%). Nếu Tối thiểu là 100% (50$) thì lệnh này bị bỏ qua vì chỉ vào được 45$.

Mở chi tiết một lệnh ở trang Auto trade → Lệnh giấy để xem từng mức giá đã ăn, độ sâu sổ lệnh và lý do bỏ qua.

### Mỗi lần phát kèo là một lệnh, khi nào được xét lại

**Mỗi lần publisher phát kèo là một lệnh**, kể cả phát mới lẫn làm mới khi hết thời hạn kèo (mặc định 5 phút). Lần làm mới được xét như một lệnh mới, dù lần trước vào được hay bị bỏ (hết lãi, sổ lệnh mỏng, hết hạn mức…). Chỉ những thứ sau mới chặn:

- **Bộ lọc của profile**: market, hạng kèo, profile đứng yên. Kèo bị lọc thì các lần làm mới không ghi thêm dòng.
- **Lý do hủy kèo**: kèo bị hủy khi đang tính thì dừng, trừ lý do được chọn "vẫn vào lệnh".
- **Giới hạn**: số lệnh mỗi cửa mỗi hạng, hạn mức tiền theo trận, lãi tối thiểu sau phí, lệnh tối thiểu.
- **Giá bán thấp nhất ≥ ngưỡng On click** thì không tự vào mà chuyển sang On click.

Lợi nhuận **tăng** đủ 1% thì publisher phát kèo mới, là một lệnh nữa; lệnh đã vào của kèo cũ vẫn giữ. Lợi nhuận **giảm** chỉ thành kèo mới khi giảm đủ "Bước giảm lợi nhuận"; giảm chưa đủ bước thì không có gì mới và lệnh cũ vẫn giữ. Hub giao lại **đúng bản tin đã xử lý** (cùng mốc phát, vd sau khi trader nối lại) thì không tính là lệnh mới.

Dấu "đã xử lý" theo mã kèo lưu ở Redis, còn tới khi kèo hết hạn + 1 giờ. Ngoài lần làm mới, kèo còn sống được **xét lại ngay** khi:

- **Sổ lệnh đổi** (Hết lãi sau phí, Sổ lệnh mỏng, Dưới lệnh tối thiểu): trader tự đọc lại sổ lệnh **mỗi 10 giây** cho các kèo này. Vẫn bỏ cùng lý do thì không ghi thêm dòng; sổ có lãi trở lại thì vào lệnh ngay.
- **Đổi cấu hình** (profile hoặc Giới hạn chung): kèo từng bị bỏ vì đúng phần cấu hình vừa đổi được xét lại ngay. Đổi phần khác hoặc lưu lại y hệt thì không.

  | Bị bỏ vì | Xét lại khi đổi |
  | --- | --- |
  | Market / Hạng không được chọn, Không thuộc hạng nào, Profile đứng yên, Chiến lược không có | đúng phần đó |
  | Hết hạn mức trận | hạn mức chung hoặc hạn mức trận của profile |
  | Hết lãi sau phí | lãi ròng tối thiểu |
  | Lãi theo ngày thấp | lãi tối thiểu mỗi ngày (profile hoặc hạng) |
  | Sổ lệnh mỏng, Dưới lệnh tối thiểu | lãi ròng tối thiểu, bảng tiền |
  | Kèo quá cũ | "Bỏ kèo cũ hơn" |
  | Đủ số lệnh của cửa (im lặng) | số lệnh mỗi cửa mỗi hạng |
  | Chuyển On click | ngưỡng On click |

- **Trả lại / Đặt lại ở Sổ phơi nhiễm**: kèo đang bị chặn vì hạn mức trận hoặc đủ số lệnh được xét lại ngay.
- **Xóa toàn bộ lệnh giấy** (Xóa lệnh… → Toàn bộ, không giới hạn thời điểm) của một profile hoặc mọi profile → trader quên dấu "đã xử lý" và xét lại mọi kèo còn sống.

- **Bấm "Xét lại kèo đang sống"** (menu ⋯ của profile): xét lại mọi kèo còn sống, không xóa lệnh.
- **Lần trước bị bỏ qua tạm thời** (Kèo hết hạn, Consumer bị tạm dừng): lần hub giao lại kèo kế tiếp được xét lại.

Dấu "đã xử lý" trong Redis chỉ ghi giá trị `1` (không kèm kết quả). Kết quả từng lần xử lý chỉ nhớ trong phiên task, nên khi **trader khởi động lại** (restart task hoặc app) mọi kèo còn sống mà hub gửi lại đều được **xét lại một lần**, kể cả kèo đã có dấu. Số lệnh mỗi cửa mỗi hạng và hạn mức trận nằm trong Redis nên không bị vượt; id lệnh xét lại kèm mã phiên (`profile:signal:<phiên>.2`) để không trùng dòng đã ghi. **Nối lại hub** khi trader không khởi động lại (app restart, rớt mạng) thì kèo chưa vào được lệnh được xét lại một lần; kèo đã vào thì chờ lần làm mới.

**Tóm tắt điều kiện xét lại kèo đang sống:**

| Khi | Xét lại kèo nào |
| --- | --- |
| Publisher phát lại (hết thời hạn kèo) | mọi kèo, trừ bị bộ lọc profile loại |
| Mỗi 10 giây | bỏ vì sổ lệnh (hết lãi, sổ mỏng, dưới lệnh tối thiểu, market đóng) hoặc lỗi |
| Đổi cấu hình profile / Giới hạn chung | bỏ vì đúng phần cấu hình vừa đổi |
| Trả lại / Đặt lại ở Sổ phơi nhiễm | bỏ vì hạn mức trận, đủ số lệnh |
| Trader khởi động lại | mọi kèo hub gửi lại |
| Nối lại hub (app restart, rớt mạng) | kèo chưa vào được lệnh |
| Consumer resume | bỏ vì Consumer bị tạm dừng |
| Xóa toàn bộ lệnh / bấm "Xét lại kèo đang sống" | mọi kèo |

Các lần xét lại (không phải bản tin publisher vừa phát) không kiểm tra "Kèo quá cũ". Xét lại theo nhịp mà vẫn cùng kết quả thì không ghi thêm dòng.

Lần xét lại ghi lệnh mới với id có hậu tố (`profile:signal:2`). Số lệnh mỗi cửa mỗi hạng và hạn mức theo trận vẫn giữ: cửa đã đủ số lệnh thì bỏ qua im lặng, không vượt số lệnh.

**Vào lặp lại cùng kèo:** mỗi lần làm mới (cùng mã kèo, mốc phát mới) lại được xét vào tiếp, cho tới khi cửa đủ số lệnh của hạng. Chế độ giấy không trừ thanh khoản đã "mua", nên mỗi lần đều tính trên cùng sổ lệnh hiện có.

Nhiều dòng giống hệt nhau trong cùng một phút thường là **nhiều kèo khác mã** của cùng một cửa: odds bị khóa ↔ mở lại liên tục làm kèo bị hủy rồi phát lại với mã mới; mỗi mã được xử lý một lần.

### On click: kèo để người vào lệnh

Mỗi profile có ngưỡng **Chuyển On click khi giá bán thấp nhất ≥** (mặc định `0.50`, `0` = tắt). Khi kèo có lãi và giá ask **thấp nhất** trên sổ lệnh Polymarket từ ngưỡng đó trở lên, bot **không tự vào**: trader vẫn đọc sổ lệnh và tính đủ như khi vào (bảng tiền, các mức giá, phí, lãi), rồi gửi bản phân tích "nếu vào bây giờ" sang trang **On click** (mục Vận hành). Kèo dưới ngưỡng (vd 0.49 trở xuống) bot vẫn vào như cũ.

- Lệnh giấy ghi **một** dòng *Bỏ qua · Chuyển On click* khi kèo vừa chuyển sang; các lần làm mới sau chỉ cập nhật bảng On click.
- Trang On click chọn profile ở đầu trang; danh sách tự làm mới, kèo bị hủy, hết hạn hoặc đã vào thì biến mất. Bấm một dòng để xem đủ phân tích như lệnh bot.
- Bấm **Vào lệnh (giấy)**: trader của profile đọc lại sổ lệnh ngay lúc đó và vào như bot (lãi tối thiểu, số lệnh mỗi cửa mỗi hạng, hạn mức trận vẫn áp; bỏ qua kiểm tra "kèo quá cũ"). Kết quả hiện ở Lệnh giấy với nhãn *vào tay bởi …*. Nếu lúc bấm sổ lệnh đã hết lãi hoặc đủ số lệnh, dòng ghi lý do bỏ qua như bot.
- **Tiền mục tiêu nhập tay:** mỗi kèo có ô tiền mục tiêu (mặc định tiền của hạng trong profile). Nhập xong trang tính lại ngay tiền hai chân, số share, giá trung bình và lãi theo **cơ chế taker như bot**: mua từ mức giá rẻ nhất, mức nào lãi ròng sau phí dưới ngưỡng thì dừng, nên có thể vào **ít hơn** số đã nhập (trang báo rõ). Đây là ước tính trên sổ lệnh lúc trader cập nhật kèo; bấm vào lệnh thì trader đọc lại sổ thật và tính lại với đúng số tiền đó. Tiền tối thiểu là mức nhỏ hơn giữa tiền tối thiểu của hạng và tiền đã nhập.
- **Báo về điện thoại:** mỗi kèo **mới** lên bảng On click (lần đầu, hoặc quay lại sau khi đã rời bảng) gửi một thông báo đẩy qua OneSignal: trận, margin + hạng, giá bán thấp nhất, lãi dự kiến, thứ tự trong giải, profile; bấm vào mở trang On click. Làm mới kèo không báo lại; app khởi động lại không báo lại kèo đang chờ. Cần đặt `ONESIGNAL_APP_ID`, `ONESIGNAL_REST_API_KEY` (và `WEB_APP_URL` để có link) ở env của backend. Thiết bị nhận: đã bật thông báo trong web và để mục **Kèo vượt ngưỡng · kèo On click** bật ở trang Thông báo. Thông báo gắn với **từng thiết bị**, không với tài khoản: nhiều người / nhiều điện thoại dùng chung một tài khoản admin đều nhận được, miễn là mỗi máy bật một lần. Bảng **Cài đặt thông báo trên thiết bị này** (nút ở trang On click, trang Thông báo, chuông thông báo) đi từng bước có trạng thái thật: thêm vào Màn hình chính (iPhone) → cho phép thông báo → đăng ký OneSignal (hiện mã thiết bị để đối chiếu ở OneSignal → Audience → Subscriptions) → bật mục Kèo → gửi thử. Mục **Thêm điện thoại khác** chia sẻ / chép link: mở trên máy kia, đăng nhập xong bảng tự hiện. Kiểm tra bằng nút **Gửi thử tới thiết bị này** (hoặc tới mọi thiết bị) ở trang Thông báo → mục Gửi thử từ backend: thông báo đi đúng đường gửi kèo On click.
- **Lãi tách theo nguồn:** Auto trade → Lệnh giấy có ba ô *Auto trade (bot tự vào)* · *On click (người vào tay)* · *Tổng (gộp cả hai)* theo khoảng thời gian và profile đang chọn, và nút chọn nguồn **Tất cả / Auto trade / On click** để lọc danh sách lệnh cùng thống kê chi tiết. Trang On click hiện ba ô này cho 7 ngày của profile đang chọn. Lệnh "On click" = lệnh có người bấm vào (ghi *vào tay bởi …*); dòng "Chuyển On click" là bot bỏ qua nên tính vào Auto trade. Hạn mức trận và số lệnh mỗi hạng vẫn **dùng chung** cho cả hai nguồn.
- **Trận thứ mấy trong giải:** cột "Trận trong giải" hiện riêng theo từng sàn (vd csgoempire 8/12, Polymarket 9/14). Hệ thống đếm ngay lúc nhận dữ liệu: gom các trận cùng giải mà sàn đang liệt kê (csgoempire theo mã giải của feed, Polymarket theo series của event), xếp theo giờ bắt đầu. Hai sàn có thể lệch vì mỗi sàn liệt kê số trận khác nhau; sàn thường không liệt kê trận đã xong nên đây là thứ tự trong các trận sàn còn hiện.
- Bảng On click nằm trong bộ nhớ app: restart app thì trống đến lần trader làm mới kèo kế tiếp.
- Tab **Lịch sử** của trang On click lưu trong database mọi kèo từng lên bảng: lên lúc nào, cập nhật bao nhiêu lần, phân tích gần nhất, **rời bảng lúc nào và vì sao**: người bấm vào lệnh (ai, kết quả), kèo bị hủy (lý do), hết hạn, bot tự vào vì giá xuống dưới ngưỡng, bot xét lại và bỏ (hết lãi…), app khởi động lại. Lọc theo kết quả, tìm theo mã kèo hoặc tên đội.
- Tìm một kèo cụ thể: **Kèo → Lịch sử**, gõ mã kèo (đủ hoặc vài ký tự đầu) hoặc tên đội, chọn "Tất cả" thời gian. Mã kèo trong chi tiết lệnh giấy bấm được để nhảy thẳng tới đó.

### Cân bằng tiền giữa csgoempire và Polymarket (35/65)

Mỗi profile nên giữ tiền theo tỉ lệ **csgoempire 35% / Polymarket 65%** (một kèo cần tiền cược csgoempire `S` và khoảng `S × O × giá` bên Polymarket, nên Polymarket cần nhiều hơn). Khi lệnh **thật** bị hủy trước khi gửi vì một bên không đủ Cash (`INSUFFICIENT_CASH`), app:

1. Lấy số dư hai bên đọc ngay trước khi gửi lệnh (ghi trong `detail.cash` của lệnh), tính `tổng = csgoempire + Polymarket`, mục tiêu csgoempire = `tổng × 35%`.
2. Đề xuất **chuyển bao nhiêu, từ đâu sang đâu** (làm tròn xuống tới cent; lệch dưới 1$ coi như đã cân). Ví dụ csgoempire 5$, Polymarket 195$ → tổng 200$, mục tiêu 70$ / 130$ → chuyển **65$ Polymarket → csgoempire**.
3. Hiện đề xuất ở đầu trang **Auto trade** (khung *Cân bằng tiền*), mở sự cố cảnh báo *Cần cân bằng tiền — profile …* ở mục Sự cố và gửi push về điện thoại (OneSignal). Lệnh hủy tiếp theo cùng tình trạng chỉ tăng bộ đếm, không báo lại; báo lại khi kế hoạch đổi chiều, số tiền lệch hơn max(5$, 10%) hoặc sau 6 giờ.
4. Nếu hai bên **đã đúng tỉ lệ** mà vẫn thiếu, hoặc chuyển theo tỉ lệ không bù được bên đang thiếu → thông báo ghi rõ *tổng tiền không đủ cho lệnh*: cần nạp thêm hoặc giảm tiền theo hạng.

Chuyển xong (tay hoặc tự động) bấm **Đã chuyển xong** để đóng đề xuất và sự cố.

#### Tối ưu theo số lệnh vào được

35/65 là tỉ lệ **mục tiêu**, không phải luật cứng. Mỗi lệnh thật cho biết **tiền một lệnh** ở mỗi bên (csgoempire = tiền cược, Polymarket = share × giá + phí) và **lệnh nhỏ nhất** (Tối thiểu của hạng ÷ tiền mục tiêu). App tính theo lệnh **đòi nhiều nhất ở mỗi bên** trong các lệnh thật 24 giờ gần đây (tối đa 50 lệnh), không theo riêng lệnh vừa hủy: tiền chân Polymarket đổi rất mạnh theo giá (kèo cửa dưới chỉ vài chục cent / share), nếu tối ưu cho đúng một lệnh rẻ thì sẽ rút cạn Polymarket rồi lệnh sau lại thiếu, tiền bị chuyển qua chuyển lại. Lịch sử này nằm trong bộ nhớ app (khởi động lại thì bắt đầu từ lệnh kế tiếp). Từ đó:

| Tình huống (vd lệnh cần 10$ csgoempire + 18$ Polymarket = 28$) | Làm gì |
| --- | --- |
| Tổng hai bên < một lệnh nhỏ nhất (vd < 28$, hoặc < 14$ nếu Tối thiểu 50%) | **Không chuyển**: chuyển qua lại cũng không vào được lệnh nào; báo "cần nạp thêm" |
| Tổng < một lệnh đầy đủ nhưng ≥ lệnh nhỏ nhất | Chia theo đúng tỉ lệ tiền lệnh cần (10 : 18) → vào được lệnh **lớn nhất** có thể |
| Đủ nhiều lệnh, chia 35/65 vào được tối đa số lệnh | Về 35/65 |
| Chia 35/65 làm một bên thiếu (vd 35% tổng < 10$, hoặc Polymarket cần nhiều hơn 65%) | Dành đủ tiền cho **số lệnh tối đa** (floor(tổng ÷ 28$)) ở mỗi bên, phần dư mới chia 35/65 |
| Chuyển không làm vào thêm được lệnh nào (đã tối ưu) | **Không chuyển** |

Chỉ chuyển khi số lệnh đầy đủ vào được **tăng**, hoặc từ không vào được lệnh nào thành vào được, hoặc (khi chưa đủ một lệnh đầy đủ) lệnh vào được lớn thêm ≥ 10% lệnh đầy đủ. Hạn mức mỗi lần / mỗi ngày cắt bớt mà số còn lại không vào thêm được lệnh → không chuyển (`LIMIT_NO_GAIN`). Cần ít hơn **Tối thiểu** thì chuyển tròn lên Tối thiểu nếu bên chuyển vẫn dư (đỡ chuyển lắt nhắt). Chưa có lệnh nào bị hủy để biết tiền một lệnh (bấm "Chuyển ngay" lần đầu) thì chỉ theo tỉ lệ 35/65.

#### Tự chuyển tiền

Bật ở **Auto trade → Giới hạn chung → Tự chuyển tiền**: **Tắt** (mặc định, chỉ đề xuất) · **Chạy thử** (tính và ghi "sẽ chuyển X$" vào lịch sử, KHÔNG gửi tiền) · **Chuyển thật**. Mỗi lượt:

1. Đọc số dư **mới** của hai tài khoản (không dùng số của lệnh vừa hủy), tính phần chênh về 35/65.
2. Số tiền = min(phần chênh, **Tối đa mỗi lần**, phần còn lại của **Tối đa mỗi ngày**); dưới **Tối thiểu** thì bỏ qua. **Mức nạp tối thiểu của sàn nhận: 3,10$** = max(3$ — mức trang nạp Polymarket ghi cho USDT Polygon, mức bridge.polymarket.com/supported-assets đang công bố) + 0,10$ đệm tỷ giá / làm tròn. Khoản nạp dưới mức Polymarket **không xử lý**: tiền nằm kẹt ở địa chỉ nạp. Lệnh rút csgoempire còn kiểm tra số USDT thực gửi theo tỷ giá và không rút nếu dưới mức. Cần chuyển ít hơn: nâng lên mức này nếu bên chuyển đủ tiền, trong hạn mức và vẫn vào thêm được lệnh; không thì không chuyển (`BELOW_DEPOSIT_MIN`). Nên đặt **Tối thiểu** ≥ 3,10$.
3. Chuyển theo đúng cách trang hai sàn làm (lấy từ HAR):
   - **Polymarket → csgoempire**: một giao dịch gasless qua relayer Polymarket: đổi pUSD → USDC.e → USDT (báo giá Relay) gửi thẳng tới **địa chỉ nạp USDT Polygon của csgoempire**. Xong khi khoản nạp có đúng mã giao dịch đó được cộng vào csgoempire.
   - **csgoempire → Polymarket**: tạo lệnh rút USDT (Polygon) trên csgoempire (qua Chrome nền của hồ sơ, như bấm Rút) về **địa chỉ nạp Polymarket**; Polymarket tự đổi USDT thành tiền giao dịch. csgoempire báo lệnh rút đã xác nhận (có mã giao dịch) mới chỉ là *Đã gửi*: **Xong** khi Polymarket báo khoản nạp hoàn tất (bridge.polymarket.com/status/<địa chỉ nạp>) hoặc Cash Polymarket tăng ≥ 90% số gửi. Polymarket báo thất bại hoặc quá 30 phút chưa thấy tiền → *Chưa xác nhận*, chặn. Sàn thu phí rút > 0 thì không tự rút.
4. Kết quả vào **Lịch sử chuyển** (cùng tab), sự kiện vận hành và push.

Chốt an toàn:

- Chỉ gửi tới **địa chỉ nạp đã lưu** trong tài khoản (Auto trade → Tài khoản → sửa): csgoempire có nút **Lấy từ csgoempire** (đối chiếu với trang trước khi lưu); lúc chuyển, địa chỉ trang csgoempire trả phải trùng địa chỉ đã lưu, khác thì dừng. Địa chỉ nạp Polymarket lấy ở Polymarket → Deposit → Crypto → USDT (Polygon); **không** dùng địa chỉ ví ký / ví proxy.
- Mỗi profile một lượt (khóa Redis); xong một lượt thì tự động chờ 10 phút mới chuyển tiếp (bấm **Chuyển ngay** thì không chờ).
- Lỗi **trước** khi gửi → *Lỗi*, trả lại hạn mức ngày. Lỗi **sau** khi đã gửi, hoặc quá 30 phút chưa xác nhận → *Không rõ / Chưa xác nhận*: **tự chuyển của profile đó dừng**, mở sự cố nghiêm trọng; kiểm tra số dư hai sàn và Polygonscan rồi bấm **Đã kiểm tra — gỡ chặn**. App không bao giờ tự gửi lại.
- Tài khoản đang khóa đối soát / phiên csgoempire hỏng thì không chuyển.

Nên bật **Chạy thử** vài lần, xem số tiền và chiều trong lịch sử đúng, rồi mới **Chuyển thật** với hạn mức nhỏ.

Lưu ý: số dư là Cash **rảnh** (chưa gồm tiền đang nằm trong lệnh chưa có kết quả), nên tỉ lệ chỉ đúng cho phần tiền đang rảnh. Đề xuất chỉ nằm trong bộ nhớ app (restart = mất đề xuất, lệnh hủy kế tiếp tạo lại); sự cố vẫn lưu ở lịch sử Sự cố.

### Sổ phơi nhiễm (Redis) và thống kê Lệnh giấy

Hai nguồn số liệu khác nhau:

- **Thống kê ở Lệnh giấy** (lãi giả định, tiền vào, số lệnh…) tính từ **lịch sử lệnh còn lưu trong database**. Xóa lệnh thì số này giảm.
- **Sổ phơi nhiễm** là bộ đếm trong **Redis** mà trader dùng để quyết định: tiền đã dùng theo trận (chung + riêng profile) và số lệnh đã vào mỗi cửa mỗi hạng. Xóa lệnh **không** đổi sổ này; mỗi lệnh vào mới gia hạn 12 giờ.

Xem sổ ở **Auto trade → Giới hạn chung → Sổ phơi nhiễm (Redis)**: còn bao nhiêu hạn mức mỗi trận, cửa nào đã đủ số lệnh, bao lâu nữa hết hạn. Nút **Trả lại** xóa bộ đếm tiền của một trận; **Đặt lại** đếm lại số lệnh của một cửa. Khi "Hết hạn mức trận" hay việc không vào thêm lệnh trông vô lý so với Lệnh giấy, xem ở đây trước.

### Kèo bị hủy vì lệch giờ bắt đầu

Giờ bắt đầu không cố định: mỗi bản tin của sàn mang giờ bắt đầu mới nhất (trận bị dời, giờ dự kiến → giờ thực tế, sàn sửa dữ liệu). Hệ thống kiểm tra lại mỗi khi có bản tin; hai bên lệch quá **Lệch giờ bắt đầu tối đa** (Cài đặt arbitrage, mặc định 20 phút) thì kèo bị hủy với lý do `start_time_mismatch`.

Mỗi kèo lưu giờ bắt đầu từng chân **lúc phát**; khi hủy, hệ thống chụp giờ từng chân **lúc hủy**, độ lệch và ngưỡng. Xem ở:

- **Kèo → Lịch sử → mở một kèo → Giờ bắt đầu**: bảng lúc phát / lúc hủy / bên nào dời bao nhiêu, và "lúc phát lệch X → lúc hủy lệch Y · cho phép ≤ Z".
- **Bảng lịch sử và luồng kèo trực tiếp**: lý do kèm "lệch 45 phút (cho phép ≤ 20 phút)".
- **Auto trade → Lệnh giấy → mở lệnh**: giờ từng chân lúc phát; nếu kèo bị hủy khi trader đang tính thì thêm giờ lúc hủy.
- **Tin hủy trên Discord/Telegram/Slack**: trường "Giờ bắt đầu lúc hủy".

Kèo phát trước khi có tính năng này không có giờ lúc phát.

## Khi thấy số liệu khác kỳ vọng

| Hiện tượng                                   | Kiểm tra đầu tiên                                                                                |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Có bản tin nhưng Đổi cuối không mới          | Xem `skipped` theo kind; phân biệt bản tin bổ sung, token lạ và lỗi schema                       |
| `parse_failed` tăng                          | Xác định descriptor hay stream; lấy mẫu payload, so đường dẫn trường với schema                  |
| `unknown_asset` tăng                         | Descriptor đã có market và token chưa? Stream có đang nhận token ngoài tập theo dõi không?       |
| Có hai tenant mà không có kèo                | Kiểm tra trạng thái open, cùng market, giờ bắt đầu, phase và margin                              |
| Cùng trận ngoài đời nhưng nằm ở hai room     | Kiểm tra tên chuẩn hóa, bí danh và loại market                                                   |
| `coalesced` tăng                             | Làn đang gộp cập nhật cũ; xem kèm queued, thời gian xử lý và lỗi, không kết luận đó là parse lỗi |
| Consumer connected nhưng không nhận tín hiệu | Kiểm tra pause, tín hiệu active, thời hạn và các lần phát tiếp theo                              |
| `pendingDeliveries` tăng                     | Consumer có gửi ACK đúng deliveryId không? Có đang mất kết nối không?                            |
| Cấu hình vừa đổi bị mất sau restart          | Đã chạy migration `0003` chưa? Log khởi động có báo lỗi đọc cấu hình đã lưu không?               |
| Kênh thông báo không nhận kèo                | Kênh có bật không? Kèo có thuộc hạng kênh đã chọn không? Bấm “Gửi tin kiểm tra” để xem lỗi       |

Nếu chạy trong repo, có thể lấy mẫu API và stream công khai của Polymarket bằng:

```bash
pnpm exec tsx scripts/diagnose-polymarket-ingest.ts
```

Công cụ này kiểm tra mẫu descriptor và stream theo schema hiện tại; nó không đọc lịch sử payload của backend đang chạy.

### Các file định nghĩa hành vi

| Chủ đề                       | File trong repo                                                                    |
| ---------------------------- | ---------------------------------------------------------------------------------- |
| Bản tin task                 | `src/modules/tasks/application/task-protocol.ts`                                   |
| Báo giá và room              | `src/modules/odds/domain/odds-line.ts`, `odds-room.ts`, `match-key.ts`             |
| Công thức margin và tín hiệu | `src/modules/odds/domain/arbitrage-opportunity.ts`, `signal-policy.ts`             |
| Đếm ingest                   | `src/modules/odds/application/ingest-stats.ts`                                     |
| Lane và evaluator            | `src/modules/odds/application/lane-dispatcher.ts`, `arbitrage-evaluator.ts`        |
| Parser Polymarket            | `src/modules/odds/infrastructure/acl/polymarket/`                                  |
| Giao tín hiệu và ACK         | `src/modules/odds/infrastructure/consumer/consumer-hub.ts`, `consumer-protocol.ts` |
| Lãi theo ngày               | `src/shared/domain/daily-return.ts`                                                |
| Cân bằng tiền 35/65          | `src/modules/trading/domain/balance-rebalance.ts`, `application/rebalance-advisor.ts` |
| Tự chuyển tiền               | `src/modules/trading/application/rebalance-executor.ts`, `src/shared/infrastructure/trading/empire-cashier.ts`, `polymarket-cashier.ts` |
| API                          | `docs/API.md`, Swagger tại `/docs` trên backend khi được bật                       |

Tài liệu mô tả triển khai hiện tại của repo. Khi thay đổi mapping, chính sách hoặc adapter lưu trữ, cần cập nhật mục tương ứng.
