# PitoFacebookFixer

Extension Manifest V3 cho Chrome/Edge trên máy tính. Bản thử nghiệm 0.2.0.

## Bản 0.2.0: English / Tiếng Việt và logo Pito

- **English mặc định** cho cài đặt mới và cài đặt cũ chưa có trường ngôn ngữ. Nút **EN/VI** nằm cạnh nút giao diện hệ thống/sáng/tối ở cả trang cài đặt và popup; lựa chọn được lưu và đồng bộ giữa các cửa sổ.
- Dịch các trang, hộp xác nhận, thông báo lưu/lỗi, chẩn đoán, bộ đếm, ngày giờ và nhãn hỗ trợ đọc màn hình. Nội dung tin nhắn do người dùng gửi không được dịch. Đổi ngôn ngữ không ghi đè bản nháp giới hạn hoặc thay bộ phát voice đang chạy.
- Logo mới tham khảo nhận diện PitoNote do người dùng cung cấp: nền kem bo góc, bong bóng chat vàng và chữ P màu graphite. SVG gốc và PNG 16–512 px được dùng cho toolbar, danh sách extension, favicon, popup và cài đặt.
- Tài nguyên ngôn ngữ và logo đều bundle cục bộ. Không thêm quyền, không thay schema kho. Story vẫn mang nhãn **In development / Đang phát triển** và bị vô hiệu hóa.
- Nguồn logo: `extension/icons/logo.svg`. Bộ tệp tải riêng: `release/brand/`; hướng dẫn: `docs/brand-guidelines.md`.

## Bản sửa 0.1.9: popup trên thanh công cụ bị co hẹp

- Loại bỏ `max-width:100vw` gây vòng phụ thuộc khi Chrome tự tính kích thước popup. Đặt chiều rộng và chiều rộng tối thiểu 400 px ở phần tử HTML gốc; body theo chiều rộng đó. Chiều cao tối thiểu 584 px tránh cuộn thừa do làm tròn ở các mức scale.
- Đã tái hiện lỗi bằng **popup thật qua Chrome Action**: bản cũ chỉ rộng 174 px, cột chữ khoảng 9,7 px. Bản sửa rộng 400 px, cột chữ ít nhất 250 px, trạng thái bình thường không cần cuộn.
- Thêm `npm run test:popup`: mở/đóng popup thật, không ép viewport như tab thông thường; kiểm tra sáng/tối và lưu công tắc sau khi đóng. Đã thử 12 lượt qua Chromium 141/156 và các mức scale 100/125/150%.
- Không thay đổi logic kho hoặc cơ chế lưu cài đặt. Cập nhật vào cùng thư mục đang dùng và Reload extension; không gỡ extension.

## Bản sửa 0.1.8: cài đặt bền vững và giao diện mới

- **Công tắc tự lưu ngay**. Không còn phải bấm Lưu sau khi bật/tắt trong popup. Đã tái hiện lỗi cũ bằng bài thử đóng popup ngay sau khi đổi, rồi xác nhận bản sửa giữ đúng giá trị.
- Cấu hình nằm trong `chrome.storage.local`. Background lưu từng patch tuần tự, hợp nhất với trạng thái mới nhất, không ghi đè các trường khác bằng bản cấu hình cũ từ cửa sổ khác. Khởi tạo/nâng cấp dùng cùng hàng đợi; revision ngăn phản hồi cũ thay thế cấu hình mới.
- Facebook chờ đọc xong cấu hình đã lưu mới bật tính năng. Có thử lại khi không lấy được cấu hình, không tự bật mặc định trong lúc chờ. Popup/options/tab đang mở được đồng bộ; đổi giao diện hoặc giữ ô nhập không vẽ lại các bản tin/phát lại voice.
- **Ngân sách, số tin và số ngày** có nút **Áp dụng giới hạn** riêng. Thay đổi chưa áp dụng được ghi rõ, vì hạ giới hạn có thể gây dọn dữ liệu.
- Dựng lại hoàn toàn popup và trang cài đặt: Tổng quan, Lưu trữ, Bản lưu, Chẩn đoán; giao diện hệ thống/sáng/tối, công tắc thật, xác nhận dọn tệp, điều hướng bàn phím và bố cục màn hình nhỏ. Mã tài khoản/hội thoại nằm trong phần mở rộng của bản lưu.
- **Chặn đã xem story: Đang phát triển**. Công tắc bị vô hiệu hóa; cấu hình cũ `blockStory=true` cũng không bật chặn. Fetch/XHR của trang được giữ nguyên native. Facebook vẫn ghi nhận xem story bình thường.
- Nghiên cứu trước khi dựng giao diện: cách chia mục của Linear, workflow extension của Bitwarden, switch của Fluent 2, Chrome Storage/Popup và WAI. Chi tiết nguồn và quyết định nằm trong [UI_RESEARCH.md](UI_RESEARCH.md). Icon Lucide được bundle cục bộ, kèm giấy phép; không tải font/icon/script từ CDN khi chạy.

