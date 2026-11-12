# Giao dịch thật trên Linux

Auto trade và nút **Vào lệnh** ở On click dùng chung worker, bảng vốn, chiến lược và giới hạn của profile. Profile cũ và profile mới mặc định là `paper`. Đổi **Chế độ giao dịch** thành **Thật** để worker thực thi API của hai sàn.

Với các môn thể thao mới (như bóng đá), cần cho phép thêm môn đó trong môi trường
của tiến trình chạy trader. Ví dụ để bật riêng bóng đá:

```dotenv
TRADING_LIVE_SPORTS=soccer
```

Đặt biến này trong `.env` trên server hoặc biến môi trường của service chạy backend /
`task-runner`, triển khai bản code mới và khởi động lại tiến trình đó. Nếu trader
chạy ở node khác, đặt biến trên node đó. Không cần migrate database. Profile vẫn
cần ở chế độ **Thật**; các kiểm tra sổ lệnh, hạn mức và số dư vẫn áp dụng. Chỉ bật
môn sau khi đối chiếu loại kèo, thời gian và quy tắc thanh toán hai sàn.

## SeleniumBase Chrome qua CDP

Mặc định `launchProfile()` chạy Python để mở Chrome bằng `sb_cdp.Chrome()` của SeleniumBase, rồi TypeScript kết nối bằng `chromium.connectOverCDP()`. Luồng này không tạo Selenium WebDriver/ChromeDriver session. Cài Python và Google Chrome trên máy chạy backend, sau đó:

```sh
python -m pip install -r requirements.txt
```

```dotenv
TRADING_BROWSER_ENGINE=seleniumbase
# Đường dẫn executable Python của virtualenv nếu cần (không kèm tham số):
# TRADING_PYTHON_PATH=C:/Code/nest-de-hieu-v2/.venv/Scripts/python.exe
# TRADING_PYTHON_PATH=/opt/arb/.venv/bin/python
# TRADING_CHROMIUM_PATH=/usr/bin/google-chrome
```

Chrome chỉ mở khi cần đăng nhập/làm mới JWT; JWT còn hạn dùng cache nên không giữ browser chạy chờ. Cổng CDP tự cấp riêng trên loopback; CLI đăng nhập vẫn dùng `TRADING_DEBUG_PORT` để SSH tunnel. `login: true` mở giao diện, còn refresh mặc định headless. App không tự giải CAPTCHA/OTP.

```ts
const context = await launchProfile('empire-main', { login: true, signal });
try {
  const page = context.pages()[0] ?? (await context.newPage());
  // Điều khiển page bằng Playwright như hiện tại.
} finally {
  await context.close(); // Đóng CDP và Chrome; giữ profile trên đĩa.
}
// Có thể dừng từ nơi khác, kể cả lúc browser đang khởi động:
await closeProfile('empire-main');
await closeAllProfiles();
```

Đóng nhiều lần an toàn; mở trùng profile đang chạy báo `BROWSER_PROFILE_IN_USE`. Abort/timeout/lỗi CDP đều dọn helper. Python theo dõi stdin: backend thoát thì helper tự dừng và dọn các tiến trình con do nó tạo. Có deadline để buộc dừng nếu helper bị treo. Nest build tự chép file Python cạnh JavaScript trong `dist`; môi trường deploy vẫn cần Python, các package trong requirements và Chrome. Luồng CDP không cần tải ChromeDriver.

`TRADING_BROWSER_ENGINE=playwright` dùng launcher Playwright trực tiếp. `--har=...` tự dùng nhánh này vì ghi HAR phải cấu hình lúc tạo context; cài Chromium bằng lệnh Playwright ở phần dưới cho nhánh này.

Smoke test dùng profile tạm và nội dung cục bộ, không đăng nhập hay đặt lệnh:

```sh
pnpm exec tsx scripts/smoke-trading-browser.ts
pnpm exec tsx scripts/smoke-trading-login.ts
```

## Windows local: đăng nhập tự động bằng nút

