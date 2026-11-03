# Kết quả kiểm thử 0.2.0 — English / Tiếng Việt và logo Pito

Ngày: 03/11/2026, giờ Việt Nam. Source build: `0.2.0-i18n-brand-v1`.

## Phạm vi và kết quả

English mặc định cho cả cài đặt mới và record nâng cấp chưa chọn ngôn ngữ. EN/VI nằm ngay bên cạnh theme trong options và popup, lưu qua storage.local và đồng bộ các cửa sổ. Logo P mới (bong bóng vàng trên nền kem) được tích hợp vào header, favicon, toolbar và manifest icons. Toàn bộ tài nguyên đều cục bộ.

Lệnh `npm run verify` trên bản 0.2.0 đạt **44 unit/regression test và 13 mục build/integration**, gồm 5 vòng browser integration, stress, bulk, media, storage, settings, song ngữ và popup thật. Sau rà màu chữ breadcrumb, kiểm tra song ngữ được chạy lại và đạt trên CSS cuối.

| Kiểm tra bổ sung | Kết quả |
|---|---|
| Catalog tĩnh 117 mục, catalog trạng thái/nhãn động | Cả EN/VI đầy đủ, placeholder tương ứng |
| Cài đặt không có language hoặc giá trị không hỗ trợ | Chọn English; chỉ chấp nhận en/vi |
| Bốn trang ở EN/VI và sáng/tối | Nội dung, aria-label, title, placeholder, số/ngày đúng locale |
| Options đổi sang VI, popup đang mở | Đồng bộ ngay; reload giữ VI |
| Popup đổi về EN | Options đồng bộ; mở lại giữ EN |
| Bản nháp ngân sách chưa Áp dụng | Không bị ghi đè khi chuyển ngôn ngữ; ngân sách đang lưu và cài đặt khác giữ nguyên |
| Dialog dọn ảnh và thông báo nhập số ngày sai | Dịch đúng EN/VI |
| Tin nhắn có chữ trùng UI hoặc chứa HTML | Không dịch nội dung, không thực thi HTML |
| Ảnh/voice đang hiển thị | Giữ nguyên node khi đổi ngôn ngữ; voice đang phát không bị dừng khi EN→VI→EN |
| Logo SVG trong UI, manifest PNG toolbar/extension | Tải/giải mã được; có các cỡ 16/24/32/48/128/256/512 px |
| 375/768/1440 px | Không tràn ngang trong cả hai ngôn ngữ |
| Tài nguyên UI | Không có request ra mạng; không lỗi JavaScript không được xử lý |

## Popup Chrome Action thật

Matrix trên mã cuối: **24/24 popup** = EN/VI × system/light/dark × bốn cấu hình browser/scale.

- Chromium 156: scale 100%, 125%, 150%.
- Chromium 141: scale 150%.
- Mỗi popup rộng 400 px, cao 584 px; cột chữ ít nhất 250 px, logo không bị co dưới 32 px, nút language/theme cách nhau tối đa 8 px.
- Không tràn ngang hoặc cuộn dọc trong trạng thái bình thường. Đổi switch rồi đóng popup thật vẫn ghi được cài đặt ở mọi trường hợp.

Bài mới bắt được lỗi header kế thừa bố cục mobile khi thêm hai nút; đã sửa selector cho header popup và chạy lại matrix. Không nới các kiểm tra kích thước, logo hay độ sát của hai nút.

Report: `test-results/verification.json`, `test-results/i18n-brand/report.json`; ảnh song ngữ trong cùng thư mục. Report popup: `test-results/popup-action/report-0.2.0-156-1.json`, `report-0.2.0-156-1.25.json`, `report-0.2.0-156-1.5.json`, `report-0.2.0-141-1.5.json`; ảnh popup thật có cùng prefix phiên bản.

## Giới hạn của bằng chứng và bàn giao

