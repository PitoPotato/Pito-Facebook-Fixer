# TODO — PitoFacebookFixer

Cập nhật: 10/11/2026. Phần 1 và phần 3 đã làm trong bản 0.3.0 (chưa commit); phần 2 chưa triển khai. Số dòng trích dẫn trỏ vào bản 0.2.0, commit `e1873b2`.

Nhãn kết quả: **[Xong]** đạt test tự động; **[Facebook thật]** đã thử thêm trên tài khoản thử nghiệm; **[Một phần]** còn thiếu, ghi rõ ở dòng đó. Chi tiết: [TEST_RESULTS.md](TEST_RESULTS.md).

Nhãn độ chắc chắn:

- **[Code]**: đã xác nhận bằng cách đọc mã nguồn, chưa đo hoặc chạy lại.
- **[Giả thuyết]**: chưa thử, phải có thí nghiệm trước khi làm.

Quy tắc áp dụng cho mọi mục: làm đúng [AGENTS.md](AGENTS.md) và [QA.md](QA.md). Không dùng Facebook chính, chỉ dùng profile riêng và tài khoản thử nghiệm. Fixture đạt không được tính là production đạt. Bộ đếm quan sát không phải bằng chứng đã ghi thành công.

Nghiên cứu nền: [docs/message-recovery-research.md](docs/message-recovery-research.md).

## 0.3.1

- [x] **Ảnh thu hồi chỉ hiện chữ “Ảnh đã thu hồi — bản lưu trên máy” thay cho ảnh.** Người dùng báo lỗi này với tin nhận được.
  - Kết quả: **[Xong]** về test tự động. **Chưa thử trên Facebook thật.**
  - Nguyên nhân (đã tái hiện bằng fixture): một lần đọc kho lỗi tạm thời thì ảnh không bao giờ được thử lại; Facebook vẽ lại bong bóng thì ảnh bị đọc lại từ đầu; đọc ảnh phải xếp hàng sau các lượt ghi.
  - Đã làm: thử lại từng phần, dùng chung một lượt đọc cho mọi chỗ hiển thị, đọc tệp không qua hàng đợi ghi. Thêm lưới ảnh trong bong bóng và trình xem phóng to/chuyển ảnh.
  - Còn phải làm: thử trên Facebook thật với tin **nhận từ một tài khoản thử nghiệm khác** (cần người dùng chỉ định tài khoản gửi), album nhiều ảnh chụp bằng điện thoại, và chat dạng cửa sổ nhỏ (popup).

## Thứ tự đề xuất

1. **0.3 — Kho và hiệu năng:** viết bài đo (mục 3.1), rồi làm phần 1 và các mục tối ưu 3.2–3.4.
2. **Thí nghiệm:** adapter chỉ đọc qua `__d` trên tài khoản thử nghiệm (mục 2.1).
3. **0.4 — Nguồn dữ liệu mới:** nếu thí nghiệm đạt, chuyển nguồn chính, giữ DOM làm dự phòng, thêm media mở rộng.
4. **0.5 — Tin tự xóa:** bật theo lựa chọn của người dùng, mặc định tắt.

---

## 1. Vấn đề tồn đọng trong code

### Ưu tiên cao: đang có nguy cơ mất dữ liệu