1. Chạy backend trực tiếp trong phiên Windows desktop đang sử dụng; cài Python, Google Chrome và requirements SeleniumBase ở phần trên. Chuẩn bị Redis và `TRADING_SECRET_KEY` như phần dưới.
2. Auto trade → Tài khoản → Sửa csgoempire: nhập **Email đăng nhập** và **Mật khẩu đăng nhập** rồi lưu. Cả hai được mã hóa cùng nhau bằng AES-256-GCM; API chỉ trả `hasSecret`, không trả lại tài khoản/mật khẩu. Khi sửa, để trống cả hai ô để giữ thông tin cũ.
3. Bấm **Mở Chromium & đăng nhập** ở tài khoản hoặc trang On click. App mở cửa sổ Chromium có giao diện, gõ từng ký tự và bấm đăng nhập. Nếu profile đã đăng nhập, app dùng lại phiên. Không cần SSH hoặc `chrome://inspect` cho luồng này.
4. Bảng trạng thái hiển thị mở Chromium → đăng nhập → lấy phiên → sẵn sàng. JWT nằm ở backend; sau khi lấy và xác thực phiên, cửa sổ tự đóng, cấu hình worker cập nhật ở nhịp đối chiếu tiếp theo.
5. Bấm **Vào lệnh** cho kèo bạn chọn hoặc chạy Auto trade theo cấu hình profile. Đăng nhập thành công không tự tạo một cược thử. Quy tắc Cash hai sàn vẫn áp dụng.

Sau lần đăng nhập bạn vừa bấm, bảng hiển thị **JWT vừa lấy** đúng một lần, sau khi toàn bộ kiểm tra phiên và tài khoản thành công. Đóng bảng sẽ xóa token khỏi giao diện; mở lại không hiển thị lại. Các lần tự làm mới không tạo bản xem JWT. Backend chỉ cho người có quyền quản lý nhận bản xem qua POST riêng, tiêu thụ đúng một lần theo mã lần đăng nhập; bản chưa nhận tự hết hạn sau 5 phút. Token không được ghi vào localStorage, lịch sử, log hay API trạng thái định kỳ.

Nếu đăng nhập thất bại, bảng hiển thị bước dừng và mã HTTP nếu có: mở trang → đăng nhập → nhận JWT → xác thực BetBy → xác nhận tài khoản. `CSGOEMPIRE_SESSION_EXPIRED` chỉ dùng cho phản hồi xác thực HTTP 401; lỗi tải trang, phản hồi JWT, HTTP 403 và lỗi kết nối có mã riêng. Nếu Chromium đóng nhanh, xem **Dừng ở bước** để biết bước cần xử lý.

Nếu profile đang dùng COINS (`EMP`), EUR hoặc GBP, app mở bộ chọn tiền ở số dư → **USD** → **Apply**, rồi chờ phản hồi phiên USD mới trước khi xác thực. Profile đã dùng USD bỏ qua thao tác này. Token ban đầu không bị đổi nhãn hoặc được coi là USD; JWT mới và phản hồi identify vẫn phải xác nhận USD. Nếu không mở được bộ chọn hoặc không nhận phiên mới trong 30 giây, UI báo lỗi ở bước **Chuyển tiền tệ sang USD**. Thiết lập được lưu trong profile riêng của app, không dùng thư mục Chrome cá nhân.

**Cửa sổ xuất hiện trên máy chạy backend.** Backend chạy trên Linux/server, Docker, WSL hay Windows service không có phiên desktop sẽ không mở Chromium trên desktop máy đang xem trang web.

Nếu gặp CAPTCHA/OTP/xác minh hoặc mật khẩu bị từ chối, app dừng và báo lỗi, không tự vượt hay liên tục thử lại. Phiên hết hạn có thể tự đăng nhập lại bằng thông tin mã hóa đã lưu; lỗi đăng nhập/xác minh sẽ giữ trạng thái dừng cho đến khi bạn cập nhật thông tin hoặc bấm chạy lại.

Sau khi bấm **Log In**, app chờ tối đa 90 giây để sàn xác nhận đăng nhập, không bấm gửi lại khi nút đang tải. Nếu hết thời gian này, mã `CSGOEMPIRE_LOGIN_NOT_CONFIRMED` chỉ có nghĩa chưa xác nhận được kết quả, không chứng minh mật khẩu sai. App chỉ chuyển sang bước lấy JWT sau khi thấy phiên hợp lệ hoặc form đăng nhập và nút đăng nhập không còn hiển thị. Bước chờ JWT có 45 giây riêng sau luồng đăng nhập, không bị thời gian tải trang và gõ thông tin làm tiêu hao. Browser vẫn được đóng khi thành công, lỗi hoặc hủy để giải phóng bộ nhớ.

