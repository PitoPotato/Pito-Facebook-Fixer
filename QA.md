# Quy trình kiểm thử và điều kiện phát hành

Kết quả bản 0.3.0: [TEST_RESULTS.md](TEST_RESULTS.md). Kiểm thử hai tài khoản còn chưa thực hiện. Story tạm vô hiệu hóa, mang nhãn In development / Đang phát triển.

Không dùng Chrome cá nhân của người dùng, kể cả chỉ để xem tài khoản đang đăng nhập. Lượt 0.3.0 có một lần lệch quy định này, được ghi lại trong TEST_RESULTS.

## Hồi quy 0.3.1 — ảnh thu hồi tại chỗ, phóng to và chuyển ảnh

Lỗi gốc: bong bóng thu hồi chỉ hiện chữ thay thế *“Recalled photo — saved on this device”* của khung ảnh. Đã tái hiện bằng dữ liệu tổng hợp với hai nguyên nhân: (1) một lần đọc kho trả `errBusy` thì ảnh không bao giờ được thử lại; (2) Facebook vẽ lại bong bóng thì ảnh bị tạo lại và đọc lại từ phần đầu. Với mã cũ, khung ảnh không bao giờ tải xong trong cả hai trường hợp; không có lỗi nào thì ảnh vẫn tải bình thường.

`npm run test:viewer` (`tests/viewer-browser.mjs`, có trong `verify`) dùng profile mới, HTTP bị chặn, tin nhận từ “Pito” với album 7 ảnh JPEG 1600×1200 có số in trên ảnh, một ảnh dọc và một tin chữ:

- Worker trả `errBusy` cho 2 lần đọc đầu; bong bóng bị thay phần chữ thu hồi 10 lần trong lúc ảnh đang tải. Cả 6 ô và ảnh dọc phải tải xong. Tổng số lần đọc kho không vượt số phần cần đọc cộng số lần lỗi, tức không đọc lại từ đầu. Không có chữ thay thế nào hiện trong cuộc trò chuyện.
- Lưới: 6 ô và ô cuối ghi “+1”; ảnh đơn giữ đúng tỉ lệ dọc, cao tối đa 320 px.
- Nhấn ảnh không lan xuống hàng tin, kiểm bằng bộ đếm click của trang.
- Trình xem: kiểm từng ảnh theo SHA-256 sau mỗi lần chuyển bằng nút, ← →, Home/End, dải ảnh nhỏ và vuốt ngang. Ở hai đầu, nút chuyển bị vô hiệu nhưng phím vẫn dùng được. Thử 60 lần nhấn phím liên tiếp.
- Phóng to: nút (125%), con lăn tại vị trí con trỏ, kéo để di chuyển (kéo khi đã phóng to không chuyển ảnh), nhấn ảnh (250%, nhấn lần nữa về 100%), phím `+` `-` `0`; chuyển ảnh thì trở về vừa màn hình.
- Tải ảnh về: tên `pitofacebookfixer-photo-N.jpg`, đúng từng byte.
- Đổi sang tiếng Việt khi trình xem đang mở: nhãn nút, gợi ý và nhãn ô đổi theo.
- Esc đóng trình xem, focus trở lại ô ảnh vừa mở. Ảnh đơn không có nút chuyển hay dải ảnh nhỏ; nhấn vùng tối thì đóng.
- Tắt lưu trữ khi trình xem đang mở: trình xem đóng, mọi URL ảnh bị thu hồi (`fetch` thất bại). Bật lại thì ảnh hiện lại.
- Ảnh chụp: `test-results/viewer-browser/bubble.png`, `viewer.png`, `viewer-zoomed.png`; báo cáo `report.json`.

`tests/background.test.js` có thêm: khi 3 lượt lưu đang giữ hàng đợi ghi vì chờ CDN, 26 lần đọc phần ảnh cùng lúc phải trả về trong 2 s, không lỗi và đủ byte. Bài này thất bại trên `background.js` của 0.3.0 (*reading a saved file waited for the capture*).