- [x] **Tin thu hồi bị xóa ngang hàng tin thường khi đầy kho.** [Code]
  - Kết quả: **[Xong]** dọn tin thường trước, tin thu hồi sau cùng.
  - Vị trí: `pruneTransaction` ([src/archive.js:185-195](src/archive.js#L185-L195)) xóa theo `capturedAt`; mặc định `cleanupRemoved: true`, 32 MiB ([src/shared.js:6-7](src/shared.js#L6-L7)).
  - Sửa: xóa hết tin thường đủ điều kiện trước, chỉ đụng tin thu hồi khi vẫn vượt giới hạn.
  - Xong khi: unit test chứng minh kho đầy thì tin thường mới hơn bị xóa trước tin thu hồi cũ hơn.
- [x] **Hạn lưu không gia hạn khi tin bị thu hồi.** [Code]
  - Kết quả: **[Xong]** hạn lưu tính từ lúc thu hồi; bản ghi cũ được tính lại ở lượt dọn kế tiếp.
  - Vị trí: `expiry` ([src/archive.js:13](src/archive.js#L13)) luôn tính từ `capturedAt`. Tin thu hồi vào ngày 29 sẽ mất vào ngày 30.
  - Sửa: với tin đã thu hồi, tính hạn từ `removedAt`.
- [x] **Batch lỗi bị bỏ và không được thử lại.** [Code]
  - Kết quả: **[Xong]** thử lại 3 lần (5/20/60 s), giới hạn 128 tin và 64 MiB; tin thu hồi trong lúc chờ đi sau tin gốc; hết lượt thì hàng được đọc lại khi đổi hoặc cuộn.
  - Vị trí: [src/content.js:165](src/content.js#L165) bỏ batch sau 3 lần thử, trong khi adapter đã ghi nhận fingerprint của hàng ([src/adapter.js:192](src/adapter.js#L192)).
  - Sửa: báo về MAIN để đánh dấu các hàng chưa ghi, giới hạn số lần thử, không tạo hàng đợi vô hạn.
- [x] **Không có sao lưu; gỡ extension là mất kho.** [Code]
  - Kết quả: **[Xong]** xuất/nhập `.pffbak` mã hóa, kiểm tra toàn tệp trước khi nhập, không ghi đè/không dọn; `persist()` và dung lượng thực. Chưa thử trên Facebook thật.
  - Thêm xuất/nhập file mã hóa bằng mật khẩu, không gửi đi đâu.
  - Gọi `navigator.storage.persist()` và hiển thị trạng thái.
  - Xong khi: xuất, xóa kho, nhập lại đúng từng SHA-256 và đúng phân tách tài khoản.

### Thiếu chức năng lưu trữ

- [x] **Tin bị sửa mất nội dung cũ.** [Code]
  - Kết quả: **[Facebook thật]** giữ tối đa 5 bản trước; đã thử sửa rồi thu hồi trên tài khoản thử nghiệm.
  - Vị trí: bản ghi bị thay thế tại [src/archive.js:143-163](src/archive.js#L143-L163).
  - Sửa: lưu lịch sử sửa có giới hạn (ví dụ 5 bản), tính vào ngân sách kho.
- [x] **Không lưu người gửi, giờ gửi thật, nội dung trả lời.** [Code]
  - Kết quả: **[Một phần]** lưu tên người gửi (từ tiêu đề hàng, đã thấy trên Facebook thật) và trích dẫn trả lời. **Mã người gửi và giờ gửi chưa lấy được trên Facebook thật**: dò tên prop React quanh hàng tin không thấy model tin nhắn. Cần adapter dữ liệu ở mục 2.1. Phần lưu/hiển thị đã sẵn sàng.
  - Hiện chỉ có `capturedAt`; `identityStamp` không được lưu.
  - Thêm `senderId`, `timestampMs`, thông tin reply khi có nguồn tin cậy.
- [x] **Trang bản lưu chỉ xem được tin đã thu hồi.** [Code]
  - Kết quả: **[Xong]** bộ lọc Đã thu hồi / Chưa thu hồi / Tất cả; "Đã tự xóa" có trong kho nhưng khóa với nhãn Đang phát triển cho tới mục 2.4.
  - Vị trí: `listRemoved` ([src/archive.js:230-241](src/archive.js#L230-L241)); `assetChunk` đòi `removedAt` ([src/archive.js:251](src/archive.js#L251)).
  - Sửa: thêm trạng thái bản ghi (thường / đã thu hồi / đã tự xóa) và bộ lọc.
- [x] **Tìm kiếm chỉ lọc trên các hàng đã tải trong trang hiện tại.** [Code]
  - Kết quả: **[Xong]** tìm trong toàn kho phía worker, gồm bản sửa cũ và tên; quét tối đa 4.000 tin mỗi lần (400 khi có khóa) rồi tiếp tục.
  - Vị trí: `filterArchive` ([src/ui.js:142](src/ui.js#L142)). Cân nhắc tìm phía background theo từng trang.
- [x] **Chỉ lưu ảnh và voice.** [Code]
  - Kết quả: **[Xong]** sticker, GIF, tệp có liên kết trực tiếp (`.fbsbx.com`), video tắt mặc định với giới hạn 1–64 MiB. **Chưa thử trên Facebook thật**; markup thật và video MSE có thể khác fixture.
  - Vị trí: `validMediaDescriptor` ([src/media.js:18](src/media.js#L18)); bộ lọc loại trừ ([src/media-dom.js:22](src/media-dom.js#L22)).
  - Thêm GIF, sticker, tệp. Video có giới hạn dung lượng riêng và **mặc định tắt**.
- [x] **Kho chưa mã hóa.** [Code]
  - Kết quả: **[Facebook thật]** khóa mật khẩu tùy chọn (RSA-OAEP + AES-GCM, khóa riêng chỉ ở session storage). Đã thử bật, khóa, thu hồi khi khóa, mở khóa, tắt. Giới hạn: khi khóa thì bỏ qua bản sửa của tin cũ; ID/thời gian/loại và cỡ tệp vẫn đọc được; quên mật khẩu chỉ có cách xóa kho.
  - Đã ghi nhận trong README. Cân nhắc khóa bằng mật khẩu, khóa chỉ giữ trong phiên.

Schema đã nâng lên 5 (thêm chỉ mục), giữ nguyên dữ liệu cũ; đã thử nâng cấp từ kho do bản 0.2.0 thật ghi ra.

### Lỗi nhỏ

- [x] Nhận diện chữ thu hồi chỉ có EN/VI ([src/adapter.js:50-54](src/adapter.js#L50-L54)); Facebook ở ngôn ngữ khác sẽ không khớp. Sẽ bớt quan trọng nếu có cờ từ model.
  - Kết quả: **[Một phần]** thêm ES/FR/DE/IT/PT/ID theo cụm "hủy gửi" cụ thể. **Chưa đối chiếu trên Facebook thật.**
- [x] Thông báo lỗi còn viết cứng tiếng Việt dù English là mặc định: [src/archive.js:14](src/archive.js#L14), [src/background.js:19](src/background.js#L19), [src/content.js:17](src/content.js#L17) và các chỗ tương tự.
  - Kết quả: **[Xong]** lỗi dùng mã ổn định, dịch EN/VI khi hiển thị; có test chặn chữ Việt viết cứng trong lỗi.
- [x] Biến `normalized` không được dùng trong `detectedMime` ([src/media.js:41](src/media.js#L41)).
  - Kết quả: **[Xong]**

### Kiểm thử và tính năng còn dang dở

- [ ] Chưa có kiểm thử hai tài khoản gửi–nhận trên Facebook thật. Cần người dùng cung cấp tài khoản thử nghiệm thứ hai và tự đăng nhập.
- [x] Bản 0.2.0 chưa có lượt kiểm thử production mới.
  - Kết quả: thay bằng lượt kiểm thử 0.3.0 trên tài khoản thử nghiệm: 8 chu kỳ gửi/lưu/thu hồi/hiển thị qua 3 phiên, sửa tin, khóa mật khẩu, reload; bằng chứng từng bước trong `test-results/live-qa-0.3.0/report-session3.json`. Xem TEST_RESULTS.
- [ ] Chưa kiểm chứng giữ ô soạn với bộ gõ tiếng Việt thật.
- [ ] Chặn đã xem story đang vô hiệu hóa, nhãn "Đang phát triển".

---

## 2. Các cách bắt tin và khôi phục cần thử

### 2.1 Thí nghiệm adapter tầng dữ liệu (ưu tiên nhất)

- [ ] **Bọc registry `__d`, chỉ đọc các thủ tục `LS*`/`MAW*`.** [Giả thuyết]
  - Cơ sở: `fb-unsend-viewer` đang dùng hướng này. Giấy phép của repo đó là phi thương mại: **chỉ tham khảo ý tưởng, không sao chép mã**.
  - Yêu cầu: chỉ quan sát, giữ nguyên tham số và giá trị trả về, bọc `try/catch`, có công tắc tắt, không chặn lệnh của Facebook.
  - Câu hỏi cần trả lời: bắt được tin trước khi dựng không; có áp dụng cho chat chưa mở không; ID có ổn định qua thu hồi không; E2EE có đi qua cùng đường không.
- [ ] **Cứu dòng gốc ngay trước `LSDeleteThenInsertMessage`.** [Giả thuyết]
  - Ghi lại dữ liệu trước và sau khi thu hồi. Chỉ nhận nội dung xác minh đúng ID và tài khoản.
- [ ] **Lấy trường từ model khi có:** `SenderId`, `TimestampMs`, `IsUnsent`, `UnsentTimestampMs`, `EditCount`, `EphemeralDurationInSec`, `EphemeralExpirationTs`, `ReplySnippet` (theo mautrix; tên trong web có thể khác).

Tiêu chí đi tiếp: bắt được tin trước render trên tài khoản thử nghiệm, ID ổn định qua thu hồi, commit bền vững, media đọc lại được, không đổi luồng Messenger, số liệu RAM/CPU không tệ hơn 0.2.0.

### 2.2 Media

- [ ] **Bọc `URL.createObjectURL` để giữ Blob đã giải mã.** [Giả thuyết] Giữ tham chiếu ngắn hạn, có giới hạn; thay cho việc đọc lại blob muộn ở [src/main.js:36-41](src/main.js#L36-L41).
- [ ] **Lưu `media_key` + con trỏ blob thay vì binary.** [Giả thuyết] Whitepaper E2EE trang 17 xác nhận tin nhắn mang các thông tin này. Cần đo blob còn tải được bao lâu sau thu hồi; ưu tiên gọi bộ giải mã của Facebook thay vì tự viết lại.

### 2.3 Tăng độ phủ

- [ ] Tùy chọn giữ một tab Messenger không bị giải phóng (`autoDiscardable: false`). Không có tab mở thì không bắt được gì.
- [ ] Hook `Notification` và chữ xem trước ở danh sách chat. [Giả thuyết] Không có ID nên **chỉ đưa vào trang bản lưu với nhãn độ tin cậy thấp, không chèn vào bong bóng**.
- [ ] Xử lý rủi ro hàng bị thay trước khi đọc do trễ 120 ms ([src/adapter.js:152](src/adapter.js#L152)). Có thể tự hết nếu adapter mới đạt. [Giả thuyết]

### 2.4 Tin tự xóa và xem một lần

- [ ] Nhận diện tin tự xóa bằng trường model, không suy luận từ việc phần tử biến mất khi cuộn.
- [ ] Lưu và hiển thị trong trang bản lưu với trạng thái "đã tự xóa". Tùy chọn **mặc định tắt**.
- [ ] Xác minh hàng chat biến mất hẳn hay có tombstone. Cần tài khoản thử nghiệm thứ hai. [Giả thuyết]
- **Xem một lần:** quyết định hiện tại là **không làm kiểu "mở khóa" và không tự mở**. Nếu làm, chỉ lưu khi chính người dùng mở, mặc định tắt.

### 2.5 Ma trận kiểm thử cho nguồn mới

Dùng lại bảng trong [docs/message-recovery-research.md](docs/message-recovery-research.md), gồm: đã thấy rồi thu hồi; chưa mở chat; ngoài vùng render; thu hồi rất nhanh; offline; ảnh, album, voice chưa phát; reload; kho đầy; chuyển tài khoản. Bổ sung: tin bị sửa rồi thu hồi; tin tự xóa hết giờ.

### 2.6 Đã xem xét và không làm

- `TextDecoder.decode`: phải đoán bằng stack, tạo ID ngẫu nhiên, tốn hiệu năng.
- Ghép tin theo timestamp hoặc chữ xung quanh: trái quy tắc không đoán của dự án.
- Chỉ đổi cờ `isUnsent`: lệnh thu hồi E2EE không chứa nội dung (whitepaper trang 16).
- Chặn lệnh xóa của Facebook: làm store và giao diện lệch nhau.
- Khôi phục từ "Tải thông tin của bạn" hoặc Labyrinth: chưa có bằng chứng giữ tin đã thu hồi.
- Thiết bị phụ chạy 24/7 kiểu mautrix: để sau; phải giữ phiên đăng nhập, có rủi ro khóa tài khoản.

### 2.7 Pháp lý

- [ ] Trước khi phát hành công khai, đối chiếu Luật 91/2025/QH15 và Nghị định 330/2026/NĐ-CP. Giữ dữ liệu cục bộ, không đồng bộ.

---

## 3. Tối ưu RAM, CPU, ổ đĩa

Kho lớn chủ yếu tốn ổ đĩa. Chi phí trên tab Facebook đến từ việc theo dõi DOM, không phụ thuộc kích thước kho.

### 3.1 Đo trước khi sửa

- [x] **Viết bài đo trên fixture, profile riêng dưới `test-results/`, nhãn synthetic.** So sánh bật/tắt extension:
  - Kết quả: **[Xong]** `tests/perf-browser.mjs`; số liệu trong `test-results/perf/` và TEST_RESULTS. Giới hạn: trang giả lập, một máy, không có số riêng cho từng tối ưu nhỏ (`innerText`, thu hẹp observer).
  - CPU và long task khi cuộn chat dài, khi bảng tin đổi liên tục.
  - RAM tab và service worker khi rảnh, khi lưu media lớn.
  - Thời gian `maintain` với kho 20.000 tin.
- Xong khi: có số liệu nền lưu lại, và mỗi mục tối ưu bên dưới có số liệu trước/sau.

### 3.2 CPU trên tab Facebook

- [x] **Bỏ qua hàng đã xử lý trước khi phân tích.** `describeRow` chạy trước khi so fingerprint ([src/adapter.js:163](src/adapter.js#L163), [src/adapter.js:181](src/adapter.js#L181)). Chỉ phân tích lại hàng có thay đổi thật. [Code]
  - Kết quả: **[Xong]** CPU khi cuộn chat 600 tin: 0.2.0 682–943 ms → 0.3.0 83–262 ms (không extension: 43–65 ms; số dao động vì máy bận). Danh sách thêm/bớt hàng khi cuộn: 647–775 → 305–341 ms. Hàng không đổi chỉ được đọc lại khi DOM, thuộc tính định danh hoặc props React của nó đổi.
- [x] **Giảm quét khi cuộn.** Hiện quét mỗi sự kiện scroll ([src/adapter.js:145-148](src/adapter.js#L145-L148)). Chỉ quét sau khoảng nghỉ ngắn hoặc dùng `requestIdleCallback`. [Code]
  - Kết quả: **[Xong]** quét sau 120 ms yên, tối đa 400 ms.
- [x] **Thu hẹp `MutationObserver`.** Đang theo dõi toàn trang ([src/adapter.js:273](src/adapter.js#L273), [src/content.js:146](src/content.js#L146)). Chỉ theo dõi vùng chat khi tìm được, và xem xét gộp hai observer. Chú ý không làm sót popup chat. [Code]
  - Kết quả: **[Xong]** cấu trúc vẫn theo dõi toàn trang (để không sót popup), chữ/ảnh chỉ trong vùng chat (tối đa 64 vùng rồi quay về toàn trang); phía isolated chỉ theo dõi hàng đang có bản lưu. Không gộp được hai observer vì chúng ở hai "world" khác nhau. Bảng tin thay đổi liên tục: 326–397 → 258–277 ms, giảm ít; phần còn lại là theo dõi cấu trúc toàn trang, cố ý giữ để không sót popup.
- [x] **Tránh `innerText`** vì buộc trình duyệt tính lại bố cục ([src/adapter.js:116](src/adapter.js#L116)); dùng `textContent` nếu không làm sai kết quả. [Code]
  - Kết quả: **[Xong]**

### 3.3 Mạng và RAM cho media

- [x] **Không tải lại ảnh đã có trong kho.** `capturePolicy` chỉ bỏ qua voice ([src/archive.js:265](src/archive.js#L265)), nên ảnh bị tải lại và băm SHA-256 mỗi khi hàng được dựng mới. [Code]
  - Kết quả: **[Xong]** sau 2 lần reload: 48 lần tải → 0.
- [x] **Giảm đỉnh RAM do base64.** Tệp 8 MiB thành chuỗi khoảng 11 MiB và bị sao chép qua MAIN, isolated, background ([src/main.js:40](src/main.js#L40)). Chia nhỏ theo chunk hoặc đánh giá kênh truyền nhị phân qua trang extension. [Code]
  - Kết quả: **[Xong]** Blob đi qua các world, gửi worker theo phần 1 MiB. Đỉnh bộ nhớ trên mức ban đầu (gồm cả vùng ArrayBuffer) khi lưu 4 ảnh 7,5 MiB: worker 222–224 → 26–27 MiB; tab 152–203 → 126 MiB (trong đó 30 MiB là ảnh do chính trang giả lập tạo).

### 3.4 Kho và ổ đĩa

- [x] **Chỉ ghi lại bản ghi khi có thay đổi.** `maintain` gọi `c.update(row)` cho mọi bản ghi mỗi 30 phút ([src/archive.js:208-221](src/archive.js#L208-L221)). [Code]
  - Kết quả: **[Xong]** lượt dọn không đổi gì thì không ghi bản ghi nào: ~21.000 tin, 12,0–15,4 s → 0,9–1,2 s.
- [x] **Chia việc dọn kho thành nhiều transaction nhỏ** để không chặn hàng đợi `exclusive` ([src/background.js:18-22](src/background.js#L18-L22)) quá lâu. [Code]
  - Kết quả: **[Xong]** từng phần 256 tin; khi đổi hạn lưu của 21.000 tin, tin mới phải chờ 11,1 s → 0,18 s. Tổng thời gian dọn dài hơn một chút (11,2 → 13,1 s).
- [x] Hiển thị dung lượng thật qua `navigator.storage.estimate()` bên cạnh số logic.
  - Kết quả: **[Xong]** trên trang Lưu trữ (cạnh giới hạn) và trang Sao lưu & khóa.
- [x] Giới hạn dung lượng riêng cho video và tệp khi mục media mở rộng được làm.
  - Kết quả: **[Xong]** video 1–64 MiB (mặc định 32), tệp 8 MiB, có thời gian lưu riêng.

---

## Nguồn

- [Meta: Messenger End-to-End Encryption Overview](https://engineering.fb.com/wp-content/uploads/2023/12/MessengerEnd-to-EndEncryptionOverview_12-6-2023.pdf)
- [mautrix/meta: messages.go](https://github.com/mautrix/meta/blob/main/pkg/messagix/table/messages.go)
- [whatsmeow: WAArmadilloApplication.proto](https://github.com/tulir/whatsmeow/blob/main/proto/waArmadilloApplication/WAArmadilloApplication.proto)
- [binhake/fb-unsend-viewer](https://github.com/binhake/fb-unsend-viewer) (giấy phép phi thương mại)
- [Chatpane issue #370](https://github.com/kristofferR/Chatpane/issues/370)