Các lượt của bản 0.2.0 dùng profile mới, dữ liệu tổng hợp và HTTP bị chặn. Không đăng nhập hay dùng Facebook chính; không ghi nhận đây là một lượt kiểm thử Facebook production mới. Các kết quả production ở 0.1.8 và media 0.1.7 bên dưới được giữ riêng làm lịch sử. Story vẫn bị vô hiệu hóa.

Logo gốc: `extension/icons/logo.svg`; bộ tệp riêng: `release/brand/` và `PitoFacebookFixer-Logo.zip`. Icon nhỏ được xuất từ SVG bằng Chromium với scale 1, không phụ thuộc font, không dùng ảnh PitoNote gốc trong gói. Hướng dẫn: `docs/brand-guidelines.md`.

Cập nhật vào cùng thư mục extension, Reload extension rồi tải lại Facebook để nạp bản mới; không gỡ extension nếu cần giữ kho và cài đặt.

---

# Kết quả lịch sử 0.1.9 — sửa popup thực tế

Ngày kiểm tra: 03/11/2026, giờ Việt Nam. Source build: `0.1.9-popup-sizing-v1`.

## Lỗi đã tái hiện và sửa

Bài kiểm tra cũ mở popup.html trong tab thông thường có viewport đặt sẵn, nên không bắt được lỗi tự tính kích thước của popup trên thanh công cụ. Bài mới dùng Chrome Action mở bubble thật trong Chromium có cửa sổ và profile tách biệt, không ép kích thước viewport.

- Trước sửa: width 174 px; client/body 159 px; cột chữ 9,67 px; height chạm 600 px và nội dung dài 1.099 px.
- Sau sửa: width/client/body 400 px; height 584 px; cột chữ 250–250,67 px; nút cài đặt rộng 360 px; không tràn ngang hoặc cuộn dọc trong trạng thái bình thường.
- Bỏ giới hạn max-width theo viewport; đặt width/min-width trên HTML gốc, body theo gốc và min-height để tránh sai số làm tròn scale.

## Kiểm tra trên bản 0.1.9

| Kiểm tra | Kết quả |
|---|---|
| Chromium 156, scale 100%, system/light/dark | 3/3 popup thật đạt |
| Chromium 156, scale 125%, system/light/dark | 3/3 đạt |
| Chromium 156, scale 150%, system/light/dark | 3/3 đạt |
| Chromium 141, scale 150%, system/light/dark | 3/3 đạt |
| Đổi switch rồi đóng cửa sổ popup thật | 12/12 lưu được, đọc lại storage khớp |
| Unit/regression | 41/41 đạt |
| Browser integration, Chromium 141 | Đạt; kho, native bubble, cài đặt và layout |
| Bộ settings-browser | Đạt; popup đóng ngay, hai UI cùng cập nhật, 5 reload, browser restart, revision cũ, giao diện sáng/tối, responsive và bàn phím |

Lượt native cuối chạy sau khi hoàn tất CSS 400 × 584. Các kiểm tra unit/integration/settings của hotfix chạy với phần sửa width; thay đổi cuối bổ sung min-height chống sai số 1 px được kiểm tra lại trong matrix native. Không thay đổi thuật toán kho hoặc capture media; bộ kiểm thử đầy đủ gần nhất của các phần này là 0.1.8 bên dưới, không ghi nhận thành lượt chạy đầy đủ mới cho 0.1.9.

Toàn bộ kiểm tra hotfix dùng profile mới và dữ liệu tổng hợp, chặn HTTP; không mở tài khoản Facebook chính hoặc tài khoản phụ có đăng nhập. Report: `test-results/popup-action/report-156-1.json`, `report-156-1.25.json`, `report-156-1.5.json`, `report-141-1.5.json`. Ảnh native có tên tương ứng trong cùng thư mục. `tests/popup-action.mjs` đã được bổ sung vào verify cho các lần phát hành tiếp theo.

Cập nhật vào cùng thư mục extension và Reload; không gỡ/cài lại để giữ kho và cài đặt.

---

# Kết quả lịch sử 0.1.8