Sau khi cập nhật vào **cùng thư mục extension đang dùng**, bấm Reload extension, rồi tải lại Facebook. Không gỡ/cài lại hoặc nạp sang thư mục khác nếu muốn giữ nguyên kho và cấu hình. Xem kết quả kiểm thử thật/giả lập tách biệt trong [TEST_RESULTS.md](TEST_RESULTS.md).

## Bản sửa 0.1.7: quản lý kho, voice chưa nghe và album ảnh

- Nhập ngân sách riêng từ **2–8192 MiB**, số tin tối đa và thời gian lưu **0–3650 ngày**. 0 ngày tắt dọn theo tuổi; giới hạn dung lượng/số tin vẫn áp dụng. Không xin quyền `unlimitedStorage`; dung lượng thực tế còn phụ thuộc quota của trình duyệt.
- Tắt **Cho phép tự dọn tin đã thu hồi** để bảo vệ toàn bộ các bản ghi này, gồm ảnh và voice. Nếu phần được bảo vệ không còn chỗ cho tin mới, kho **giữ nguyên tin được bảo vệ, dừng lưu mới và báo đầy**. Hạ ngân sách thấp hơn phần được bảo vệ cũng không xóa phần đó. Tăng ngân sách/lưu lại cấu hình hoặc chủ động dọn kho để thử tiếp tục. Mặc định giữ chính sách cũ: cho phép tự dọn cả tin thu hồi; bạn có thể tắt công tắc này.
- Tuổi ảnh và voice có thể đặt riêng. **Dọn riêng ảnh / Dọn riêng voice** có bộ lọc số ngày và xác nhận; mặc định bỏ qua tệp trong tin đã thu hồi. Muốn xóa cả tệp được bảo vệ phải chọn rõ trong bảng xác nhận. Giữ chữ và loại tệp còn lại; tệp đã dọn không tự được tải lại cho cùng mã tin.
- **Tự tải voice để lưu**: với voice đang hiển thị, extension gọi bộ tải của Facebook, lấy binary sau khi Facebook giải mã và chặn việc bắt đầu phát âm thanh. Kiểm tra kho trước khi tải, bỏ qua voice đã lưu/đã dọn hoặc kho đã đầy. Hàng chờ tối đa 16, một tác vụ tại một thời điểm, tối đa hai lần thử cho một hàng. Không ghi microphone. Có công tắc tắt và bộ đếm thành công/thất bại. Đây vẫn phụ thuộc giao diện/bộ tải của Facebook; waveform không chứng minh đã có binary, và voice thu hồi trước khi lưu xong vẫn có thể mất.
- Album phục hồi hiển thị **một ảnh trong một bong bóng Facebook**, có nút ảnh trước/sau và số thứ tự bên dưới. Đọc một ảnh đang chọn vào RAM, hủy URL cũ khi chuyển; không tải đồng thời cả album. Lưu tối đa **20 tệp/tin**, vẫn giới hạn **8 MiB/tệp, 16 MiB/tin**; album lớn có thể chỉ lưu được một phần. Giữ thứ tự và ghép các ảnh tải về ở những lần quan sát khác nhau.
- Không đổi schema 4, không xóa kho cũ và không thêm quyền extension. Chỉ chặn xem story; request đánh dấu đọc tin nhắn vẫn đi qua.

Đã thử voice không bấm nghe và album hai ảnh bằng tài khoản phụ, self chat riêng: binary được commit trước thu hồi, ảnh giải mã/voice phát được từ bản lưu. Kết quả tự động và phạm vi kiểm chứng thật nằm trong [TEST_RESULTS.md](TEST_RESULTS.md).

## Bản sửa 0.1.6: emoji, ảnh và tin nhắn thoại

