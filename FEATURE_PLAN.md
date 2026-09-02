# Photo Booth Beauty Features Plan

## 1. Mục tiêu

Xây dựng pipeline làm đẹp khuôn mặt chạy trực tiếp trên web, ưu tiên:

- Không sử dụng SDK beauty trả phí.
- Xử lý tại thiết bị, không tải hình khuôn mặt lên máy chủ.
- Preview camera mượt và kết quả ảnh chụp đủ chất lượng để in.
- Hiệu ứng tự nhiên, ổn định khi người dùng di chuyển hoặc thay đổi biểu cảm.
- Cho phép bật/tắt và điều chỉnh cường độ từng hiệu ứng độc lập.

## 2. Stack kỹ thuật

- React + TypeScript + Vite cho ứng dụng web.
- MediaDevices API (`getUserMedia`) để lấy hình ảnh từ camera.
- MediaPipe Face Landmarker để lấy landmark khuôn mặt, biểu cảm và ma trận hướng đầu.
- WebGL2 + GLSL để làm mịn, điều chỉnh màu và biến dạng hình ảnh bằng GPU.
- Canvas 2D để ghép template, sticker và xuất ảnh cuối.
- Web Worker + OffscreenCanvas khi trình duyệt hỗ trợ để giảm tải main thread.
- Zustand để lưu cấu hình beauty của phiên chụp.
- IndexedDB + Dexie.js để lưu preset và tài nguyên sticker cục bộ.

## 3. Kiến trúc xử lý chung

```text
Camera frame
  -> Face Landmarker
  -> Landmark smoothing
  -> Face regions/masks
  -> Geometry deformation pass
  -> Skin and color passes
  -> Makeup pass
  -> Sticker/AR pass
  -> Realtime preview
  -> High-resolution capture renderer
  -> Template compositor
  -> Download/print
```

Pipeline cần tách thành hai chế độ:

1. **Preview:** ưu tiên tốc độ, có thể xử lý ở độ phân giải thấp hơn camera.
2. **Final capture:** chạy lại hiệu ứng trên ảnh gốc độ phân giải cao trước khi ghép template và in.

Không được dùng ảnh chụp màn hình preview làm ảnh in cuối.

## 4. Thành phần dùng chung cần triển khai trước

### 4.1 Camera Manager

- Liệt kê camera khả dụng.
- Chọn camera và độ phân giải.
- Khởi động, dừng và phục hồi camera khi mất kết nối.
- Chuẩn hóa xoay, lật gương và tỷ lệ khung hình.
- Cung cấp frame cho pipeline preview và ảnh gốc cho final capture.

### 4.2 Face Tracking

- Khởi tạo MediaPipe Face Landmarker một lần khi vào màn hình chụp.
- Hỗ trợ tối thiểu một khuôn mặt; thiết kế API để có thể mở rộng nhiều khuôn mặt.
- Xuất landmark chuẩn hóa, độ tin cậy và hướng đầu.
- Bỏ qua hiệu ứng hình học khi độ tin cậy thấp.
- Hiển thị trạng thái hướng dẫn nếu không thấy mặt hoặc mặt quá gần mép ảnh.

### 4.3 Landmark Smoothing

- Dùng exponential moving average hoặc One Euro Filter.
- Điều chỉnh smoothing theo vận tốc chuyển động.
- Reset bộ lọc khi mất mặt hoặc đổi người.
- Giảm rung ở đường hàm, mắt, môi và vị trí sticker.

### 4.4 Face Mesh và Mask Generator

- Tạo tam giác mesh từ landmark ổn định.
- Tạo mask cho da, mắt, lông mày, môi và vùng dưới mắt.
- Feather biên mask để không xuất hiện đường cắt.
- Loại trừ mắt, lông mày, lỗ mũi và môi khỏi mask làm mịn da.
- Cache topology; chỉ cập nhật vị trí vertex theo từng frame.

### 4.5 Beauty Settings

```ts
type BeautySettings = {
  skinSmoothing: number;
  skinBrightness: number;
  vLine: number;
  slimFace: number;
  eyeSize: number;
  darkCircleRemoval: number;
  lipstick: number;
  blush: number;
  stickerEnabled: boolean;
};
```

- Giá trị hiệu ứng dùng thang `0-100` tại UI.
- Chuyển đổi sang khoảng an toàn riêng của shader trước khi render.
- Có nút tắt toàn bộ beauty và nút khôi phục mặc định.
- Lưu preset mặc định của cửa hàng bằng IndexedDB.

## 5. Kế hoạch theo feature

### F01 — Làm mịn da

**Đầu vào**