Ngày kiểm tra: 03/11/2026, giờ Việt Nam. Source build: `0.1.8-settings-ui-v1`.

## Kết luận

Đã tái hiện lỗi cũ: thay đổi switch trong popup rồi đóng ngay, không bấm Lưu, giá trị trong storage vẫn là mặc định. Bài kiểm tra thất bại trên bản cũ và đạt sau sửa. Công tắc nay gửi patch lưu ngay; các giới hạn số dùng nút Áp dụng riêng, có trạng thái chưa áp dụng.

Cấu hình được lưu trong `chrome.storage.local`, ghi tuần tự/hợp nhất theo patch, có revision chống phản hồi cũ. Khởi tạo/nâng cấp nằm cùng hàng đợi ghi. MAIN chờ cấu hình trước khi bật tính năng; isolated bridge thử lại nếu lần đọc đầu thất bại. Đổi theme/focus không dọn kho hoặc dựng lại bộ phát voice.

Story bị tạm vô hiệu hóa với nhãn Đang phát triển. Cấu hình cũ bật story không kích hoạt lại; fetch/XHR/WebSocket giữ native và request đánh dấu xem đi qua. Bản này không ẩn lượt xem story.

## Tự động — dữ liệu tổng hợp, profile riêng

Lệnh `npm run verify` trên mã cuối: 41 unit/regression test và cả 11 mục build/integration đều đạt.

| Phạm vi | Kết quả |
|---|---|
| 41 unit/regression test | Đạt: kho, media, hạn tuổi/ngân sách, phân tách tài khoản, quyền nguồn gửi, patch đồng thời và migration/startup |
| Extension integration trên Chromium 141 / Chrome for Testing 156 | 5/5 vòng đạt |
| Đổi switch rồi đóng popup ngay, không bấm Lưu | Giá trị được ghi và còn khi mở options |
| Hai cửa sổ thay đổi các trường khác nhau | Không ghi đè nhau; hai UI đồng bộ đúng |
| Giới hạn 64 MiB, 13 ngày và thời hạn media tùy chỉnh | Lưu qua form, giữ đúng các switch đã tắt |
| Năm lần refresh trang Facebook tổng hợp; cố ý đọc cấu hình chậm 900 ms | Storage, isolated bridge và MAIN cùng đúng cấu hình/revision; không bật guard mặc định trong lúc chờ |
| Đóng/mở lại toàn bộ trình duyệt và service worker cùng profile | Tất cả trường giữ nguyên |
| Bơm phản hồi MAIN từ revision cũ | Không vô hiệu hóa guard của cấu hình mới; kiểm chứng bằng focus thực tế |
| 512 tin, 16 điểm kiểm tra giới hạn kho, đóng/mở lại trình duyệt | Đạt; dữ liệu logic được giữ dưới giới hạn, tin mới nhất vẫn phục hồi đúng |
| 384 tin với background chậm, thu hồi 192 tin cùng đợt | Đạt; đúng nội dung/aliases trước và sau reload |
| Gỡ/chèn riêng, thông báo chia nhiều đợt, metadata trùng, chữ thu hồi đến muộn | Đạt; nhóm mơ hồ không bị ghép đoán |
| Emoji, ảnh, voice ngoài DOM; hash binary, giải mã/phát lại và URL gốc hết hạn | Đạt; alias rescan không ngắt bộ phát |
| Bảo vệ tin thu hồi, hạ ngân sách, hết hạn, dọn riêng loại tệp | Đạt; bảo vệ bản ghi và dừng ghi mới khi cần, không tự tải lại tệp đã dọn |
| Album một ảnh/lần, chuyển nhanh 30 lần, voice tự tải không phát | Đạt, qua reload |
| Bốn trang mới và popup riêng ở sáng/tối | Không lỗi JavaScript; đã xem ảnh chụp |
| 375 / 768 / 1440 px và popup 400 px | Không tràn ngang |
| Space đổi switch, Escape đóng dialog/trả focus, reduced motion | Đạt |
| Tài nguyên UI | Không request HTTP bên ngoài; Lucide bundle cục bộ kèm giấy phép |
| Story đang phát triển | Không bật được trong UI; fetch/XHR native kể cả cài đặt cũ |