- Đọc nội dung Unicode từ `alt` của ảnh emoji, gồm emoji đơn, ghép gia đình, cờ, màu da và keycap. Hiển thị lại emoji trong bong bóng thu hồi, cỡ lớn hơn chữ thường.
- Lưu **dữ liệu ảnh** mà trình duyệt đã tải, không chỉ URL. Ảnh trong chat có thể là bản xem trước; không cam kết ảnh gốc/HD nếu Facebook chưa cung cấp bản đó trên trang.
- Lưu **voice** từ bộ phát Messenger khi người dùng tải/phát trên web. Với E2EE, âm thanh thường là Blob được tạo ngoài DOM: nhận đúng bộ phát của hàng vừa được người dùng chọn, đọc dữ liệu và ghi vào kho. Voice chưa tải/phát trên web trước khi thu hồi có thể chưa có dữ liệu để lưu.
- Không lưu video, ảnh thumbnail video, sticker, avatar hoặc tệp đính kèm khác. Không ghi nhầm nhãn Sent/thời lượng phát thành tin nhắn.
- Binary ảnh/voice nằm trong cùng bản ghi IndexedDB dưới dạng Blob; giữ cùng ngân sách 32 MiB / 20.000 tin / 30 ngày mặc định. Tối đa **8 MiB/tệp**, **4 tệp/tin**, **16 MiB/tin**. Xóa/hết hạn bản ghi cũng xóa binary liên quan; tệp quá giới hạn bị bỏ qua.
- Khi thu hồi, ảnh và bộ phát voice nằm trong bong bóng gốc của Facebook. Dữ liệu được đọc từ kho theo chunk 192 KiB, không phụ thuộc URL cũ. Giữ nguyên bộ phát đang chạy khi đổi alias; URL blob để hiển thị được thu hồi khi hàng bị tháo/tắt tính năng/xóa kho; giới hạn cache hiển thị 32 MiB và 2 lượt đọc cùng lúc.
- Thêm quyền host giới hạn cho `*.fbcdn.net` và `*.fbsbx.com` để tải media qua background. Không thêm quyền cookies, debugger, webRequest hay microphone; không chạy content script trên các CDN này.

Đã kiểm chứng gửi → lưu → thu hồi → hiển thị trên Facebook thật bằng tài khoản phụ cho emoji, ảnh và voice; ảnh giải mã được, voice phát được, SHA-256 khớp với dữ liệu trong kho cả sau reload. Xem [TEST_RESULTS.md](TEST_RESULTS.md).

## Bản sửa 0.1.5: nối đúng các bản ghi gỡ/chèn riêng

- Log từ lượt thu hồi trên Messenger điện thoại cho thấy Facebook phát `removeChild` và `insertBefore` thành hai MutationRecord riêng, có thể xen kẽ thay đổi heading/trạng thái của tin bên cạnh. Bài tổng hợp của 0.1.4 dùng một lần `replaceWith` nên chưa bao phủ trường hợp này.
- Ghép theo cùng phần tử cha và đúng hai đối tượng sibling trước/sau trong MutationRecord, chỉ khi có duy nhất một hàng cũ và một hàng mới trong liên kết đó. Vẫn kiểm tra tài khoản, metadata và thay đổi vùng cuộn; không ghép bằng số thứ tự hàng hoặc đoán từ nội dung trùng nhau.
- Thêm chẩn đoán trên bảng trạng thái: **Bản lưu đang hiển thị**, **Có bản lưu, chờ bong bóng**, **Chưa có bản lưu khớp mã tin**. Mục cuối có thể do chưa ghi được tin hoặc không nối được mã mới; không đồng nghĩa chắc chắn tin chưa từng được quan sát.
- Giữ cách thay chữ trực tiếp trong bong bóng Facebook, giới hạn bộ nhớ và schema 4. Chặn đã xem tin nhắn tiếp tục được gỡ, chỉ giữ story.

Bài hồi quy theo dạng gỡ/chèn riêng thất bại trên 0.1.4 và đạt sau sửa. Đã thử điện thoại thật bằng tài khoản phụ: người dùng thu hồi chung 12 tin trong Messenger, web phục hồi đủ 12/12 trước reload và 12/12 sau reload; từng mã native khớp đúng ID/aliases trong kho. Kết quả chi tiết nằm trong [TEST_RESULTS.md](TEST_RESULTS.md).

## Bản sửa 0.1.4: thu hồi nhiều tin và chỉ chặn xem story

