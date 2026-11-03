# Nghiên cứu và quyết định UI/UX — 0.1.8

## Bổ sung 0.2.0 — English/Việt và logo

Theo yêu cầu mới, English là mặc định độc lập với ngôn ngữ trình duyệt; nút EN/VI đặt sát nút theme ở cả hai header. Bản dịch tách khỏi DOM và nội dung tin nhắn; chuỗi tĩnh, trạng thái động, aria/tooltip, số và ngày đều có catalog hoặc locale tương ứng. Đổi ngôn ngữ giữ nguyên bản nháp giới hạn và phần tử media đang phát. Popup được đo lại bằng Chrome Action thật ở cả hai ngôn ngữ, ba theme và các mức scale.

Logo tham khảo trực tiếp ảnh PitoNote do người dùng cung cấp: nền kem bo góc, mảng vàng và P màu tối. PitoFacebookFixer dùng bong bóng hội thoại thay cho chi tiết giấy ghi chú, tạo khác biệt trong cùng nhận diện Pito. Logo được vẽ bằng SVG, xuất PNG 16–512 px, dùng chung cho toolbar và UI; không nhúng ảnh tham khảo gốc. Thông số và cách dùng nằm trong [hướng dẫn nhận diện](docs/brand-guidelines.md).

Ngày nghiên cứu: 03/11/2026. Nghiên cứu hoàn tất trước khi thay giao diện.

## Nguồn tham khảo

| Nguồn gốc | Điều quan sát | Áp dụng vào PitoFacebookFixer |
|---|---|---|
| [Linear: Personalized sidebar and new settings pages](https://linear.app/changelog/2024-12-18-personalized-sidebar) | Chia cài đặt theo mục đích; xem tóm tắt rồi mở cấu hình chi tiết | Điều hướng cố định: Tổng quan, Lưu trữ, Bản lưu, Chẩn đoán. Tách số liệu kỹ thuật khỏi thao tác thường ngày |
| [Bitwarden: Bringing intuitive workflows and visual updates](https://bitwarden.com/en-gb/blog/bringing-intuitive-workflows-and-visual-updates-to-the-bitwarden-browser/) | Nhóm nội dung theo ngữ nghĩa; popup hỗ trợ tác vụ nhanh; ưu tiên mật độ vừa phải, màu sáng/tối và không gian đọc | Popup riêng, không thu nhỏ nguyên trang cài đặt. Công tắc nhanh, tóm tắt kho và lối mở cài đặt. Trang đầy đủ dùng hàng cấu hình rõ ràng và khoảng cách nhất quán |
| [Fluent 2: Switch usage](https://fluent2.microsoft.design/components/web/react/core/switch/usage) | Switch có tác dụng ngay, nhãn rõ ràng; thao tác cần gửi form phải thể hiện điều đó | Công tắc lưu ngay, báo đang lưu/đã lưu/lỗi. Các giới hạn số có nút Áp dụng rõ ràng vì có thể làm dọn dữ liệu |
| [Chrome: Add a popup](https://developer.chrome.com/docs/extensions/develop/ui/add-popup) | Popup tự đóng khi người dùng click ra ngoài | Không buộc người dùng nhớ nút Lưu sau khi bật/tắt. Gửi yêu cầu lưu ngay trong sự kiện change |
| [Chrome: Storage API](https://developer.chrome.com/docs/extensions/reference/api/storage) | Storage bất đồng bộ; dùng onChanged đồng bộ các ngữ cảnh; chờ tải xong dữ liệu trước khi dùng | Một nguồn cấu hình trong storage.local, lưu patch tuần tự, không dùng mặc định để bật tính năng trong lúc chờ cấu hình. Đồng bộ popup/options/tab, có phiên bản chống phản hồi cũ |
| [WAI: Switch pattern](https://www.w3.org/WAI/ARIA/apg/patterns/switch/) | Giữ tên điều khiển ổn định và có ngữ nghĩa bật/tắt, hỗ trợ bàn phím | Input native với role switch, label và mô tả; focus rõ; trạng thái không chỉ dựa vào màu |

## Các vấn đề của bản cũ

- Switch trông như đã áp dụng nhưng chỉ đổi form; phải bấm Lưu, dễ mất thay đổi khi popup tự đóng.
- Script MAIN dùng các giá trị bật mặc định trước khi lấy xong cấu hình; lỗi đọc cấu hình không có đường thử lại.
- Khởi tạo background có bước đọc rồi ghi lại settings ngoài hàng đợi ghi; cần ngăn việc ghi đè cấu hình mới bằng kết quả đọc cũ.
- Trang cài đặt dùng nhiều khối cùng độ nổi, đoạn giới thiệu lớn và toàn bộ chẩn đoán lộ ngay. Popup tái sử dụng cùng HTML, khiến thao tác đơn giản bị kéo dài.

## Hướng thiết kế được chọn

Giao diện công cụ gọn, trung tính; nền xám nhẹ, điểm nhấn indigo, kiểu chữ hệ thống hỗ trợ tiếng Việt, icon nét nhất quán. Không dùng hero quảng cáo hoặc hình trang trí. Bản tối dùng cùng hệ token và cấu trúc.

- Tổng quan: trạng thái, công tắc dùng thường xuyên, dung lượng kho và chỉ số chính.
- Lưu trữ: ngân sách, tuổi tin, bảo vệ tin thu hồi, tùy chọn media; thao tác dọn nằm trong khu vực riêng và mở hộp xác nhận.
- Bản lưu: nội dung trước, thời điểm sau; mã kỹ thuật nằm trong phần mở rộng.
- Chẩn đoán: kết nối và các bộ đếm khi cần xử lý lỗi.
- Story: không bật được, nhãn Đang phát triển; đường chặn request tạm ngưng kể cả cấu hình cũ đang bật.
- Popup: 3 công tắc chính, trạng thái lưu ngay, kho tóm tắt, mở trang cài đặt.

## Tiêu chí nghiệm thu

1. Đổi switch trong popup rồi đóng ngay, refresh Facebook nhiều lần, mở lại popup/options: cùng giá trị đã ghi.
2. Hai cửa sổ cài đặt cập nhật các trường khác nhau không ghi đè nhau; phản hồi cũ không đảo ngược cấu hình mới.
3. Service worker khởi động lại vẫn đọc đúng cấu hình; trước khi cấu hình sẵn sàng không tự bật tính năng mặc định.
4. Bản sáng/tối, 375/768/1440 px và popup không tràn ngang; Tab/Space/Enter/Escape, focus và thông báo trạng thái hoạt động.
5. Các bài thu hồi tin, album, voice, giới hạn kho, quyền nguồn gửi vẫn đạt. Fixture tách biệt với kiểm tra Facebook thật và không dùng tài khoản chính.

Skill dùng: ui-ux-pro-max, design-system (token ba lớp), ui-styling (thành phần, trạng thái và khả năng truy cập). Giữ mã extension vanilla và bundle cục bộ; không tải tài nguyên giao diện từ CDN lúc chạy.
