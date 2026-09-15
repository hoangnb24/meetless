# Packet chuẩn bị đưa Meetless lên Mac App Store

**Trạng thái:** Dự thảo để owner duyệt nội dung. File này không tự mở quyền
ghi metadata, gửi App Review hay phát hành công khai.

Copy để dán vào localization chính của App Store Connect dùng en-US; phần
giải thích và checklist dùng tiếng Việt. Các mục có nhãn **[OWNER INPUT]** là
quyết định hoặc tài liệu thật sự còn thiếu, không điền bằng suy đoán.

## Danh tính bản phát hành

| Trường | Giá trị hiện đã biết | Nguồn / giới hạn |
| --- | --- | --- |
| Tên app | `Meetless` | App Store Connect readback |
| Nền tảng | macOS, candidate Apple silicon | Product matrix; máy ghi âm đã kiểm chứng là macOS 26.4 arm64 |
| Bundle ID | `com.meetless.app` | Distribution manifest |
| App Apple ID | `6807070739` | App Store Connect readback trong execution plan |
| SKU | `meetless-macos-v1` | App Store Connect readback trong execution plan |
| Version / build | `1.0` / `1` | ASC API xác nhận đúng MAC_OS build ngày 2026-09-15 |
| Primary category | Productivity | ASC đã lưu; exact binary đã được kiểm tra khớp category |
| Primary language | English (U.S.) | ASC readback |
| Baseline đóng băng | `production-baseline-2026-09-14` → `6b051116af4dbf8a22337f51b995e120454b79d0` | Tag lịch sử, không tự là release artifact |
| Candidate đã đóng gói | `Meetless-1.0-1.pkg`, SHA-256 `b6f0fde5bf1e80c5254a80e3c0151be4f05f167d7b04bc699700bff7c50b5da7` | `.artifacts/macos-mas-distribution/20260915T003311276Z/` |
| Trạng thái candidate | Upload COMPLETE, binary VALID; TestFlight nội bộ sẵn sàng | API 2026-09-15T02:24:21.516Z; source `41cfc34382f95dcf3b08fca74347cccb673b15be` |

Candidate mới đã qua kiểm tra ký/payload độc lập và Apple validation. Lần
Apple từ chối candidate cũ được giữ trong lịch sử. Upload mới đã thành công
với delivery/build `0816cc3b-8b69-4357-bf0d-32537ec34b8b`; Apple processing đã
hoàn tất. Owner đã duyệt và agent đã lưu khai báo mã hóa chuẩn ngoài macOS,
không phân phối tại Pháp. API xác nhận TestFlight nội bộ READY_FOR_BETA_TESTING;
thử bên ngoài mới ở READY_FOR_BETA_SUBMISSION. Chưa gửi App Review.

## Copy en-US

Giới hạn dưới đây lấy từ tài liệu App Store Connect hiện tại: name/subtitle
30 ký tự, promotional text 170 ký tự, description 4.000 ký tự, keywords 100
bytes. Keyword phải dài hơn hai ký tự và không lặp tên app/company.

### Name — 8 ký tự

```text
Meetless
```

### Subtitle — 27 ký tự

```text
Record, transcribe, and ask
```

### Promotional Text — 165 ký tự

```text
Record meetings on your Mac, keep audio close, and turn recordings into timed transcripts. Ask one meeting at a time, then play the cited moment behind every answer.
```

### Description — 1.075 ký tự

```text
Meetless is a local-first meeting recorder and evidence workspace for Mac.

Record your microphone and system audio while you are in a Zoom or Google Meet call. When you stop, Meetless saves the recording locally. Choose Transcribe when you are ready; cloud processing starts only after that explicit action and the app explains what happens before upload.

Open a meeting to read its complete timed transcript. Ask questions about one meeting at a time, follow answers to cited transcript segments, and play the audio interval behind the evidence. Your saved meeting, source audio, transcript, chat, and citations remain available on your Mac.

Recording, reading meetings, meeting-scoped Ask, and citation playback remain separate from Premium. Premium unlocks Meetless-managed transcription through monthly or annual subscriptions. A seven-day introductory trial may be available when eligible. StoreKit supplies the current price and eligibility.

Meetless keeps the next step clear: record, save, transcribe when you choose, read the evidence, and ask a better question.
```

Copy này bám product contract: không hứa automatic transcription, team
workspace, speaker labels, cross-meeting search, mobile system-audio recording
hay cloud làm source of truth offline.

### Keywords — 95 bytes

```text
meeting recorder,meeting notes,transcript,transcription,voice notes,meeting assistant,citations
```

### What's New

Đây là version đầu nên ASC có thể không bắt buộc trường này. Giữ draft sau
đây nếu ASC yêu cầu:

```text
Meetless V1 brings local-first meeting recording, timed transcripts, meeting-scoped questions, and cited audio playback to Mac.
```

## Copy cho subscription en-US