- Ghép riêng từng cặp hàng bị Facebook thay thế trong cùng một lượt cập nhật DOM, kể cả nhiều tin có cùng nội dung/thời gian. Không gộp mọi lần thay thế dưới cùng phần tử cha thành một cặp duy nhất.
- Bridge chỉ gửi batch tiếp theo sau khi background xử lý batch trước. Khi hàng chờ đầy, bộ nhận diện giữ việc cần làm và quét tiếp bằng con trỏ DOM; không bỏ tin cũ để lấy chỗ cho tin mới. RAM vẫn có giới hạn.
- Giữ phản hồi bản lưu nếu nó đến trước lúc Facebook dựng xong chữ thu hồi; chèn khi bong bóng sẵn sàng. Các lượt dựng lại nhiều bong bóng được xử lý nối tiếp từng nhóm.
- Đã bỏ tính năng chặn đã xem **tin nhắn**, gồm công tắc, cấu hình cũ, bộ lọc MQTT/WebSocket và nhận diện request đánh dấu đọc. WebSocket không còn bị extension bọc lại. Chỉ giữ chặn đã xem **story**.
- Không thay schema kho, không xóa bản lưu, không thêm quyền.

Bài hồi quy mới: ghi đủ 384 tin với background phản hồi chậm, thu hồi đồng thời 192 tin không liền nhau, kiểm tra đúng nội dung trước/sau reload và tình huống chữ thu hồi xuất hiện trễ. Các bài này dùng dữ liệu tổng hợp, tách biệt với 3 chu kỳ self chat trên Facebook thật. Xem [TEST_RESULTS.md](TEST_RESULTS.md).

## Bản sửa 0.1.3: dùng bong bóng thu hồi của Facebook

- Thay nội dung thông báo thu hồi bằng văn bản đã lưu ngay trong bong bóng gốc. Không tạo thẻ, shadow root, viền màu, badge hoặc khối thông tin riêng.
- Giữ nguyên phần tử, text node, class, style, viền, màu và chữ nghiêng của Facebook. Không sửa nút thao tác, tên người gửi hoặc trạng thái gửi.
- Rê chuột lên nội dung để xem tooltip “Đã thu hồi · Bản lưu từ PitoFacebookFixer”. Có mô tả hỗ trợ trình đọc màn hình; không thêm dòng nhãn trong chat.
- Khi Facebook viết lại nội dung, áp dụng lại bản lưu đúng mã tin. Khi tắt tính năng hoặc xóa kho, trả lại thông báo thu hồi gốc; không ghi đè thay đổi mới của Facebook.
- Bộ nhận diện không coi phần chữ extension vừa phục hồi là một tin nhắn mới để ghi vào kho.

Đã kiểm chứng lại 3 chu kỳ trên Facebook thật bằng tài khoản thử nghiệm riêng và kiểm tra sau reload. Xem [TEST_RESULTS.md](TEST_RESULTS.md).

## Bản sửa 0.1.2: ghi dữ liệu và khóa tin E2EE

- Kiểm tra `MessageSender` theo extension ID và URL/origin xác thực do trình duyệt cung cấp; không bắt buộc trường `frameId` tùy chọn phải bằng 0. Vẫn từ chối nguồn ngoài danh sách và không cho content script gọi API quản trị kho. Lỗi nguồn có mã chẩn đoán thay vì chỉ báo “Trang không được hỗ trợ”.
- Tách đúng nội dung khi Facebook đặt nhãn “Sent”, “Delivered” hoặc trạng thái khác trong cùng hàng. Đối chiếu lá nội dung với nhãn truy cập của hàng, bỏ heading tên người gửi; không chọn nội dung theo vị trí hàng.
- Chuẩn hóa ID số tạm của Messenger và dạng ID được thêm tiền tố sau khi máy chủ xác nhận, tránh ghi trùng cùng một tin.
- Theo dõi thay đổi mã khi một hàng tin đã quan sát chuyển sang thu hồi. Chỉ ánh xạ khi còn đúng phần tử/article đang theo dõi, hoặc một cặp hàng bị thay thế duy nhất dưới cùng phần tử cha trong cùng lượt cập nhật DOM; tài khoản và metadata thời gian/người gửi phải khớp, không có chuyển vùng cuộn chưa được quét lại.
- Ánh xạ mã tombstone nằm cùng bản ghi, tối đa 4 mã phụ mỗi tin; index phục vụ đọc lại sau khi reload. Xóa/hết hạn bản tin cũng xóa ánh xạ, không có kho ánh xạ tăng vô hạn riêng. Nếu không có mối liên hệ đủ rõ, bỏ qua thay vì đoán theo tên hoặc nội dung.
- Chèn lại hộp bản lưu nếu Facebook dựng lại nội dung hàng và xóa hộp extension. Kiểm tra lại mã tin, tài khoản, dấu thu hồi và trạng thái tính năng trước khi chèn.
- Schema IndexedDB hiện là 4, nâng cấp giữ dữ liệu cũ. Không bổ sung quyền extension.

