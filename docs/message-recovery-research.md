# Nghiên cứu cải thiện phục hồi tin thu hồi trên Messenger

Ngày đối chiếu: 03/11/2026. Bản extension được đọc: 0.2.0, commit `e1873b2`.

## Kết luận

Có cơ sở để cải thiện đáng kể **thời điểm và phạm vi thu nhận dữ liệu**, nhưng chưa có bằng chứng rằng Messenger hiện tại luôn gửi lại nội dung gốc cùng cờ thu hồi. Không nên thay kho độc lập bằng một thao tác bỏ `isUnsent`.

Nếu dữ liệu gốc còn trong model/cache cục bộ, có thể hiển thị lại hoặc sao lưu nó. Nếu thiết bị chỉ nhận lệnh thu hồi/tombstone và không còn bản gốc có thể đọc được, đổi cờ không tạo lại được nội dung. Phải phân biệt tin đã đến thiết bị với tin đã được dựng thành hàng chat trên màn hình.

Đây là nghiên cứu tài liệu và mã nguồn, **không phải kết quả thử nghiệm mới trên Facebook production**. Không truy cập profile hay tài khoản Facebook chính. Giả thuyết về cách Zalo hoạt động do người dùng nêu chưa được kiểm chứng trong nghiên cứu này.

## Bằng chứng

1. **Tài liệu chính thức Meta, Messenger End-to-End Encryption Overview**, trang 16, mục Sender Side Backfill: `remove for me` và `unsend` là control message; bản thân các control message này không chứa nội dung tin nhắn. Điều này bác bỏ giả định rằng *chính lệnh thu hồi E2EE* luôn mang lại đầy đủ nội dung gốc. Nó không chứng minh mọi cache/bản sao cục bộ đã mất.
   - https://engineering.fb.com/wp-content/uploads/2023/12/MessengerEnd-to-EndEncryptionOverview_12-6-2023.pdf

2. **Mã nguồn bridge mautrix/meta**, commit `62098b768bb36463f39e717bbd0768b54fa0306b` ngày 02/11/2026 UTC: định nghĩa bản ghi có `Text`, `IsUnsent`, `UnsentTimestampMs`; handler `handleDeleteThenInsertMessage` xử lý bản ghi `IsUnsent` như sự kiện xóa theo ID. Sự tồn tại đồng thời các trường này không chứng minh `Text` vẫn chứa nguyên văn sau thu hồi. Đây là implementation reverse engineering của bên thứ ba, không phải hợp đồng API của Meta hoặc bằng chứng về mọi đường E2EE trên trình duyệt.
   - https://github.com/mautrix/meta/blob/62098b768bb36463f39e717bbd0768b54fa0306b/pkg/messagix/table/messages.go
   - https://github.com/mautrix/meta/blob/62098b768bb36463f39e717bbd0768b54fa0306b/pkg/connector/handlemeta.go

3. **Mẫu handler Facebook do TextsHQ lưu lại**, commit `ae9c68e380becd06b58081c9e39abf353bc36fc7` của repo có lần push cuối năm 2024: `LSDeleteThenInsertMessage` ghi lại `text` từ đối số mới cùng `isUnsent`; `LSDeleteMessage` có thao tác xóa bản ghi. Mẫu lịch sử cho thấy thay đổi có thể tác động dữ liệu, không chỉ giao diện. Không được coi các tên module, chỉ số bảng hoặc đối số này là ổn định cho Facebook năm 2026.
   - https://github.com/TextsHQ/platform-meta/blob/ae9c68e380becd06b58081c9e39abf353bc36fc7/docs/handlers/LSDeleteThenInsertMessage.js
   - https://github.com/TextsHQ/platform-meta/blob/ae9c68e380becd06b58081c9e39abf353bc36fc7/docs/handlers/LSDeleteMessage.js