Product authority đã chốt Premium gồm monthly và annual, trial giới thiệu bảy
ngày khi đủ điều kiện, và chỉ mở Meetless-managed transcription. Giá Mỹ đang
được ghi nhận là `$9.99` monthly và `$79.99` annual; StoreKit vẫn là nguồn giá
và eligibility hiển thị cho khách hàng.

| Gói | Product ID | Display name draft | Description draft | Giá Mỹ đã ghi nhận |
| --- | --- | --- | --- | --- |
| Monthly | `com.meetless.app.premium.monthly` | `Premium Monthly` | `Managed transcription each month` | `$9.99` |
| Annual | `com.meetless.app.premium.annual` | `Premium Annual` | `Managed transcription each month` | `$79.99` |

Hai description draft đều nằm dưới giới hạn 45 ký tự hiện tại của IAP. Các
mô tả cũ trong ADR dài hơn giới hạn này, nên dùng bản ngắn trên khi nhập ASC.
Agent sẽ recheck group, product, offer, availability, Family Sharing và giá
trên ASC trước upload; đó là validation, không phải quyết định mới của owner.

## App Review notes — bản đề xuất

Đây là nội dung để điền sau khi fresh candidate được nghiệm thu. Đổi
“proposed” thành mô tả thực tế sau khi kiểm tra đúng binary; hiện chưa có bằng
chứng StoreKit mới đủ để gọi đây là review path đã pass.

```text
Meetless is a macOS meeting recorder and meeting evidence workspace. No Meetless account is required for the local recording flow.

Proposed review path:
1. Run Meetless on an Apple silicon Mac.
2. Choose “Record meeting”, enter a fictional title such as “Design sync”, and grant Microphone and Screen & System Audio Recording access if macOS asks.
3. Choose “Start recording”, then “Stop”. Stop saves the audio locally; it does not start cloud transcription automatically.
4. Open the saved meeting. Choose “Transcribe” only when ready. Meetless shows its cloud-processing disclosure and requests consent before upload.
5. Open “Transcript” to read the timed segments. In “Ask”, ask a question about the open meeting. Select a cited segment and choose “Play from here” to hear the supporting interval.

Premium review:
- Monthly and annual Premium unlock Meetless-managed transcription. Purchase and Restore purchases are available from the in-app Premium panel.
- Use Apple's StoreKit sandbox flow on the review device. Sandbox transactions do not charge the reviewer. Recheck that the submitted build sees the configured products and that sandbox transactions remain isolated from production data.

Provider-dependent Ask note:
- Ask may require an existing provider-owned configuration and a folder selection through the macOS chooser. Recheck the exact reviewer path on the submitted candidate. If the dependency cannot be reproduced, explain that limitation and use the review video.

Data-flow note:
- Recording, saved audio, meeting records, transcripts, chat, and citations remain available on the Mac.
- Managed transcription sends audio only after the user explicitly chooses Transcribe and accepts the disclosure. Temporary managed audio and provider output are deleted within the documented backend TTL; the local source files remain until the user deletes the recording or meeting.
```

StoreKit sandbox là môi trường test không tính tiền; Apple hướng dẫn dùng
Sandbox Apple Account trên thiết bị khi kiểm thử sản phẩm ASC. Không đặt tài
khoản Apple, mật khẩu hay credential provider vào repo hoặc review note.

## Shot list cho screenshot và app preview

Chưa có asset store nào được packet này nghiệm thu. Engineering/design capture
trên fresh signed candidate bằng dữ liệu hư cấu; không để lộ recording thật,
tên người thật, receipt, API key, host URL hay provider credential.

Mac cần ảnh PNG/JPEG không transparency, một trong các kích thước 16:10
`1280×800`, `1440×900`, `2560×1600`, `2880×1800`; ASC nhận 1–10 ảnh. Đề xuất
dùng 5 ảnh `2880×1800` theo thứ tự sau:

| # | Tên làm việc | Nội dung cần thể hiện |
| --- | --- | --- |
| 1 | Ready to record | Recording setup, title hư cấu, Microphone/System audio, Start recording |
| 2 | Recording in progress | Indicator, elapsed time, Pause và Stop |
| 3 | Audio saved locally | Meeting library, trạng thái saved, Transcribe là thao tác riêng |
| 4 | Read the transcript | Transcript đầy đủ theo thời gian, timestamp/citation có thể phát |
| 5 | Ask with evidence | Ask chỉ trong meeting đang mở, citation và Evidence / Play from here |

App preview là tùy chọn và phải landscape trên macOS. Nếu làm video, quay một
luồng ngắn: Record meeting → Start/Stop → Audio saved locally → disclosure và
Transcribe → transcript → Ask → citation → Play from here. Dùng audio/text hư
cấu; engineering ghi rõ mọi giới hạn permission hoặc provider trong Review
Notes, không dựng giả purchase/transcription thành công.

## Input owner/business/legal còn thiếu

Đây là các mục cần owner hoặc legal cung cấp/chốt; các việc agent có thể
recheck hoặc engineering có thể chuẩn bị không được đưa vào danh sách này.