Đã kiểm chứng 3 chu kỳ gửi → ghi IndexedDB → thu hồi → hiển thị bản lưu có nhãn trên Facebook thật trong self chat của tài khoản thử nghiệm riêng, và hiển thị lại sau reload. Đây chưa phải kiểm chứng tin nhận từ tài khoản khác hoặc trạng thái đã xem. Kết quả chi tiết: [TEST_RESULTS.md](TEST_RESULTS.md).

Xem [QA.md](QA.md) và chạy `npm run verify` để kiểm tra hồi quy, 5 vòng browser test, giới hạn kho và đóng/mở trình duyệt. Kết quả fixture và Facebook thật được báo cáo riêng. Tuyệt đối không dùng Facebook chính của người dùng làm môi trường kiểm thử.

## Bản sửa 0.1.1: popup Facebook không ghi được tin

Đã đối chiếu DOM trên Facebook thật: popup dùng `role="log"`, các hàng có `data-message-id` và `data-scope="messages_table"`; tên người gửi nằm trong heading có `dir="auto"`. Bản 0.1.0 đòi hỏi mã hội thoại theo cấu trúc chưa khớp popup và tính heading vào các ứng viên nội dung, khiến tin bị bỏ qua. Các kiểm thử ban đầu chỉ dùng fixture đơn giản nên chưa bắt được trường hợp này.

0.1.1 bổ sung:

- Nhận vùng `role="log"`, bỏ tên người gửi/heading khi lấy nội dung.
- Lấy hội thoại từ tiền tố ID của tin E2EE; nếu tin có ID Facebook toàn cục nhưng không có thread ID, vẫn ghi theo ID thật, không đoán theo tên chat/vị trí. Index theo tài khoản + mã tin giúp nối bản lưu giữa popup và trang messages khi chỉ một bên có thread ID.
- Nhận cả “đã xóa/xoá một tin nhắn”, “đã thu hồi” và các biến thể tiếng Anh.
- Dự phòng mã tài khoản qua module `CurrentUser`/`CurrentUserInitialData` của Facebook nếu không đọc được `c_user` từ trang. Không thêm quyền cookies.
- Bộ đếm kho cập nhật theo sự kiện ghi; trạng thái hiển thị số batch đã ghi và lý do bỏ qua tin.
- Nâng schema IndexedDB từ 1 lên 2 mà giữ dữ liệu cũ; giữ nguyên quyền của extension.

Đã đạt 18 unit test và browser test với mẫu DOM popup trên, gồm trường hợp không đọc được cookie nhưng nhận diện được viewer từ module. Việc đối chiếu trang thật là đọc cấu trúc DOM, chưa phải thử gửi và thu hồi tin trên tài khoản thật bằng bản mới.

**Cập nhật lên 0.1.6:** nếu đang nạp thư mục `dist` của dự án, chỉ cần vào `chrome://extensions`, bấm nút tải lại trên thẻ PitoFacebookFixer rồi tải lại tab Facebook. Nếu đang dùng thư mục giải nén ZIP riêng, ghi đè file của ZIP 0.1.6 vào đúng thư mục đã nạp, sau đó làm hai bước tải lại trên. Không cần gỡ extension hay xóa kho. Mở popup và kiểm tra footer hiển thị **0.1.6**; “Tin đã quan sát”, “Batch đã ghi thành công” và “Tin đang lưu” cần tăng khi trang có tin văn bản nhận diện được. Cần tải lại tab để bỏ hook chặn đã xem tin nhắn của phiên bản cũ đang chạy trên trang.

## Cài ngay

1. Mở `chrome://extensions` hoặc `edge://extensions`.
2. Bật **Developer mode / Chế độ dành cho nhà phát triển**.
3. Chọn **Load unpacked / Tải tiện ích đã giải nén**, chọn thư mục `dist` trong dự án này.
4. Tải lại các tab Facebook một lần. Mở biểu tượng extension để xem trạng thái; chọn **Cài đặt & bản lưu** để thay đổi giới hạn kho.