- Landmark khuôn mặt.
- Face/skin mask đã loại trừ mắt, môi, lông mày và lỗ mũi.
- Frame camera gốc.

**Xử lý**

- Tạo skin mask có feather.
- Áp dụng bilateral blur hoặc edge-preserving blur bằng WebGL shader.
- Trộn ảnh đã blur với ảnh gốc theo cường độ.
- Giữ lại chi tiết cạnh, mắt, tóc, môi và đường nét chính.
- Thêm một lượng texture gốc tối thiểu để tránh hiệu ứng da nhựa.

**Điều khiển UI**

- Slider `Mịn da`, mặc định 25-30.
- Khoảng hiệu lực nên giới hạn để mức 100 vẫn không phá hủy hoàn toàn texture.

**Tiêu chí nghiệm thu**

- Không làm nhòe mắt, môi, tóc hoặc đường viền khuôn mặt.
- Không xuất hiện viền mask khi người dùng quay đầu.
- Mụn/texture nhỏ được giảm nhưng cấu trúc mặt vẫn rõ.
- Preview và ảnh final cho cảm nhận tương đương.

### F02 — Sáng da

**Đầu vào**

- Skin mask.
- Thông tin màu và độ sáng của vùng da.

**Xử lý**

- Điều chỉnh exposure nhẹ trong vùng da.
- Điều chỉnh midtone thay vì tăng toàn bộ RGB tuyến tính.
- Bảo vệ highlight để tránh cháy trán và má.
- Có thể chỉnh nhẹ saturation/warmth nhưng không làm đổi tông da bất thường.

**Điều khiển UI**

- Slider `Sáng da`, mặc định 8-12.

**Tiêu chí nghiệm thu**

- Da sáng tự nhiên dưới ánh sáng photobooth.
- Không làm trắng mắt, răng, tóc hoặc nền.
- Không clipping vùng highlight trên ảnh final.
- Kết quả ổn định giữa các frame, không nhấp nháy màu.

### F03 — Cằm V-line

**Đầu vào**

- Landmark hàm, má và cằm.
- Face mesh.

**Xử lý**

- Dịch nhẹ các vertex hai bên hàm về trục giữa khuôn mặt.
- Có thể kéo điểm cằm xuống một khoảng rất nhỏ.
- Nội suy trọng số biến dạng sang vùng lân cận.
- Neo vùng mắt, mũi, miệng và biên ngoài để giảm méo nền.
- Giảm cường độ khi khuôn mặt quay nghiêng quá mức.

**Điều khiển UI**

- Slider `V-line`, mặc định 5-10.

**Tiêu chí nghiệm thu**

- Hai bên hàm biến dạng cân đối khi mặt nhìn thẳng.
- Không tạo cằm nhọn bất thường ở mức mặc định.
- Không bẻ cong rõ rệt tóc, vai hoặc nền gần khuôn mặt.
- Không giật mesh khi người dùng nói hoặc cười.

### F04 — Mặt thon

**Đầu vào**

- Landmark đường viền mặt và hai bên má.
- Face mesh.

**Xử lý**

- Đẩy vùng má trái/phải về trục giữa theo falloff mềm.
- Tính biến dạng theo chiều rộng khuôn mặt thay vì pixel cố định.
- Giữ nguyên khoảng cách mắt, mũi và miệng.
- Kết hợp có giới hạn với V-line để tổng biến dạng không vượt ngưỡng an toàn.

**Điều khiển UI**

- Slider `Thon mặt`, mặc định 8-12.

**Tiêu chí nghiệm thu**

- Mặt nhỏ gọn nhưng đặc điểm nhận dạng không thay đổi quá mức.
- Không làm méo tai, tóc và nền ở mức mặc định.
- V-line và mặt thon hoạt động đồng thời mà không cộng dồn quá mạnh.

### F05 — Mắt to

**Đầu vào**

- Landmark mí mắt, khóe mắt và tâm mắt.

**Xử lý**

- Áp dụng radial/localized warp quanh từng mắt.
- Scale theo kích thước mắt thực tế.
- Dùng falloff mềm để không kéo lông mày, sống mũi hoặc tóc.
- Giảm hoặc tạm dừng biến dạng khi mắt nhắm mạnh.

**Điều khiển UI**

- Slider `Mắt to`, mặc định 3-6.

**Tiêu chí nghiệm thu**

- Hai mắt được xử lý độc lập và cân đối.
- Không làm méo đồng tử hoặc khóe mắt rõ rệt.
- Không rung khi chớp mắt.

### F06 — Xóa quầng thâm

**Đầu vào**