Bảng đăng nhập hiển thị trạng thái request xác thực đã quan sát được (đang chờ, đã phản hồi hoặc lỗi kết nối), HTTP status, thời gian và lỗi tải dịch vụ xác minh nếu có. Chẩn đoán chỉ theo dõi metadata; không đọc hoặc ghi payload đăng nhập, cookie hay header xác thực. `Chưa quan sát được request đăng nhập` chỉ nói rằng chưa thấy POST đến endpoint login được nhận diện, không kết luận toàn bộ trình duyệt không gửi request. Lỗi tải dịch vụ xác minh được báo riêng; app không coi việc hủy request khi chuyển trang là lỗi kết nối.

Đã kiểm tra trực tiếp form trên Chrome: bấm **Sign In**, nhập **Email** (`input[type="email"]`) và **Password**, rồi bấm **Log In** (`#auth-login-submit`). ID của hai ô nhập được sinh động nên adapter không dùng các ID đó. Lần thử trên Chrome đã đăng nhập thành công mà không cần thao tác CAPTCHA hay OTP; điều này không đảm bảo các lần đăng nhập sau cũng không cần xác minh. Nếu sàn đổi form, adapter có thể cấu hình các CSS selector `TRADING_EMPIRE_OPEN_SELECTOR`, `TRADING_EMPIRE_USERNAME_SELECTOR`, `TRADING_EMPIRE_PASSWORD_SELECTOR`, `TRADING_EMPIRE_SUBMIT_SELECTOR`. Chỉ hỗ trợ form tài khoản/mật khẩu trên `https://csgoempire.com`, không tự nhập thông tin vào trang Steam/OAuth hay host khác.

## Chuẩn bị server

Node 24, Python, Google Chrome, Redis bền vững (bật AOF, không eviction) và thư mục profile nằm trên đĩa bền vững. App và Chrome lấy phiên phải chạy cùng server/IP. Remote worker phải dùng cùng Redis, khóa mã hóa và cùng IP ra ngoài cho các request tài khoản.

```sh
pnpm install --frozen-lockfile
python -m pip install -r requirements.txt
# Chỉ cần khi dùng engine Playwright hoặc --har:
# pnpm exec playwright install --with-deps chromium
pnpm build
```

Biến môi trường:

```dotenv
REDIS_URL=redis://127.0.0.1:6379
TRADING_SECRET_KEY=<khóa chủ hiện có dùng mã hóa private key>
TRADING_BROWSER_ROOT=/var/lib/arb-ops/browser-profiles
# Tùy chọn: Chromium hệ thống thay cho bản Playwright tải về
# TRADING_CHROMIUM_PATH=/usr/bin/chromium
# TRADING_BROWSER_HEADED=1
# Chỉ bật khi DISPLAY và XAUTHORITY do service Xvfb cố định quản lý.
# TRADING_EXTERNAL_DISPLAY=1
# TRADING_DEBUG_PORT=9222
```

Giới hạn quyền thư mục profile cho user chạy app (`0700`). Không đưa profile, HAR, `.env`, cookie hay JWT vào Git. Không đổi khóa mã hóa đã dùng cho ví hiện có.

## Đăng nhập thủ công

Ô **Hồ sơ trình duyệt** của tài khoản csgoempire là tên thư mục riêng, ví dụ `empire-main`. Dừng giao dịch trong lúc đăng nhập; khóa tài khoản ngăn worker và tác tử phiên chạy đồng thời.

```sh
xvfb-run -a pnpm trading:login empire-main
# Ghi HAR nếu cần kiểm tra giao thức; file chứa thông tin phiên nhạy cảm:
xvfb-run -a pnpm trading:login empire-main --har=/secure/empire.har
```

Lệnh in SSH tunnel. Chạy tunnel trên máy cá nhân, mở `chrome://inspect/#devices`, thêm `localhost:9222`, chọn **Inspect**, đăng nhập và mở Match betting trên tab Chromium của server. Nhấn Enter ở terminal server để đóng Chromium và lưu phiên. Trình quản lý mật khẩu Chromium bị tắt. Đây là luồng thủ công tùy chọn; luồng tự động dùng thông tin mã hóa trong database.