Nếu dùng file ZIP phát hành, giải nén vào một thư mục cố định rồi chọn thư mục chứa `manifest.json`. Không xóa thư mục đó khi còn dùng extension. Khi cập nhật, giữ nguyên thư mục cài để giữ ID và kho cục bộ của bản unpacked.

## Các phần đã hiện thực

| Chức năng | Cách hoạt động | Giới hạn |
|---|---|---|
| Lưu và hiển thị tin thu hồi — một tính năng | Nhận diện ID tài khoản/cuộc trò chuyện/tin; lưu văn bản/emoji/ảnh/voice; phục hồi trong bong bóng thu hồi, có tooltip nguồn bản lưu | Chỉ ghi binary đã tải/nhận diện; tự tải voice đang hiển thị khi được hỗ trợ; ảnh có thể là preview; không lưu video/tệp khác hoặc lịch sử trong nền |
| Giữ ô soạn | Chặn lời gọi focus sang ô chat khác khi đang gõ; khôi phục focus khi cần | Có thời hạn giữ 30 giây sau thao tác gõ; click, Tab, Escape chủ động sẽ nhả giữ; cần kiểm tra thêm với bộ gõ thật |
| Hạn chế Facebook tự làm mới | Giảm tín hiệu visibility/focus gây làm mới và hủy một số điều hướng reload/reset về trang chủ | Ngoài màn hình messages; không thay đổi cơ chế bỏ tab khỏi RAM; không ngăn mọi kiểu dựng lại bảng tin |
| Chặn đã xem story | Đang phát triển, tạm vô hiệu hóa | Facebook vẫn ghi nhận lượt xem; fetch/XHR giữ native, kể cả cài đặt cũ đã bật |

Các tính năng đã hỗ trợ mặc định bật khi chưa có lựa chọn lưu trước đó; story luôn tắt. Bảng trạng thái hiển thị số lượt quan sát/chặn. Khi trang khởi động, các bộ can thiệp chờ cấu hình đã lưu trước khi hoạt động; không tự bật mặc định trong lúc chờ hoặc khi đọc cấu hình thất bại.

Đây là mã viết mới, tham khảo phạm vi tính năng và cơ chế trong bản J2TEAM đang phân phối. Không đóng gói mã hay tài sản J2TEAM. Không thay đổi tùy chọn read-receipt cấp tài khoản của Meta; tắt extension sẽ ngừng can thiệp, sau khi tải lại tab.

## Một kho duy nhất cho tính năng tin thu hồi

Kho nằm trong **IndexedDB thuộc origin của extension**, không phải `window.localStorage` của Facebook. `chrome.storage.local` chỉ lưu cấu hình. Các lý do chọn IndexedDB:

- Ghi từng bản tin bằng transaction, không đọc/ghi lại một JSON chứa toàn bộ lịch sử.
- Khóa `[account, thread, messageId]` tránh trùng và tránh lấy nhầm cuộc trò chuyện/tài khoản.
- Index theo hạn lưu và thời điểm ghi cho phép dọn tin bằng cursor; không tải toàn bộ lịch sử vào RAM.
- Nội dung từ 1 KiB trở lên được thử nén gzip bằng API trình duyệt; chỉ dùng bản nén nếu nhỏ hơn. Không cần thư viện runtime.
- Chỉ giữ một phiên bản nội dung; tin sửa thay thế bản trước, tin đã xác nhận thu hồi không bị ghi đè bởi placeholder.
- Lần xem lại không kéo dài thời gian lưu. Không suy luận thu hồi chỉ vì một phần tử biến mất khỏi DOM khi cuộn.

Giới hạn mặc định áp dụng chung cho mọi tài khoản trong extension:

- **32 MiB ngân sách dữ liệu tính toán**, bao gồm nội dung nén và phần dự phòng cho metadata/index.
- **20.000 tin**.
- **30 ngày** tính từ lần đầu extension ghi nhận, không phải thời điểm gửi trên máy chủ.
- **16.000 đơn vị UTF-16 mỗi tin**; tin dài hơn được cắt và gắn nhãn rút gọn.

Khi vượt giới hạn dung lượng hoặc số tin, xóa tin đủ điều kiện cũ nhất đến dưới 95% cả hai giới hạn nếu có thể. Chính sách **Cho phép tự dọn tin đã thu hồi** quyết định các tin này có bị dọn hay được bảo vệ; mặc định vẫn cho phép dọn như bản cũ. Phần được bảo vệ vượt ngân sách sẽ được giữ và kho ngừng lưu mới. Hết hạn thì tự xóa bản ghi đủ điều kiện; dọn khi ghi, mở bảng cài đặt, khởi động trình duyệt và qua alarm mỗi 30 phút. Tuổi riêng của ảnh/voice được kiểm tra mỗi 30 phút và khi lưu cấu hình. Trình duyệt đóng thì việc dọn tiếp tục ở lần mở sau.