- Landmark quanh mắt.
- Mẫu màu da lân cận vùng dưới mắt.

**Xử lý**

- Tạo mask cong mềm dưới từng mắt, tránh đi vào nhãn cầu.
- Nâng midtone và giảm sắc xanh/tím/nâu có kiểm soát.
- Tham chiếu màu da vùng má gần nhất thay vì dùng màu cố định.
- Feather mạnh để không tạo mảng sáng rõ biên.

**Điều khiển UI**

- Slider `Quầng thâm`, mặc định 10-15.

**Tiêu chí nghiệm thu**

- Giảm vùng tối mà không tạo hai dải trắng dưới mắt.
- Không thay đổi màu nhãn cầu hoặc eyeliner.
- Hoạt động hợp lý với nhiều tông da và điều kiện ánh sáng.

### F07 — Son môi

**Đầu vào**

- Landmark môi ngoài và môi trong.
- Màu son, độ trong suốt và preset chất liệu.

**Xử lý**

- Tạo polygon/mask cho môi ngoài và loại trừ phần miệng mở.
- Feather biên môi ở mức nhỏ.
- Blend màu theo luminance gốc để giữ texture và highlight.
- Preset đầu tiên: tự nhiên, đỏ, hồng và cam đất.

**Điều khiển UI**

- Slider cường độ và danh sách màu son.
- Mặc định tắt hoặc dùng mức rất nhẹ.

**Tiêu chí nghiệm thu**

- Son bám theo môi khi nói và cười.
- Không tô lên răng hoặc phần miệng mở.
- Giữ được nếp môi, ánh sáng và độ bóng tự nhiên.

### F08 — Má hồng

**Đầu vào**

- Vị trí má suy ra từ landmark mắt, mũi và đường viền mặt.
- Màu má hồng và cường độ.

**Xử lý**

- Tạo hai gradient ellipse theo hướng của khuôn mặt.
- Scale và xoay gradient theo pose khuôn mặt.
- Blend màu bằng soft-light/overlay có giới hạn.
- Giảm cường độ khi má bị che khuất hoặc khuôn mặt quay nghiêng.

**Điều khiển UI**

- Slider cường độ và preset màu.
- Mặc định tắt hoặc dùng mức rất nhẹ.

**Tiêu chí nghiệm thu**

- Hai vùng má cân đối khi nhìn thẳng.
- Gradient không có biên rõ.
- Màu không tràn sang mũi, mắt hoặc nền.

### F09 — Sticker/AR

**Đầu vào**

- Landmark khuôn mặt.
- Hướng đầu hoặc transformation matrix.
- Asset sticker PNG/WebP hoặc sprite animation.

**Xử lý**

- Định nghĩa anchor cho từng loại sticker: đầu, mắt, mũi, má hoặc miệng.
- Scale theo khoảng cách landmark và xoay theo hướng đầu.
- Hỗ trợ offset, scale, rotation và layer order trong metadata của sticker.
- Bản đầu hỗ trợ sticker 2D; 3D là giai đoạn sau.
- Preload asset để không giật khi đổi sticker.

**Điều khiển UI**

- Danh sách sticker có thumbnail và lựa chọn `Không dùng`.
- Cho phép cửa hàng thêm bộ sticker qua manifest cục bộ.

**Tiêu chí nghiệm thu**

- Sticker bám ổn định khi đầu di chuyển và xoay nhẹ.
- Đúng tỷ lệ ở các khoảng cách khác nhau với camera.
- Asset trong suốt hiển thị đúng và không làm giảm đáng kể FPS.
- Sticker xuất hiện giống nhau trong preview và ảnh final.

## 6. Thứ tự triển khai

### Milestone 1 — Camera và nền tảng tracking

- Camera Manager.
- MediaPipe Face Landmarker.
- Landmark Smoothing.
- WebGL renderer cơ bản.
- Chế độ debug hiển thị landmark, FPS và thời gian inference/render.

### Milestone 2 — Beauty cơ bản

- F01 Làm mịn da.
- F02 Sáng da.
- Preset và slider cường độ.
- Render lại ảnh chụp ở độ phân giải cao.

### Milestone 3 — Chỉnh hình khuôn mặt

- Face mesh deformation engine.
- F03 Cằm V-line.
- F04 Mặt thon.
- F05 Mắt to.
- Giới hạn tổng biến dạng và kiểm tra méo nền.

### Milestone 4 — Beauty chi tiết

- F06 Xóa quầng thâm.
- F07 Son môi.
- F08 Má hồng.
- Preset makeup tự nhiên.

### Milestone 5 — AR và hoàn thiện

