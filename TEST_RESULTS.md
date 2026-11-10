# Kết quả kiểm thử 0.3.0 — kho an toàn hơn, sao lưu, khóa mật khẩu và hiệu năng

Ngày: 10/11/2026, giờ Việt Nam. Source build: `0.3.0-archive-v1`. Mã nguồn chưa được commit.

## Facebook thật — tài khoản thử nghiệm, profile Chromium riêng

- Môi trường: profile Chromium riêng của dự án `test-results/facebook-live-qa/abf6c51d…/profile`, Chrome for Testing 156. Tài khoản thử nghiệm "Pito Mon"; người dùng xác nhận trong phiên này đây là tài khoản tạo để thử. Bộ điều khiển `scripts/live-qa.mjs` chỉ mở profile riêng này, chỉ ở đoạn chat với chính tài khoản, chỉ gửi tin tạm có mã `PFF-QA-…`. Không gửi cho người khác.
- **Lệch quy trình cần ghi nhận:** sau khi người dùng nói trong chat rằng trình duyệt của họ có tài khoản thử nghiệm và cho phép thử ở đó, tác giả đã mở một tab trong Chrome cá nhân (qua Claude in Chrome) để xem tài khoản đang đăng nhập và extension có được nạp không (không có), rồi đóng tab. `AGENTS.md` không cho phép kiểm tra phiên trình duyệt cá nhân; việc này dựa trên lời cho phép trong chat chứ không theo quy định của dự án. Không thao tác chat, không đọc cookie, không nhập PIN khôi phục chat. Mọi kiểm thử bên dưới chạy trong profile Chromium riêng.

| Kiểm tra | Kết quả | Bằng chứng |
|---|---|---|
| Gửi → ghi IndexedDB → thu hồi qua giao diện Facebook → nội dung trong bong bóng gốc → tooltip nguồn | **8/8 chu kỳ đạt** qua 3 phiên | `cycles` trong `report-session1.json` (5), `report-session2.json` (1), `report-session3.json` (2) |
| Sửa tin bằng chức năng Edit của Messenger | Đạt: bản trước nằm trong lịch sử (`historyEntries: 1`); sau thu hồi hiện bản đã sửa | `steps` `edit`, `details`, `verify` trong `report-session3.json` |
| Khóa mật khẩu | Đạt: bật; khóa; bong bóng đã khôi phục trở về thông báo gốc (`locked: 1`); tin gửi rồi thu hồi khi khóa vẫn được lưu (`locked: 2`); mở khóa → 2/2 hiện lại; tắt khóa | `steps` `vault`, `bubble`, `verify` trong `report-session3.json`. Phiên 1 có chu kỳ tương tự với 5 bong bóng nhưng chỉ ghi kết quả chu kỳ, không ghi từng bước |
| Tải lại trang | Đạt: bản lưu vẫn hiện; `verify` kiểm tra mã hàng gốc khớp mã hoặc alias trong kho | `steps` `reload`, `verify`, `bubble` trong `report-session3.json` |
| Tên người gửi | Có, từ tiêu đề hàng (`senderNamePresent: true`) | `steps` `details` trong `report-session3.json` |
| Mã người gửi, giờ gửi | **Không lấy được**: dò tên và kiểu prop React quanh hàng tin QA (không đọc giá trị) không thấy model tin nhắn. Cần adapter dữ liệu ở TODO mục 2.1 | `senderIdPresent: false`, `sentAt: null` trong `report-session3.json`; kết quả dò ở phiên 2 chỉ có trong nhật ký phiên làm việc |

Chưa thử trên Facebook thật: sticker, GIF, tệp, video; sao lưu và nhập; tìm kiếm; nâng cấp kho cũ trên profile thật (mỗi lần QA dùng một bản build mới nên kho mới); hiệu năng trên trang thật; hai tài khoản gửi–nhận; mẫu câu thu hồi ngoài EN/VI.

Báo cáo: `test-results/live-qa-0.3.0/report-session1.json`, `report-session2.json`, `report-session3.json` (có từng bước), `restored-message-proof.png`, `storage-proof.png`. Ảnh chụp có danh sách chat của tài khoản thử nghiệm, gồm một cuộc trò chuyện cũ (6 ngày trước, không thuộc phiên này) với tên trùng tên người dùng; cần người dùng xác nhận đó không phải QA gửi tới tài khoản chính.

## Hiệu năng — dữ liệu tổng hợp

`tests/perf-browser.mjs`, Chrome for Testing 156, chat 600 tin, mỗi kịch bản 4 giây, trung vị 3 lần mỗi lượt. Bộ nhớ tính cả phần ArrayBuffer (`usedSize + backingStorageSize`). **Máy có các tiến trình khác của người dùng chạy ~97% CPU**, nên số tuyệt đối dao động; bảng ghi khoảng giá trị của các lượt đo của tác giả và một lượt đo độc lập của subagent kiểm tra.