Khi gặp lỗi quota, thử dọn thêm và ghi lại một lần; lỗi còn tồn tại được báo ở trạng thái tab. Không yêu cầu `unlimitedStorage`.

**Không thể giữ tất cả tin vĩnh viễn mà dung lượng cố định.** Giới hạn trên kiểm soát dữ liệu logic; file IndexedDB thực tế còn phần quản lý, journal và cơ chế cấp phát/tái sử dụng của trình duyệt. Không hứa file trên đĩa luôn chính xác dưới 32 MiB hoặc thu nhỏ ngay sau khi xóa. RAM cũng có giới hạn: MAIN giữ tối đa 128 quan sát chờ gửi, 64 tin mỗi batch và chỉ một batch đang chờ phản hồi; isolated world có tối đa 2 batch chờ xử lý (để hỗ trợ đổi cấu hình khi batch cũ chưa xong). Bộ nhận diện giữ tối đa 256 hàng DOM, dùng TreeWalker quét tiếp phần còn lại. Nhóm vẽ lại tối đa 64 hàng rồi quét tiếp nếu cần. Không giữ toàn bộ lịch sử trong Map; cache theo hàng DOM dùng WeakMap.

## Hiển thị bản lưu

Extension thay chữ “đã thu hồi/xóa một tin nhắn” bằng nội dung đã ghi, ngay trong bong bóng viền/chữ nghiêng sẵn có của Facebook. Không có hộp riêng. Tooltip khi rê chuột ghi nguồn bản lưu và thời điểm lưu; thông tin đầy đủ của bản ghi vẫn có trong trang cài đặt extension.

“Phát hiện thu hồi” là thời điểm extension quan sát được, không nhất thiết là thời điểm chính xác người gửi nhấn thu hồi. Tải lại trang vẫn có thể phục hồi nếu Facebook còn cung cấp đúng ID và kho chưa dọn bản tin đó. Nếu không nhận diện được ID hoặc vùng chữ thu hồi rõ ràng, extension bỏ qua thay vì đoán theo nội dung/vị trí hoặc thay cả hàng chat.

## Dữ liệu và quyền

- Không backend, analytics, mã từ CDN hay lưu khóa đăng nhập. Không tải lịch sử bằng API riêng, không lấy token.
- Chỉ chạy trên `www.facebook.com`, `web.facebook.com`, `www.messenger.com`, `messenger.com` qua HTTPS.
- Chỉ xin `storage`, `alarms`, host Facebook/Messenger và CDN `*.fbcdn.net`, `*.fbsbx.com`. Không xin cookies, debugger, webRequest, unlimitedStorage, microphone hoặc quyền mọi website.
- Đọc mã tài khoản từ `c_user` hoặc module nhận diện viewer của Facebook để phân tách dữ liệu; không lưu toàn bộ cookie.
- Kho chưa mã hóa bằng mật khẩu. Ai dùng được profile trình duyệt và trang cài đặt extension có thể đọc bản lưu.
- Nội dung được gán vào dữ liệu text node hiện có; không phân tích hay thực thi HTML từ tin nhắn.
- Có nút xóa toàn bộ kho kèm xác nhận trong cài đặt. Gỡ extension cũng xóa kho.
- Khi chuyển tài khoản, bản lưu gửi về chỉ được hiển thị nếu mã tài khoản và khóa hàng hiện tại còn khớp.

## Phát triển và kiểm thử

Yêu cầu Node.js 20+, npm. Python 3 chỉ dùng nếu đóng ZIP bằng script package.

```powershell
npm ci
npm run build
npm test
npx playwright install chromium
npm run test:browser
npm run package
```

`npm run check` chạy unit test, build và browser test theo thứ tự. Runtime extension không cần Node hay Python. Dependency dùng phiên bản chốt trong `package-lock.json`.