4. **Meta về E2EE và Labyrinth**: nội dung được giải mã trên thiết bị; lịch sử mã hóa có thể được tải theo nhu cầu. Labyrinth 1.1 công bố tháng 05/2026 cải thiện sao lưu khi thiết bị vắng mặt. Các tài liệu này không công bố một API phục hồi nội dung đã thu hồi, cũng không cam kết mọi tombstone còn dữ liệu gốc.
   - https://engineering.fb.com/2023/12/06/security/building-end-to-end-security-for-messenger/
   - https://engineering.fb.com/2026/05/11/security/labyrinth-1-1-end-to-end-encrypted-e2ee-backups-more-reliable/
   - https://engineering.fb.com/wp-content/uploads/2026/05/Minos-Updates-2026-Encrypted-Backups-White-Paper.pdf

5. **Media**, tài liệu E2EE phía trên, trang 17: ảnh/audio được mã hóa riêng; tin nhắn mang khóa và con trỏ tới blob. Vì vậy URL/flag/metadata không tương đương một tệp phục hồi được. Chỉ có khóa cũng không bảo đảm blob còn tải được. Giữ binary đã giải mã trong kho riêng vẫn là phương án chắc chắn hơn cho tệp đã nhận.

## Điểm yếu trong bản 0.2.0

- `src/adapter.js` bắt đầu từ DOM: `ROW_SELECTOR`, `MutationObserver`, rồi mới đọc các props React liên quan hàng đó. Đọc React ở đây vẫn phụ thuộc hàng chat đã được dựng.
- `process()` hẹn xử lý sau 120 ms. Có khả năng một hàng xuất hiện rồi bị thay/xóa trước khi được đọc. Đây là rủi ro suy ra từ mã, chưa phải một lỗi mới đã tái hiện.
- `describeRow()` nhận diện `isUnsent`/`is_unsent`/`isUnsentMessage`, nhưng khi `removed` thì observation không mang `text` gốc và không thu thập media. Nếu model thực tế còn một payload gốc đáng tin cậy khi cờ đã bật, đường hiện tại có thể bỏ qua cơ hội lấy lại nó. Cần phân biệt payload gốc với chữ tombstone, trích dẫn và nội dung extension vừa phục hồi.
- Việc ghép hàng sau thu hồi phải xử lý ID đổi và DOM tái sử dụng. Sự kiện dữ liệu có ID gốc có thể giảm phụ thuộc bước ghép này, nếu đường đó truy cập được.
- `src/archive.js` đã có kho riêng, phân tách tài khoản, giới hạn, dọn dẹp và aliases. Đây là phần nên tái sử dụng cho nguồn thu nhận mới.

## So sánh hướng làm

| Phương án | Lợi ích kỳ vọng | Giới hạn |
|---|---|---|
| Chỉ đổi `isUnsent` | Nhẹ, có thể hiện lại khi model còn đủ dữ liệu | Không tái tạo chữ/binary bị xóa; không bảo đảm sau reload |
| Sao lưu payload còn lại trong model/cache khi gặp tombstone | Có thể cứu một số tin nguồn DOM bỏ lỡ | Phụ thuộc dữ liệu thực còn tồn tại và xác minh đúng ID/tài khoản |
| Nhận sự kiện dữ liệu sau giải mã, trước render | Có thể thu tin chưa dựng và ID gốc; giảm phụ thuộc DOM | Phải tìm đúng đường E2EE hiện hành; module/worker có thể khác giữa tài khoản |
| Sao lưu trước thao tác ghi đè/xóa store | Có thể giữ dữ liệu ngay trước khi mất khỏi cache | Phụ thuộc schema; hook IndexedDB chung dễ bỏ sót worker và tạo overhead |
| Đọc thẳng WebSocket/fetch | Hữu ích cho một số đường không E2EE | Với E2EE có thể chỉ thấy ciphertext; không đủ nếu thiếu bước giải mã |