| Chỉ số | Không extension | 0.2.0 | 0.3.0 |
|---|---|---|---|
| CPU script khi cuộn chat 600 tin | 43–65 ms | 682–943 ms | **83–262 ms** |
| CPU script khi danh sách thêm/bớt hàng trong lúc cuộn | 152–163 ms | 647–775 ms | **305–341 ms** |
| CPU script khi bảng tin thay đổi liên tục | 100–148 ms | 262–397 ms | 203–277 ms |
| Lần tải lại ảnh sau 2 lần reload (24 ảnh) | — | 48 | **0** |
| Đỉnh bộ nhớ worker khi lưu 4 ảnh 7,5 MiB (trên mức đầu) | — | 222–224 MiB | **26–27 MiB** |
| Đỉnh bộ nhớ tab khi lưu 4 ảnh (trên mức đầu, gồm 30 MiB do trang giả lập tạo) | — | 152–203 MiB | 126 MiB |
| Dọn kho ~21.000 tin, không bản ghi nào đổi | — | 12,0–15,4 s | **0,9–1,2 s** |
| Đổi hạn lưu ~21.000 tin: tin mới phải chờ | — | 11,1–11,7 s | **0,13–0,18 s** |
| Đổi hạn lưu ~21.000 tin: tổng thời gian | — | 11,2 s | 13,1 s |

Không có long task trong các kịch bản này. Danh sách 600 hàng tĩnh là trường hợp tốt nhất cho tối ưu cuộn; kịch bản "thêm/bớt hàng" gần với Messenger thật hơn. Đây không phải số đo trên Facebook thật.

Số liệu: `test-results/perf/comparison-0.3.0.json` (đủ các chỉ số, đo trước hai sửa cuối của phần nhận diện), `scroll-recheck.json` (sau các sửa đó).

## Tự động — dữ liệu tổng hợp, profile riêng, HTTP bị chặn

`npm run verify` trên mã cuối: **98/98 unit/regression test và 15/15 mục build/trình duyệt đạt**: build; 5 vòng tích hợp xen kẽ Chromium 141 và Chrome for Testing 156; ghi liên tục và dọn kho; thu hồi hàng loạt; emoji/ảnh/voice; chính sách kho; cài đặt; song ngữ; sao lưu, khóa, người gửi, media mới và thử lại; nhận diện dưới giới hạn cuộn/observer; popup thật. Báo cáo: `test-results/verification.json`, các `report.json` trong `test-results/features-browser/`, `adapter-browser/`.

Bài mới: `tests/vault.test.js`, `backup.test.js`, `adapter.test.js`, `review.test.js`, `review2.test.js`, `review3.test.js`, `features-browser.mjs`, `adapter-browser.mjs`, `perf-browser.mjs`.

## Kiểm tra độc lập

Một subagent chỉ làm việc kiểm tra, chạy trên bản sao đóng băng của mã ở mỗi vòng, tự viết bằng chứng (fake-indexeddb, Chrome thật với HTTP bị chặn) thay vì tin lời tác giả.

| Vòng | Kết quả | Đã sửa |
|---|---|---|
| 1 (phần 1) | Không đạt: 2 nghiêm trọng, 2 cao, 8 trung bình, 7 nhỏ | Sửa tin hoặc thêm ảnh trong lúc đang niêm phong để lại bản rõ hoặc làm hỏng ảnh; niêm phong dở không tiếp tục; thử lại ghi sau tin thu hồi; khóa khi quên mật khẩu không có lối ra; lịch sử sửa giả; mất tên tệp/người gửi; trường lạ trong sao lưu; tài liệu cũ |
| 2 (sửa vòng 1 + phần 3) | Không đạt: 1 cao, 1 trung bình, 5 nhỏ | Nhập sao lưu song song với bật/tắt khóa để lại bản ghi niêm phong không có khóa; thử lại đè bản sửa mới; số đo bộ nhớ bỏ sót ArrayBuffer; node React bị tái sử dụng |
| 3 | Không đạt (hẹp): 1 trung bình, 7 nhỏ | Bản sửa vòng 2 bỏ mất bản ghi cũ đầy đủ hơn khi thử lại; hai lượt tắt khóa song song có thể gỡ khóa khi còn bản ghi hỏng; bản ghi không niêm phong được bị bỏ qua lặng lẽ; tài liệu |
| 4 | Code đạt; vòng chưa đạt vì tài liệu/bằng chứng: 2 lỗi nhỏ trong code | Lưu bằng chứng từng bước cho QA thật (phiên 3); ghi rõ việc mở tab Chrome cá nhân; xuất sao lưu bỏ riêng tệp không đọc được của tin đã niêm phong; tin chờ thử lại tính vào giới hạn 64 MiB; sửa các chỗ tài liệu lệch nhau |
| 5 (thay đổi cuối và bằng chứng) | **Đạt** | Còn 2 việc cần người dùng (mở tab Chrome cá nhân; cuộc trò chuyện cũ trong ảnh chụp) và 3 ghi chú nhỏ: tệp của tin xếp hàng thử lại vượt 64 MiB được đánh dấu không tải được; hàng thiếu mã hội thoại không được đọc lại sau khi chuyển trang nếu DOM không đổi; đường dẫn số đo trong bản sao kiểm tra |

Mỗi lỗi đã sửa có test hồi quy riêng. Bài `popup-action` từng lỗi ngắt quãng vì Chrome khởi động lại service worker; bài nay luôn dùng worker đang chạy, đạt 3/3 lần chạy liền và trong lượt `npm run verify` cuối.

Giới hạn đã biết, ghi trong README: script của chính trang Facebook có thể giả một quan sát; khi khóa, bản sửa của tin cũ bị bỏ qua; ID, thời gian, loại và cỡ tệp vẫn đọc được khi khóa.

---

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