Các bài dùng profile mới dưới `test-results/`, route Facebook bằng fixture. Bài media CDN giả được stub ở ranh giới worker fetch; các bước kiểm tra tệp, IndexedDB, JSON/chunk và renderer vẫn chạy mã thật. Không gọi fixture là kiểm chứng production.

Báo cáo: `test-results/verification.json`, `settings-browser-report.json`, `storage-browser-report.json`, `media-browser-report.json`, `bulk-report.json`, `stress-report.json`.

Ảnh UI: `test-results/ui-0.1.8/overview-light.png`, `overview-dark.png`, `storage-light.png`, `storage-dark.png`, `archive-light.png`, `archive-dark.png`, `diagnostics-light.png`, `diagnostics-dark.png`, `popup-light.png`, `popup-dark.png`, `mobile-dark.png`. Dữ liệu trên ảnh UI là tổng hợp.

## Facebook thật — chỉ tài khoản thử nghiệm riêng

Chỉ mở lại profile Chromium QA mà người dùng đã tự đăng nhập và xác nhận trước đó. Không dùng Facebook chính, tab/profile cá nhân hoặc người nhận khác.

- Đổi ngân sách sang 48 MiB và thời gian lưu sang 21 ngày qua giao diện mới.
- Đổi switch giữ ô soạn trong popup rồi đóng ngay, không có bước Lưu.
- Refresh self chat ba lần: cấu hình trên đĩa và cấu hình MAIN áp dụng đều khớp.
- Đóng cửa sổ QA, mở lại cùng profile và cùng build: cấu hình còn nguyên và MAIN áp dụng đúng. Trả lại cấu hình QA ban đầu sau kiểm tra.
- Thử thêm self chat gửi văn bản có mã PFF-QA → IndexedDB commit → thu hồi qua UI → thay chữ trong bong bóng gốc → reload → vẫn đúng nội dung/alias và tooltip nguồn.
- Lượt cuối xác nhận fetch/XHR thực sự native trên Facebook thật sau khi tạm bỏ story. Không dùng tài khoản chính để tự kiểm tra viewer.

Đã có hai lượt kiểm tra cài đặt, mỗi lượt ba reload và một lần khởi động lại QA. Báo cáo lượt cuối: `test-results/live-qa-0.1.8/preferences-live.json`. Smoke test tin nhắn và ảnh: `report.json`, `storage-proof.png`, `restored-message-proof.png` cùng thư mục.

Không khẳng định bản này đã được kiểm chứng bằng hai tài khoản gửi–nhận, mọi biến thể Meta, bộ gõ tiếng Việt thật hoặc hiệu quả ẩn lượt xem story. Các kết quả voice chưa bấm nghe/album trên production được kiểm chứng ở 0.1.7, tiếp tục qua hồi quy tổng hợp ở bản này. Lượt thu hồi chung 12 tin trên Messenger điện thoại đạt ở 0.1.5 là kết quả lịch sử.

## Nghiên cứu thiết kế và cập nhật

Nghiên cứu được ghi trước khi dựng UI: [UI_RESEARCH.md](UI_RESEARCH.md), tham khảo chính chủ Linear, Bitwarden, Fluent 2, Chrome Storage/Popup và WAI; dùng các skill ui-ux-pro-max, design-system, ui-styling. Không sao chép ảnh/nhận diện thương hiệu của các sản phẩm đó.

Cập nhật vào cùng thư mục extension đang dùng, Reload extension rồi tải lại Facebook. Không gỡ/cài lại hoặc đổi thư mục nếu cần giữ nguyên extension ID, kho và cấu hình của bản unpacked. Schema kho vẫn là 4; không thêm quyền extension.