`tests/storage-browser.mjs` đổi theo giao diện mới: album 2 ảnh hiện cả 2 ô trong bong bóng; chuyển ảnh và 30 lần chuyển nhanh được thử trong trình xem.

**Chưa kiểm:** Facebook thật, tin nhận từ tài khoản khác, ảnh thật chụp bằng điện thoại. Theo [Tầng 3](#tầng-3-facebook-thật-tài-khoản-thử-nghiệm-riêng), cần một tài khoản gửi thử riêng để kiểm tin nhận.

## Hồi quy 0.3.0 — kho, sao lưu, khóa, media mới và hiệu năng

Unit test (`npm test`, 98 test): `archive`, `media`, `vault`, `backup`, `adapter`, `background`, `i18n`, `protocol`, `sender` và `review`, `review2`, `review3` (hồi quy cho lỗi do kiểm tra độc lập tìm ra). Trọng tâm:

- Thứ tự dọn kho, hạn lưu từ lúc thu hồi, lịch sử sửa có giới hạn, chi tiết người gửi không bị xóa.
- Tìm kiếm qua nhiều trang và theo ngân sách quét; dọn kho theo phần, chỉ ghi khi đổi.
- Video/tệp/sticker/GIF theo nội dung tệp; tải lên theo phần và tách theo tab.
- Kho được niêm phong không còn chữ/tên/tệp đọc được; một bản ghi không bao giờ nửa niêm phong nửa không, kể cả khi sửa tin trong lúc đang niêm phong, khi nhập sao lưu đúng lúc bật/tắt khóa, hay khi hai lượt tắt khóa chạy cùng lúc.
- Bản ghi hỏng chỉ bị đánh dấu, không làm hỏng danh sách/sao lưu và không cho gỡ khóa; tệp không đọc được bị bỏ riêng khi xuất.
- Sao lưu bị cắt, sửa, sai mật khẩu, tiêu đề hỏng hoặc có trường lạ thì không nhập gì.

Trình duyệt, dữ liệu tổng hợp, profile riêng, HTTP bị chặn:

- `tests/features-browser.mjs`: sticker, GIF, tệp, video 15 MiB chỉ khi bật; người gửi/trả lời/lịch sử sửa/bộ lọc/tìm kiếm trên trang bản lưu; ba lần ghi lỗi rồi thử lại, kể cả khi tin bị thu hồi trong lúc chờ và khi có bản sửa mới hơn (bản mới phải là bản hiện tại, bản cũ vào lịch sử); khôi phục đúng từng byte; xuất sao lưu, xóa, sai mật khẩu, nhập lại qua giao diện; bật khóa, khóa (bong bóng trở về thông báo gốc), mở khóa, tắt khóa.
- `tests/adapter-browser.mjs`: các tối ưu không làm sót tin: thu hồi đổi mã sau khi cuộn, hàng tái sử dụng không nhận nhầm bản lưu, sửa chữ tại chỗ trong chat và popup mở sau, ảnh xuất hiện muộn, hàng nhận mã sau, node React được tái sử dụng cho tin khác, vượt giới hạn vùng theo dõi.
- `tests/perf-browser.mjs` (không nằm trong `verify`, chạy riêng): so sánh không extension / 0.2.0 / bản hiện tại. Đo CPU script qua CDP khi cuộn chat 600 tin, khi danh sách thêm/bớt hàng trong lúc cuộn và khi bảng tin thay đổi; bộ nhớ tab và worker gồm cả vùng ArrayBuffer (`usedSize + backingStorageSize`); đỉnh bộ nhớ khi lưu 4 ảnh 7,5 MiB; số lần tải lại ảnh sau 2 lần reload; thời gian dọn kho ~20.000 tin khi đổi hạn lưu và khi không bản ghi nào đổi; thời gian một tin mới phải chờ trong lúc dọn. Máy đang bận làm số tuyệt đối dao động; so sánh trong cùng một lượt đo và ghi khoảng giá trị.

### Kiểm tra độc lập

Mỗi lượt sửa lớn được một agent riêng kiểm tra trên bản sao đóng băng của mã (`test-results/review-round*`), với bằng chứng tự viết (fake-indexeddb, Chrome thật với HTTP bị chặn) thay vì tin kết quả của tác giả. Lỗi tìm được phải có test hồi quy trước khi đóng. 0.3.0 qua 5 vòng; vòng cuối đạt.

### Facebook thật (tầng 3) cho 0.3.0

Bộ điều khiển chỉ mở profile QA riêng trong `test-results/facebook-live-qa/` và từ chối mọi profile khác:

```powershell
node scripts/live-qa.mjs test-results/facebook-live-qa/<id>/profile
node scripts/qa-command.mjs status
node scripts/qa-command.mjs cycle            # gửi, thu hồi, kiểm tra bong bóng
node scripts/qa-command.mjs send
node scripts/qa-command.mjs edit             # sửa tin QA hiện tại bằng Edit của Messenger
node scripts/qa-command.mjs details          # trường đã lưu của tin QA hiện tại
node scripts/qa-command.mjs vault enable     # enable | lock | unlock | disable | status
node scripts/qa-command.mjs bubble           # bong bóng đang hiện bản lưu / đang khóa
node scripts/qa-command.mjs reload
node scripts/qa-command.mjs verify
node scripts/qa-command.mjs proof
node scripts/qa-command.mjs close
```

- Chỉ đoạn chat với chính tài khoản thử nghiệm, chỉ tin có tiền tố `PFF-QA-`; `edit` và `probe` chỉ tác động lên tin QA hiện tại. `probe` chỉ đọc tên và kiểu prop React, không đọc giá trị.
- Mọi bước được ghi vào `test-results/live-qa-0.3.0/report.json` (`steps`). Mật khẩu khóa dùng trong QA được tạo ngẫu nhiên và không ghi vào báo cáo. Xóa `control.json` (cổng và khóa của bộ điều khiển) sau mỗi phiên.
- Đã kiểm trên 0.3.0: lưu → thu hồi → hiển thị (8 chu kỳ), sửa tin, khóa/mở khóa/tắt khóa, reload. Còn phải kiểm: sticker/GIF/tệp/video, sao lưu và nhập, tìm kiếm, nâng cấp kho cũ trên profile thật, hai tài khoản gửi–nhận, mẫu câu thu hồi ngoài EN/VI. Các mẫu này chỉ được ghi là đã kiểm khi thử bằng Facebook ở đúng ngôn ngữ đó.
- Messenger có thể hỏi PIN khôi phục lịch sử mã hóa. Không nhập PIN; tin mới vẫn kiểm thử được.

## Hồi quy 0.2.0 — ngôn ngữ và nhận diện

`tests/i18n.test.js` kiểm tra English là mặc định, whitelist en/vi, tính đầy đủ của hai catalog và placeholder khớp nhau. `tests/i18n-browser.mjs` dùng profile mới không đăng nhập, chặn HTTP, kiểm tra 117 chuỗi tĩnh/thuộc tính, bốn trang và dialog ở hai ngôn ngữ, ngày/số theo locale, EN/VI đồng bộ giữa popup/options và qua reload, giữ bản nháp và các cài đặt khác. Tin nhắn tổng hợp trùng tên UI hoặc có HTML vẫn được giữ nguyên như văn bản; đổi ngôn ngữ giữ nguyên phần tử ảnh/voice.

`tests/media-browser.mjs` bổ sung đổi EN→VI→EN khi voice lưu đang phát: không thay node hoặc dừng âm thanh. `tests/popup-action.mjs` nay mở popup thật ở cả EN/VI × system/light/dark, kiểm tra logo tải được/không co dưới 32 px và nút ngôn ngữ cách nút theme không quá 8 px; width 400 px, không tràn/cuộn trong trạng thái bình thường và switch vẫn lưu khi popup đóng. Matrix bổ sung chạy Chromium 156 ở scale 1/1.25/1.5 và Chromium 141 ở 1.5.

Ảnh và report song ngữ: `test-results/i18n-brand/`. Popup thật: `test-results/popup-action/report-0.2.0-*.json` và các PNG cùng prefix phiên bản. Logo xuất lại bằng `node scripts/brand-assets.mjs` với browser tạm riêng, không dùng mạng hoặc phiên cá nhân.

## Hồi quy 0.1.9 — popup thật

`npm run test:popup` mở Chromium có cửa sổ với profile mới trong `test-results/popup-action/profiles/`, chặn mọi HTTP và không đăng nhập Facebook. Gọi `chrome.action.openPopup()` để Chrome tự tính kích thước bubble thật; không dùng tab popup.html hoặc ép viewport. Kiểm tra width 400 px, cột chữ ít nhất 200 px, nút cài đặt đủ rộng, không tràn ngang/cuộn dọc trong trạng thái bình thường. Lần lượt mở ở theme system/light/dark, đổi switch, đóng chính cửa sổ popup và kiểm tra storage đã commit.

Bài này thất bại trên CSS 0.1.8 (width 174 px) và đạt sau sửa. Matrix đã chạy: Chromium 156 với `PFF_TEST_SCALE` 1 / 1.25 / 1.5; Chromium 141 với scale 1.5. Đặt `PFF_TEST_BROWSER` để chọn binary. Ảnh và report nằm trong `test-results/popup-action/`. `npm run verify` đã bổ sung bước popup thật cho các lần kiểm tra đầy đủ tiếp theo.

## Hồi quy 0.1.8

`node tests/settings-browser.mjs` tạo profile mới, chặn mọi HTTP Facebook bằng fixture. Bài thử cũ thất bại ở việc đóng popup ngay sau đổi switch; bản sửa phải qua bước này mà không bấm Lưu. Sau đó kiểm tra hai cửa sổ đổi các trường khác nhau đồng thời, UI đồng bộ, giới hạn số qua nút Áp dụng, năm lần refresh trang khi storage đọc chậm 900 ms, tắt/mở lại trình duyệt cùng profile và cấu hình MAIN từ revision cũ. Kiểm tra cả giá trị trên đĩa, isolated bridge và hành vi focus thực tế của MAIN, không chỉ giá trị hiển thị.

Bài này cũng chụp bốn trang ở giao diện sáng/tối, popup riêng, kiểm tra 375/768/1440 px không tràn ngang, Space đổi công tắc và được lưu, Escape đóng dialog/trả focus, story không bật được, không có tài nguyên UI tải từ CDN hoặc lỗi JavaScript không được xử lý. Ảnh: `test-results/ui-0.1.8/`.

Live QA: `preferences-check` đổi ngân sách và tuổi tin qua form, đổi công tắc trong popup rồi đóng, refresh self chat ba lần; kiểm tra cấu hình lưu và revision được MAIN áp dụng. Đóng controller, mở lại cùng profile và **cùng đường dẫn build đã kiểm tra**, rồi `preferences-verify` xác minh khởi động lại và trả lại cấu hình QA ban đầu. Chỉ profile phụ đã xác nhận; không đọc hay thao tác tab/profile chính. Thực hiện thêm chu kỳ self chat gửi → commit → thu hồi → thay chữ trong bong bóng → reload.

Nguồn và quyết định thiết kế: [UI_RESEARCH.md](UI_RESEARCH.md).

## Hồi quy 0.1.7

`node tests/storage-browser.mjs` tạo profile và trang Facebook tổng hợp riêng. Bài thử đi qua bridge và kho thật: cài ngân sách 256 MiB/0 ngày/bảo vệ tin thu hồi qua form; tự lưu voice mà Audio vẫn paused/currentTime=0; không tải lại voice đã lưu sau reload; lưu album hai ảnh; thu hồi, kiểm tra từng SHA-256 qua nút chuyển ảnh; chuyển nhanh 30 lần; giải mã/phát voice; reload; dọn riêng ảnh rồi voice bằng giao diện xác nhận. Mặc định dọn riêng không đụng tới tin thu hồi, chọn rõ mới xóa; chữ vẫn còn. Bài này không phụ thuộc tài khoản thật hoặc media fixture trên đĩa.

Unit test bổ sung kiểm tra tin được bảo vệ sống qua TTL/quota kiểu ngân sách thấp, ngừng ghi mới rồi tiếp tục khi tăng ngân sách; thời hạn 0 ngày; dọn theo loại/tuổi; chống tải lại tệp đã dọn; album về từng phần. `npm run verify` chạy các bài này cùng bộ hồi quy hiện có.

Live QA dùng profile phụ đã được người dùng xác nhận. Gửi voice từ micro giả, **không bấm Play**, kiểm tra Blob đã commit và bộ đếm tự tải. Gửi album hai họa tiết cùng một lần; chờ đủ hai Blob, thu hồi qua UI; kiểm tra chỉ một ảnh trong bong bóng, bấm chuyển, SHA-256 từng ảnh/voice, phát voice từ kho, rồi reload và kiểm tra lại. Lệnh controller `image-album`, `voice-start`, `media-capture-status`, `media-unsend`, `media-verify`; chỉ self chat, không tự điều khiển điện thoại hoặc thử người nhận khác.

## Ranh giới tài khoản

Không dùng Facebook chính của người dùng, kể cả chỉ gửi một tin thử hoặc dùng cookie đăng nhập để chạy test. Không đọc hay sao chép profile Chrome cá nhân. Live QA dùng Chromium riêng, profile mới trong `test-results/facebook-live-qa/`, bắt đầu với 0 cookie Facebook. Người dùng tự đăng nhập tài khoản thử nghiệm và báo đã xong trước khi chạy kiểm tra có đăng nhập.

Chỉ dùng đoạn chat với chính tài khoản thử nghiệm. Không gửi tin đến Facebook chính, bạn bè hoặc nhóm. Nếu muốn xác minh tin **nhận từ người khác**, cần một tài khoản gửi thử riêng khác được người dùng chỉ định; kiểm thử chat với bản thân không được ghi nhận là kiểm thử hai tài khoản.

## Tầng 1: logic và lỗi hồi quy

```powershell
npm test
```

- Ghi được bản tin qua chính handler background khi `MessageSender.frameId` không có.
- Phân biệt source URL, source origin, tab metadata và extension page đúng cách.
- Từ chối extension khác, origin ngoài danh sách, nguồn opaque, sai origin và quyền quản trị từ content script.
- Ghi vào IndexedDB thực, tìm lại bản lưu khi thu hồi; bộ đếm quan sát không thay thế bước này.
- Nén, chống trùng, cập nhật tin sửa, phân tách tài khoản, hết hạn, giới hạn dung lượng/số tin và nâng schema giữ dữ liệu.
- ID số tạm và ID E2EE đã xác nhận được chuẩn hóa về cùng khóa; ID tombstone thay đổi có ánh xạ giới hạn và tồn tại qua reload. Không ánh xạ khi metadata hàng đã đổi sang một tin khác.

## Tầng 2: extension thật trong trình duyệt, dữ liệu tổng hợp

```powershell
npm run verify
```

Chạy 5 vòng, mỗi vòng tạo profile riêng. Xen kẽ Chromium 141 và Chrome for Testing 156 nếu binary 156 đã được chuẩn bị tại `test-results/browser-current/chrome-win64/chrome.exe`. Có thể đặt `PFF_TEST_BROWSER` cho browser test riêng. `test-results/verification.json` ghi kết quả và luôn tách biệt với live Facebook QA.

Mỗi vòng xác minh:

1. Nạp manifest/background/UI không lỗi.
2. Quan sát hàng tin DOM/React có ID thật trong fixture.
3. Ghi qua bridge và background; đọc lại số bản ghi từ IndexedDB.
4. Đổi đúng tin thành tombstone, thay chữ trong bong bóng gốc; giữ nguyên phần tử, text node, class/style và nút thao tác, không có thẻ phụ. Kiểm tra tooltip nguồn bản lưu.
5. Tải lại trang, bản lưu còn và tiếp tục chèn được.
6. DOM popup `role=log`, heading người gửi, ID tin E2EE, không có thread ID, viewer không lấy từ cookie.
7. Tin chứa HTML chỉ được hiển thị như văn bản.
8. Bộ đếm kho cập nhật khi ghi; phần chữ đã thay không bị ghi nhầm là tin mới. Tắt tính năng/xóa kho trả lại chữ thu hồi gốc; cài đặt vẫn hoạt động.
9. Focus, chuyển chat chủ động, bộ gõ dạng composition, story đi qua fetch/XHR native khi đang phát triển, reload tự động và điều hướng chủ động. Chờ cấu hình được MAIN xác nhận trước khi kiểm tra các guard.
10. Không có lỗi JavaScript không được xử lý.

Sau đó chạy ghi liên tục **512 tin qua extension thật**, giữ số hàng DOM hiển thị có giới hạn. Kiểm tra 16 điểm: kho không vượt 100 tin và 2 MiB cấu hình thử, tin cũ tự bị dọn, tin mới nhất vẫn phục hồi được. Đóng và mở lại trình duyệt cùng profile thử để xác minh dữ liệu trên đĩa. Báo cáo: `test-results/stress-report.json`.

Cuối cùng chạy **384 tin / 192 tin thu hồi cùng lượt DOM** qua `tests/bulk.mjs`: background cố tình phản hồi chậm, chọn xen kẽ, có nội dung và timestamp trùng nhau; kiểm tra trước/sau reload, vẽ lại hơn 64 hàng, phản hồi kho đến trước chữ thu hồi. Bổ sung trường hợp thay cả nhóm không đủ liên kết: không được đoán mã theo vị trí hoặc timestamp trùng. Báo cáo: `test-results/bulk-report.json`.

Người dùng thu hồi nhiều tin bằng tính năng có sẵn của Messenger điện thoại. Bài bulk có thêm 16 tin, 8 tin nhận cập nhật thu hồi theo nhiều đợt mà không có click trên web; mã/trạng thái đổi trước chữ thu hồi, sau đó kiểm tra đúng nội dung từng tin và các tin không được chọn. Đây là mô phỏng cập nhật từ xa, tách biệt với lượt người dùng thao tác trên điện thoại thử nghiệm. Nếu kiểm tra điện thoại thật, chỉ dùng tài khoản thử nghiệm riêng và self chat tương ứng, không dùng Messenger/Facebook chính.

Xác minh chức năng đã xem tin nhắn được bỏ hoàn toàn: không có công tắc/cấu hình `blockSeen`, cấu hình cũ không bật lại được; `WebSocket.send` vẫn là hàm native trong fixture. Fetch/XHR giữ native, request đọc chat và story đều đi qua, kể cả cấu hình story cũ đang bật.

Các test tầng 2 dùng route HTTP thay nội dung trang Facebook bằng fixture và cookie tổng hợp trong profile thử. Chúng **không phải** bằng chứng đã kiểm thử tài khoản Facebook production.

## Tầng 3: Facebook thật, tài khoản thử nghiệm riêng

Chỉ bắt đầu sau khi người dùng xác nhận đăng nhập tài khoản thử nghiệm trong profile tách biệt.

- Ghi nhận phiên bản extension/browser và kiểm tra background không từ chối nguồn.
- Mở self chat, gửi văn bản có mã thử duy nhất; đợi **số bản ghi IndexedDB tăng**, không chỉ nhìn “Tin đã quan sát”.
- Thu hồi đúng tin đó bằng giao diện Facebook. Nội dung phải nằm trong bong bóng thu hồi gốc, không có thẻ phụ; tooltip có “Bản lưu từ PitoFacebookFixer”. Kiểm tra mã native của hàng thuộc bản ghi/aliases đã lưu, không chỉ đối chiếu chữ.
- Tải lại và mở lại đoạn chat; tin đã lưu vẫn được chèn đúng vị trí.
- Lặp lại ít nhất 3 chu kỳ với mã tin/nội dung khác nhau; thử mở popup chat và trang messages nếu giao diện hỗ trợ.
- Kiểm tra click, Tab và gõ tiếng Việt khi chat khác xuất hiện. Không dùng Facebook chính làm đối tượng gửi thông báo thử.
- Kiểm tra đã xem story cần **hai tài khoản thử nghiệm riêng** và quan sát phía người đăng. Self chat không xác minh được story views. Chặn đã xem tin nhắn đã bị gỡ.

Không lưu HAR, trace có cookie, mật khẩu, OTP, token hoặc toàn bộ lịch sử. Báo cáo chỉ giữ số lượng, trạng thái đạt/không đạt, phiên bản và ảnh chứng minh từ tài khoản thử nếu cần.

## Điều kiện kết luận

Một bản build chỉ được gọi là đã xác minh lưu/hiển thị tin thu hồi trên Facebook thật khi tầng 3 đạt. Phần nào chưa có đủ tài khoản/dữ liệu để thử phải ghi “chưa xác minh”; không đổi thành đạt vì unit hoặc fixture pass. Nếu cần sửa trong lúc thử, build lại, chạy hồi quy rồi kiểm tra lại luồng bị ảnh hưởng.

## Hồi quy theo log điện thoại

Bài bulk phải có các lần removeChild và insertBefore riêng dưới cùng phần tử cha trong một lượt observer, metadata trùng nhau, chọn xen kẽ. Kiểm tra đúng từng liên kết sibling và không ghép trường hợp thay cả nhóm mơ hồ. Bản 0.1.4 thất bại ở nhánh này; 0.1.5 phải đạt.

Khi thử Messenger điện thoại thật: gửi các mã PFF-QA-MOBILE vào self chat tài khoản phụ, chờ từng tin commit, người dùng tự chọn và thu hồi trên điện thoại. Chụp trạng thái trước reload, lưu audit DOM qua binding về tiến trình QA, sau đó mới reload và kiểm tra lại. Không dùng read-receipt/story làm bằng chứng cho tính năng thu hồi. Kết quả phải ghi riêng số đã lưu, được đánh dấu thu hồi và hiển thị đúng nội dung.

## Emoji và media của 0.1.6

`npm run test:media` nạp extension thật trong profile riêng. Kiểm tra 5 dạng emoji bằng ảnh alt, 2 ảnh có/không chú thích, một voice Blob phát qua Audio ngoài DOM; không ghi video/sticker/file/status. Khi thu hồi, kiểm tra giải mã ảnh, metadata voice và SHA-256 của từng binary; bắt đổi mã alias sau rescan; reload với URL ảnh gốc bị vô hiệu hóa; tắt/bật lại/xóa kho phải tháo media và revoke URL blob.

Playwright không route được fetch do extension worker khởi tạo trong bài này: URL CDN tổng hợp được stub đúng tại ranh giới fetch của worker. Stream, giới hạn, MIME, IndexedDB, JSON/chunk transport và renderer là mã thật. Đây vẫn là fixture; không gọi nó là kiểm chứng CDN production.

Live media QA chỉ dùng ảnh họa tiết tự tạo và âm thanh tone từ micro giả của Chromium, gửi vào self chat tài khoản phụ. Không lấy ảnh/ghi âm của người dùng hoặc đọc microphone thật. Thử riêng emoji/ảnh/voice: chờ binary commit, thu hồi qua UI Facebook, kiểm tra hiển thị/phát lại và byte hash trước/sau reload. Voice chưa tải/phát trên web không được đánh dấu là đã lưu đủ binary.