Các lợi ích trên là đánh giá kỹ thuật, chưa có tỷ lệ thành công đo trên Facebook thật.

## Kiến trúc đề xuất

Ưu tiên một adapter dữ liệu **chỉ quan sát**, dùng payload sau khi Messenger đã giải mã và chuẩn hóa. Lưu theo khóa tài khoản + ID tin vào cùng kho bounded hiện tại, chỉ cập nhật bản ghi khi nội dung thay đổi. Các nguồn nhập liệu cùng dùng hàng đợi có giới hạn và cơ chế xác nhận commit; không tạo thêm một lịch sử hoặc cache RAM vô hạn.

Khi nhận thu hồi, đánh dấu bản lưu theo ID gốc và hiển thị qua lớp hiện tại. Giữ adapter DOM/React làm dự phòng và nơi gắn UI. Media tiếp tục lưu binary thực khi tải được; việc preload phải dùng cùng ngân sách/giới hạn. Có thể thêm đường cứu payload còn lại trong cache, nhưng chỉ nhận nội dung được xác minh, không đoán từ vị trí, tên hoặc chữ trùng nhau.

Ưu tiên sao lưu trước mutation thay vì chặn mutation của Facebook: chặn xóa/ghi đè có thể làm store và UI lệch đồng bộ, ảnh hưởng các bản tin khác trong cùng transaction và không tồn tại qua tải lại từ máy chủ. Không sửa database Facebook hoặc bỏ qua hàng loạt gói điều khiển để làm bản triển khai chính.

Điểm hook cần được tìm bằng thử nghiệm riêng; chưa xác nhận được module hoặc store cụ thể hoạt động cho E2EE web hiện hành. Một wrapper trên `WebSocket`, `crypto.subtle` hoặc `IDBObjectStore.put` không tự bảo đảm quan sát được mọi đường giải mã, đặc biệt khi có worker/WASM.

## Thử nghiệm cần có để chọn phương án

Chỉ dùng profile và tài khoản thử nghiệm riêng theo `AGENTS.md`. Không dùng việc tăng bộ đếm quan sát làm tiêu chí thành công.

| Trường hợp | Điều cần đối chiếu |
|---|---|
| Tin đã thấy rồi thu hồi | Payload/data store còn gì trước/sau; flip flag có đủ không |
| Tin đến khi chưa mở đoạn chat | Có sự kiện plaintext/ID trước render không; kho có commit không |
| Tin đến ngoài vùng render | So sánh nguồn dữ liệu với adapter DOM |
| Thu hồi rất nhanh, hoặc nhiều tin lẻ/trùng nội dung | Không mất event trước commit; đúng ID và đúng nội dung |
| Thiết bị offline khi gửi và thu hồi | Khi online nhận payload gốc, control message hay chỉ tombstone; không giả định trước |
| Ảnh, album, voice chưa phát | Metadata khác binary; hash và giải mã/phát được sau thu hồi |
| Reload và khởi động lại trình duyệt | Khôi phục từ bản lưu độc lập; cùng tài khoản/ID |
| Kho đầy, tin được bảo vệ, chuyển tài khoản | Không vượt giới hạn, không mất bản bảo vệ, không trộn dữ liệu |

Thí nghiệm flip flag chỉ có giá trị khi thực hiện trên bản sao model hoặc môi trường QA, đồng thời ghi nhận nội dung trước/sau; không lấy kết quả một lần của một tài khoản làm kết luận cho mọi Messenger.

Tiêu chí đi tiếp với adapter mới: bắt được tin trước render trên Facebook thử nghiệm thật; ID ổn định qua thu hồi; commit bền vững; media đọc lại được; không làm thay đổi luồng Messenger; đo số tin bỏ sót, độ trễ commit, RAM/CPU và dung lượng so với 0.2.0. Chưa thể hứa phục hồi tin chưa từng có bản gốc đến thiết bị, cache hay kho được phép truy cập.