- F09 Sticker/AR 2D.
- Quản lý asset và manifest sticker.
- Tối ưu hiệu năng, xử lý lỗi camera và mất tracking.
- Kiểm thử trên phần cứng photobooth thực tế.

## 7. Ngân sách hiệu năng

- Mục tiêu preview: 30 FPS ổn định ở 720p trên máy kiosk mục tiêu.
- Face inference có thể chạy 20-30 lần/giây; render sử dụng landmark gần nhất giữa các lần inference.
- Không tạo object/texture/buffer mới ở mỗi frame nếu có thể tái sử dụng.
- Theo dõi riêng thời gian camera copy, inference, mask generation và GPU render.
- Giảm độ phân giải inference trước khi giảm độ phân giải preview.
- Final capture có thể chậm hơn preview nhưng mục tiêu hoàn tất trong khoảng 1 giây.

## 8. Khả năng tương thích và fallback

- Trình duyệt mục tiêu chính: Chrome/Edge phiên bản ổn định mới trên Windows.
- Yêu cầu HTTPS hoặc localhost để truy cập camera.
- Nếu WebGL2 không khả dụng: tắt beauty và vẫn cho phép chụp ảnh thường.
- Nếu mất tracking: giữ frame ngắn trong giới hạn an toàn, sau đó giảm hiệu ứng về 0 thay vì đóng băng mesh lâu.
- Nếu máy yếu: giảm tần suất inference, tắt các pass ít quan trọng hoặc giảm độ phân giải preview.

## 9. Kiểm thử

### Functional

- Bật/tắt độc lập từng hiệu ứng.
- Kết hợp tất cả hiệu ứng mà không lỗi render.
- Reset về mặc định giữa hai phiên khách hàng.
- Đổi camera và khởi động lại camera.
- Xuất ảnh final đúng chiều, không bị mirror sai.

### Visual quality

- Nhiều tông da, giới tính và độ tuổi.
- Có/không trang điểm, kính, tóc che mặt và râu.
- Ánh sáng mạnh, yếu và lệch màu.
- Nhìn thẳng, quay trái/phải, cúi/ngẩng, cười và nhắm mắt.
- Một và nhiều người trong khung hình.

### Performance

- Chạy liên tục tối thiểu 2 giờ để phát hiện memory leak.
- Theo dõi FPS, CPU, GPU và bộ nhớ.
- Chụp liên tục nhiều phiên mà không tăng thời gian xử lý.
- Kiểm thử đúng model máy tính và camera dùng tại cửa hàng.

## 10. Definition of Done chung

Một feature được xem là hoàn thành khi:

- Có UI điều chỉnh và có thể tắt hoàn toàn.
- Hoạt động trong cả preview và final capture.
- Không lưu hoặc gửi dữ liệu khuôn mặt ngoài thiết bị.
- Không tạo artifact nghiêm trọng tại biên mask/mesh.
- Đạt ngân sách hiệu năng trên phần cứng kiosk mục tiêu.
- Có test cho logic cấu hình và ít nhất một bộ ảnh/video regression trực quan.
- Có fallback an toàn khi không phát hiện được khuôn mặt.

## 11. Rủi ro chính

- **Méo nền khi chỉnh mặt:** giới hạn phạm vi warp, neo vertex ngoài mặt và giảm cường độ mặc định.
- **Rung landmark:** sử dụng temporal smoothing và reset đúng lúc khi mất tracking.
- **Da nhựa:** giữ texture gốc, bảo vệ cạnh và giới hạn smoothing.
- **Sai màu da:** xử lý midtone/highlight riêng, kiểm thử nhiều tông da và ánh sáng.
- **Preview khác ảnh in:** dùng chung tham số và thuật toán, render lại trên ảnh gốc thay vì upscale preview.
- **GPU yếu:** thiết kế quality tier và tắt từng pass theo mức ưu tiên.
- **Nhiều khuôn mặt:** MVP có thể ưu tiên một mặt; UI phải thông báo rõ và kiến trúc không khóa khả năng mở rộng.

## 12. Phạm vi MVP đề xuất

MVP đầu tiên chỉ bao gồm:

- Camera preview và chụp ảnh độ phân giải cao.
- Theo dõi một khuôn mặt.
- Làm mịn da.
- Sáng da.
- Cằm V-line.
- Mặt thon.
- Slider, preset mặc định và nút tắt beauty.
- Ghép template và xuất ảnh.

Mắt to, quầng thâm, son môi, má hồng và Sticker/AR triển khai sau khi pipeline MVP đạt chất lượng và hiệu năng yêu cầu.