- **[OWNER INPUT] Seller/developer display name và copyright line:** tên pháp
  lý hiển thị cho khách hàng và năm/nội dung copyright.
- **Website #28 đã xác minh domain cuối:** Marketing URL
  `https://meetless.2m0r.com/`, Support URL `https://meetless.2m0r.com/support/`,
  Privacy Policy URL `https://meetless.2m0r.com/privacy/`. Ba trang và assets trả
  HTTP 200 với bytes đúng source được review; unknown route trả custom 404.
  Browser review độc lập đạt điều hướng và nội dung trên domain cuối.
  Public contact `hoang@2m0r.com`, cá nhân chịu trách nhiệm `Hoang Nguyen Bang`.
  Trạng thái lưu các URL vào ASC được ghi riêng trong active plan; website live
  không tự chứng minh metadata đã được lưu hay App Review đã gửi.
- **[OWNER INPUT] App Review contact:** tên, email, phone và người xử lý thư
  trao đổi với App Review.
- **[OWNER INPUT] Availability, age rating, content rights và DSA/trader
  information nếu áp dụng:** đây là khai báo business/legal của account owner.
- **[OWNER INPUT] App pricing, tax category, Paid Applications Agreement và
  tax/banking status:** xác nhận app miễn phí kèm Premium hay có giá tải riêng,
  rồi hoàn tất các mục business tương ứng.
- **[OWNER INPUT] App Privacy questionnaire:** legal/product owner phân loại
  dữ liệu, mục đích, linkage, tracking, retention và deletion cho audio,
  transcript/chat/citations, cloud transcription, subscription state, device
  enrollment/authentication và diagnostics theo đúng binary cuối.
- **[OWNER INPUT] Wording đồng ý ghi âm và xử lý cloud:** duyệt hướng dẫn phù
  hợp pháp lý cho việc ghi microphone/system audio và gửi recording sau thao tác
  Transcribe. Product contract không thay cho tư vấn pháp lý theo từng vùng.
- **Export compliance đã hoàn tất cho build 1.0 (1):** owner duyệt đúng hai câu
  trả lời về thuật toán chuẩn và France No; server đã ghi nhận. Trước khi gửi
  App Review, đối chiếu storefront thực tế theo quyết định chưa mở Pháp.
- **[OWNER INPUT] Custom EULA nếu muốn dùng:** xác nhận Apple standard license
  hay cung cấp văn bản đã được duyệt.
- **[OWNER INPUT] Quyền sử dụng media:** xác nhận quyền đối với icon,
  screenshot, transcript/text hư cấu, synthetic audio, font và trademark xuất
  hiện trong asset.

## Engineering gates trước khi submit

- Đã tạo và review độc lập fresh isolated package; bốn lỗi `altool` trước đó
  đã được sửa. Actual Apple validation đạt, không lỗi/cảnh báo. Profile,
  entitlement, icon, quyền đọc, chữ ký và signed routing đều được kiểm tra
  trên exact artifact nêu trên.
- ASC đã xác nhận version `1.0` / build `1`, upload COMPLETE và binary VALID.
  Khai báo mã hóa đã mở TestFlight nội bộ. Nhóm Meetless Internal đã có đúng
  build này và một tester được mời theo owner duyệt; còn đường thử bảo toàn dữ liệu. Kết quả này không chứng minh App Review hay billing đã đạt.
- Recheck StoreKit sandbox purchase/restore, routing Sandbox riêng, backend
  review window và Ask path trên exact candidate. Không gọi đó là bằng chứng
  production billing nếu chưa có live evidence.
- Hoàn tất dependency release còn lại của Epic: #14, #15, #16 và **#20**.
  Cấu hình đã accepted và package local không tự chứng minh reboot/focus, live
  billing, webhook delivery hay public publication.

## Nguồn authority

Product behavior lấy từ:

- [Product overview](../product/overview.md)
- [Recording contract](../product/recording.md)
- [Knowledge and citations](../product/knowledge-and-citations.md)
- [Premium and monetization](../product/monetization.md)
- [ADR0005 — Mac App Store and RevenueCat](../decisions/0005-mac-app-store-and-revenuecat.md)
- [Active Epic execution plan](../plans/active/v1-paseo-foundation.md)

Giới hạn metadata và quy trình Apple được đối chiếu ngày 2026-09-15:

- [App information](https://developer.apple.com/help/app-store-connect/reference/app-information/app-information)
- [Platform version information](https://developer.apple.com/help/app-store-connect/reference/app-information/platform-version-information)
- [Screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications)
- [Upload builds](https://developer.apple.com/help/app-store-connect/manage-builds/upload-builds)
- [Submit an app](https://developer.apple.com/help/app-store-connect/manage-submissions-to-app-review/submit-an-app)
- [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)
- [Testing In-App Purchases with sandbox](https://developer.apple.com/documentation/storekit/testing-in-app-purchases-with-sandbox)

Các nguồn Apple chỉ mô tả field và quy trình; chúng không thay cho duyệt
business/legal hoặc bằng chứng Meetless đã qua App Review.