Unit test dùng fake IndexedDB để kiểm tra nén, phân tách tài khoản, sửa tin, hết hạn, giới hạn dung lượng/số tin sau 1.200 lần ghi, phân trang cùng timestamp, không ghi khi tắt và nhận diện request story. Browser test nạp extension thật vào **profile Chromium thử nghiệm riêng**, chặn toàn bộ kết nối đến Facebook bằng trang fixture. Không đăng nhập, không đọc hay gửi tin qua tài khoản thật. Ảnh kiểm tra giao diện nằm trong `test-results/`. `npm run test:bulk` kiểm tra thu hồi hàng loạt và phản hồi kho chậm; bài này cũng chạy trong `npm run verify`.

**Browser test trên fixture không chứng minh tương thích Facebook đang triển khai cho tài khoản của bạn.** Phần tích hợp dựa vào props/module/protocol nội bộ cần được hiệu chỉnh khi Meta thay đổi. Bản này không sửa cài đặt tài khoản hay gửi tin thử cho người khác.

Quy trình kiểm tra thực tế sau khi cài:

1. Mở cài đặt, kiểm tra “Đã kết nối bộ can thiệp” và “Tin đã quan sát” tăng khi mở một cuộc trò chuyện. Nếu không tăng, adapter hiện tại chưa nhận diện được giao diện đó.
2. Dùng cuộc trò chuyện thử có người tham gia biết trước: nhận tin văn bản, chờ kho tăng, thu hồi và kiểm tra nội dung xuất hiện trong bong bóng gốc; rê chuột xem tooltip, tải lại rồi kiểm tra lại.
3. Đang gõ một đoạn tiếng Việt thì để popup khác xuất hiện; kiểm tra chữ và con trỏ vẫn ở ô cũ. Kiểm tra click/Tab chuyển được.
4. Rời tab bảng tin vài phút rồi quay lại, kiểm tra vị trí/bài đang đọc; F5 và click điều hướng vẫn phải hoạt động.
5. Story đang phát triển và không chặn lượt xem. Chỉ thử hiệu quả ẩn lượt xem khi tính năng được bật lại ở bản phát hành sau.

## Cấu trúc mã

- `src/archive.js`: IndexedDB, nén, chống trùng, hạn lưu và dọn kho.
- `src/adapter.js`: đọc hàng tin nhắn từ DOM/props React với ID ổn định.
- `src/media.js`, `src/media-dom.js`, `src/media-render.js`: kiểm tra loại/giới hạn tệp, emoji, tải voice không phát và hiển thị binary/album từ kho.
- `src/guards.js`: giữ focus và hạn chế tự làm mới.
- `src/protocol.js`: nhận diện request story dành cho nghiên cứu/hồi quy; hiện không nối vào hook runtime.
- `src/main.js`: các hook chạy trong MAIN world từ document_start.
- `src/content.js`: cầu nối isolated world, giao tiếp background, chèn bản lưu.
- `src/background.js`: kiểm tra nguồn yêu cầu, tuần tự hóa ghi và alarm.
- `src/ui.js`, `extension/popup.html`, `extension/options.html`, `extension/ui.css`: popup riêng, cài đặt, giao diện sáng/tối và bản lưu phân trang.
- `dist/`: extension có thể nạp trực tiếp, tạo bằng build.

## Nguồn nghiên cứu

- [J2TEAM Security trên Chrome Web Store](https://chromewebstore.google.com/detail/j2team-security/hmlcjjclebjnfohgmgikjfnbmfkigocc). Đối chiếu gói 2.4.3 từ dịch vụ cập nhật Chrome: visibility/focus guard; LightSpeed task 21; cơ chế native read-receipt setting. Bản Pito không áp dụng cơ chế đổi setting cấp tài khoản.
- [Repo J2TEAM công khai đã archive](https://github.com/J2TEAM/J2TEAM-Security). Repo này khác gói đang phân phối; không dùng làm bằng chứng tương thích hiện tại.
- [Chrome: storage và cookies trong extension](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies).
- [Chrome Storage API](https://developer.chrome.com/docs/extensions/reference/api/storage).
- [Chrome: cross-origin network requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests).
- [Chrome: message passing và JSON serialization](https://developer.chrome.com/docs/extensions/develop/concepts/messaging).
- [MDN: Navigation navigate event](https://developer.mozilla.org/en-US/docs/Web/API/Navigation/navigate_event).
- [Meta: giải thích mã hóa đầu cuối Messenger](https://about.fb.com/news/2024/03/end-to-end-encryption-on-messenger-explained/).
- [Playwright: kiểm thử extension](https://playwright.dev/docs/chrome-extensions).

Tệp tải về để nghiên cứu nằm trong `.research`, được bỏ qua khi đóng gói.