App dùng chính luồng phiên của trang để nhận JWT mới, gọi identify bằng API, rồi gửi phiên trong lệnh `config` riêng cho worker. JWT được giữ trong bộ nhớ của backend/worker; cookie và device session đăng nhập chỉ nằm trong hồ sơ Chromium, không bị sao chép sang cấu hình worker và không xuất hiện ở API cấu hình cho web. Khi có worker live đang chạy, phiên được kiểm tra theo nhịp đối chiếu 30 giây và làm mới khi còn khoảng **10 phút** trước hạn `exp` (JWT 30 phút được làm mới ở phút thứ 20). Nếu sàn cấp JWT sống không quá 10 phút, dùng mốc 80% thời hạn để tránh mở Chromium ở mọi nhịp đối chiếu. Khởi động lại backend sẽ lấy JWT từ phiên trong hồ sơ, không dùng JWT cũ lưu trên đĩa. Gặp CAPTCHA/xác minh/phiên hết hạn sẽ đứng yên với lý do **Phiên csgoempire hết hạn**. Đăng nhập lại bằng nút hoặc lệnh trên; không tự vượt xác minh. VPS có thể dùng `arb-xvfb.service` với `TRADING_EXTERNAL_DISPLAY=1` để Chrome có giao diện dùng display cố định `:99`; `arb-x11vnc.service` bắt buộc mật khẩu và `arb-novnc.service` chỉ nghe loopback để xem qua SSH tunnel.

## Cash và kết quả hai chân

- Polymarket: đọc balance collateral của đúng ví funder, đơn vị USD; không đọc Portfolio hoặc định giá vị thế. Kiểm tra allowance và yêu cầu Cash đủ cho giá giới hạn cùng phí ước tính.
- csgoempire: đọc số dư hiện tại qua `/api/v2/metadata` (`user.balance`, đối chiếu `balances[].balance_coins`; `/api/v2/user` cũ trả 403), quy đổi coins → USD bằng tỷ giá API, kiểm tra cược tối thiểu và `coupon/max`.
- Trong khóa của cả hai tài khoản, chuẩn bị và kiểm tra Cash hai sàn trước mọi request đặt lệnh. **Một bên thiếu Cash: hủy cả cặp, không gửi chân nào.** Không tự giảm tiền vì thiếu Cash. Màn hình chi tiết ghi Cash hiện có và số tiền cần từng sàn.
- csgoempire chỉ chấp nhận odds bằng hoặc tốt hơn; Polymarket dùng FOK với số share và giá giới hạn. Lưu mã lệnh, số lượng, thời gian và trạng thái riêng mỗi chân. Phí Polymarket hiện vẫn là ước tính bảo thủ; lợi nhuận hiển thị là dự kiến theo hai cửa, chưa phải tiền đã quyết toán trận.
- Hai sàn không hỗ trợ commit nguyên tử. Số dư/giá có thể đổi sau kiểm tra. Nếu đã gửi mà có chân bị từ chối, chưa khớp hoặc mất phản hồi: ghi **Cần đối soát**, khóa bền vững cả hai tài khoản và ngừng lệnh mới. Không tự cược lại, cashout hay đảo vị thế.
- Redis lưu dấu đã gửi theo profile + signal + issuedAt và kết quả dưới `trade:result:<id>`. Xóa lịch sử ở UI hoặc khởi động lại không xóa dấu đã gửi. Nếu worker chết trong lúc gửi, dấu dừng vẫn còn; cần kiểm tra lịch sử hai sàn trước khi mở lại.

Sau khi đã kiểm tra kết quả trên cả hai sàn và xử lý vị thế còn lại, mở lại từng tài khoản liên quan:

```sh
pnpm trading:resume csgoempire empire-main --reconciled
pnpm trading:resume polymarket 0xFunderWalletAddress --reconciled
```

Đăng nhập lại chỉ gỡ lỗi hết phiên; không gỡ trạng thái cần đối soát. Hạn mức đã giữ cho lệnh chưa rõ kết quả được giữ nguyên để tránh tiêu thêm tiền. Cập nhật/gỡ hạn mức qua trang Giới hạn sau khi đã đối soát.

## Giới hạn xác minh

Giao thức csgoempire được đối chiếu từ HAR đã cung cấp và JavaScript frontend trong HAR: user-session, identify, coupon/max và bet/place. HAR chỉ có một ví dụ đặt cược thành công; cần xác minh phản hồi cược bị từ chối và hợp đồng Cash trên tài khoản thật ở server trước khi vận hành. Endpoint của BetBy hiện dùng origin/brand trong HAR; nếu sàn đổi origin cần cập nhật adapter/schema.

Kiểm thử tự động dùng API giả, không đặt cược hay gửi giao dịch bằng tiền thật. Không bật live cho profile hiện có hoặc chạy lệnh đặt cược trong quá trình triển khai code.
