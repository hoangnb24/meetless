# Kiểm kê dữ liệu Meetless

Tài liệu kỹ thuật chuẩn bị rà soát App Privacy và Privacy Policy cho Epic 21/#17.
Phạm vi là code và tài liệu được chấp nhận trong repo; không đọc dữ liệu người dùng,
secret, `.env`, hay gọi production/provider. Đây chưa phải câu trả lời App Privacy:
chưa kết luận nhóm dữ liệu, liên kết danh tính, Tracking, hay thời hạn của bên thứ
ba.

> **Evidence pin:** đối tượng binary được đối chiếu là packaged candidate từ source
> commit `41cfc34382f95dcf3b08fca74347cccb673b15be`. File inventory này được tạo
> sau candidate; các endpoint deployment bên dưới là checkpoint cấu hình/deployment,
> không phải suy luận từ code.

## Ranh giới sản phẩm đã chấp nhận

- Meetless giữ meetings, recordings, transcript segments, chat threads và
  citations trong vùng dữ liệu của Meetless; Paseo chỉ là lớp tích hợp
  (`docs/product/overview.md:29-38`,
  `docs/decisions/0003-meetless-runtime-isolation-and-host-ownership.md:46-53`).
- Ghi âm và xử lý chuẩn bị diễn ra trên desktop. Upload/transcription được gọi
  riêng sau thao tác **Transcribe**, cùng disclosure và consent; Stop chỉ lưu âm
  thanh cục bộ (`docs/product/recording.md:34-54`,
  `docs/product/monetization.md:17-43`).
- Bản MAS đặt writable product state trong app container, trừ nơi người dùng
  chọn để export (`docs/decisions/0005-mac-app-store-and-revenuecat.md:212-228`).

## Inventory theo luồng dữ liệu

| Nhóm dữ liệu | Nội dung và đích xử lý đã chứng minh | Mục đích | Lưu giữ/xóa trong Meetless |
| --- | --- | --- | --- |
| **Meeting, recording và audio cục bộ** | Meeting có `id`, tiêu đề, trạng thái và thời điểm. Recording có thời điểm, trạng thái, nguồn microphone/system audio, chunk WAV, phạm vi thời gian, sample metadata, digest và saved-output identity; nội dung audio nằm trong các file do `MeetingStore`/capture host quản lý (`packages/meeting-store/src/index.ts:66-117,294-359`; `docs/decisions/0004-recording-host-and-capture-permission-boundary.md:24-32`). | Ghi âm, đọc meeting, phát lại citation và làm nguồn cho một lần Transcribe do người dùng gọi. | Capture chunks còn để khôi phục đến khi finalization lưu bền vững. Mỗi recording được giữ cả MP3 đã lưu và canonical WAV, kể cả sau transcription; không tự hết hạn. Xóa meeting/recording sẽ gỡ state và các session, managed artifact, output thuộc meeting (`docs/product/recording.md:16-32`; `packages/meeting-store/src/index.ts:1112-1181,1715-1751,1881-1901`). |
| **Transcript, citation và chat cục bộ** | Transcript lưu range/segment text, usage, ngôn ngữ, trạng thái và sidecar xuất bản. Chat lưu câu hỏi, câu trả lời, provider/model/mode/features, attempt, segment IDs được truy xuất và citation IDs; state còn có `cloudConsent.grantedAt` và lựa chọn chat (`packages/meeting-store/src/index.ts:361-461,492-675,804-830,1527-1588`). | Đọc transcript, trả lời câu hỏi trong meeting đang mở và phát interval được trích dẫn. Chat thread được giữ qua restart (`docs/product/knowledge-and-citations.md:41-52`). | Xóa meeting gỡ chat thread, transcript state và transcript sidecar của meeting (`packages/meeting-store/src/index.ts:1135-1171,1744-1751`). `cloudConsent` và `chatSelection` là state toàn cục; code không gỡ chúng khi xóa một meeting. |
| **Ask qua provider người dùng chọn** | Khi Ask chạy, adapter đưa transcript ready và các message của thread vào `agent.execute`; agent dùng MCP chỉ để tìm/fetch segment của meeting đang mở (`packages/meetless-plugin/src/chat-service.ts:247-274,620-681,961-1028`). Đích logic là provider/model Paseo đã có trên máy và người dùng chọn; credential vẫn thuộc provider (`docs/product/knowledge-and-citations.md:7-25`). | Hỏi đáp có bằng chứng trong một meeting. | Sau mỗi lượt, code archive agent và đóng MCP resource; workspace được archive khi service `close()` (`packages/meetless-plugin/src/chat-service.ts:676-697`). Retention, logging, sub-processor và xóa ở provider được chọn không được quy định trong repo. |
| **Cloud transcription được gọi rõ ràng** | Sau consent, canonical WAV được chia thành các part tối đa 10 phút và upload bằng Convex-generated URL. Convex lưu upload/job/part metadata, storage IDs, digest, thời lượng, provider text và detected languages (`convex/schema.ts:153-275`; `packages/meetless-plugin/src/managed-transcription.ts:476-535,555-570`). Convex action đọc bytes rồi gọi `https://api.openai.com/v1/audio/transcriptions`, model `gpt-transcribe`, trả text/ngôn ngữ (`convex/managedTranscriptionActions.ts:111-168`; `convex/openAITranscription.ts:1-20,42-93`). Code path này region-neutral; active-plan deployment checkpoint ghi region `aws-us-east-1`, Store-testing Sandbox `posh-mink-212` và Production `content-bulldog-967` (`docs/plans/active/v1-paseo-foundation.md:24-35`). | Đổi audio thành transcript có thời gian; kết quả được publish về MeetingStore cục bộ. Các tên deployment là bằng chứng cấu hình/deployment gắn với candidate, không phải phân loại hay suy luận từ code (`docs/decisions/0005-mac-app-store-and-revenuecat.md:180-203`). | Policy đã chấp nhận đặt TTL backend tối đa 24 giờ cho upload/provider output/transcript trung gian và lease job tối đa 6 giờ. Provider hoàn tất chỉ ghi checkpoint text/language; code dọn storage và part/checkpoint rows trong ACK sau local publication hoặc trong cancel/TTL cleanup (`convex/managedTranscription.ts:695-756,818-927`; `convex/managedTranscriptionActions.ts:191-230`). `managedJobs`/`managedUploads` và các hàng quota/charge chuẩn hóa được giữ lại sau cleanup, trong đó job chỉ được đánh dấu cleaned và `providerResult` được null hóa. MP3/WAV cục bộ vẫn giữ đến khi người dùng xóa recording/meeting (`docs/product/monetization.md:161-177`). Đo lường retention/cleanup trên production vẫn là nghĩa vụ evidence của #16 (`docs/plans/active/v1-paseo-foundation.md:567-569,1155-1157`). |
| **Định danh enrollment/auth của thiết bị** | Native host tạo UUID `deviceId`, khóa P-256 và `keyId`; private key nằm trong Keychain, non-sync, chỉ dùng để ký, public identity mới đi ra ngoài (`native/macos-host/ManagedAuthCapability.swift:16-20,56-112,152-171`). Convex lưu device/account/principal, token subject, public key, `enrolledAt`, `lastActiveAt`, revocation/entitlement và challenge nonce/thời hạn/`consumedAt` (`convex/schema.ts:24-59,104-118`; `convex/managedAuth.ts:69-99,134-181,191-273`). | Xác thực Mac đã enrollment, giới hạn tối đa ba Mac và cấp quyền cho managed transcription; không phải Meetless login (`docs/decisions/0005-mac-app-store-and-revenuecat.md:92-101,305-316`). | Challenge có thời hạn 5 phút và sau consume bị từ chối replay (`convex/deviceAuth.ts:1-5,36-53`; `convex/managedAuth.ts:634-646`). Revoke đánh dấu device/principal revoked và dừng job, không xóa identity rows (`convex/managedAuth.ts:102-130`). Code không định nghĩa xóa production cho Keychain/device/account/challenge rows; cleanup toàn account hiện chỉ là hosted-development fixture (`convex/managedAuth.ts:420-447,649-707`). |
| **Apple StoreKit/RevenueCat và subscription state** | Native adapter đọc product/offerings/entitlement, localized price/trial; purchase/restore trả opaque signed transaction tạm thời cho backend (`native/macos-host/RevenueCatCapability.swift:80-115,696-770,806-840`). Product boundary coi RevenueCat App User ID và client subscriber ID là dữ liệu tra cứu, không phải bằng chứng auth (`docs/decisions/0005-mac-app-store-and-revenuecat.md:92-101`); chúng không nằm trong credential upload (`packages/meetless-plugin/src/managed-upload.ts:18-36`). Backend chỉ sau Apple verification mới chuẩn hóa product, environment, các mốc thời gian, trạng thái và hash `originalTransactionId` thành lineage key; schema lưu lineage/account/period/quota/charge và event RevenueCat đã chuẩn hóa (`convex/appleSubscription.ts:135-207,230-235`; `convex/schema.ts:61-102,120-151,277-283`). Webhook chỉ lưu projection; raw RevenueCat payload không lưu trong bảng Meetless (`convex/revenueCatWebhook.ts:1-20,62-95`; `convex/http.ts:34-80`). | Catalog, purchase/restore và tín hiệu subscription; Meetless dùng state đã xác minh để gate/quota/reconcile managed transcription. | Meetless không log/durable signed transaction, receipt, secret hay raw original transaction ID (`docs/decisions/0005-mac-app-store-and-revenuecat.md:240-245,305-343`). Revoke cập nhật state nhưng code không có production account-deletion path; normalized lineage, periods, charges và event rows không có retention/deletion policy hoàn chỉnh trong repo. |
| **Log và diagnostics** | Native có `logs/host-runtime.log` quyền `0600`, stderr/NSLog cho lỗi; Premium diagnostic line chỉ gồm stage/outcome, UUID operation tùy chọn và timestamp (`native/macos-host/MeetlessHost.swift:640-659`; `native/macos-host/RevenueCatCapability.swift:50-76`). Managed transcription log chỉ allowlist stage, recording/transcript/job IDs, status, counters và timestamp; Convex quota log chỉ stage/outcome và số liệu, không serialize document/identity/manifest/error (`packages/meetless-plugin/src/managed-transcription.ts:555-570`; `convex/managedTranscription.ts:1284-1291`). | Vận hành, chẩn đoán lifecycle và quota. | Quy tắc đã chấp nhận cấm audio/transcript contents, credential, receipt, raw transaction và raw transport logs trong ordinary logs (`docs/decisions/0003-meetless-runtime-isolation-and-host-ownership.md:72-74`; `docs/decisions/0005-mac-app-store-and-revenuecat.md:161-170`). Retention/access của log local, Convex platform log, OpenAI, RevenueCat, Apple và provider Ask chưa được repo quy định. |

## Những điểm phải xác minh bên ngoài repo

- Retention, deletion, subprocessors, region và log/access policy của Convex hosting,
  OpenAI, RevenueCat, Apple/StoreKit và provider/model được người dùng chọn cho Ask.
- SDK/provider cache hoặc telemetry ngoài các trường mà Meetless adapter expose;
  thời hạn xóa Keychain và các production device/account rows.
- Phân loại App Privacy (category, collected, linked, tracking, purpose) cho audio,
  transcript/chat/citation, cloud transcription, subscription, enrollment và
  diagnostics. Code không đủ bằng chứng để tự điền các mục này.

Privacy Policy đã được review và công bố tại `https://meetless.2m0r.com/privacy/`;
URL đã lưu và xác minh trên ASC. App Privacy questionnaire vẫn là phạm vi riêng:
`docs/release/app-privacy-draft.md` chứa đề xuất từ inventory này để rà soát trước
khi lưu/Publish. Inventory kỹ thuật không tự chứng minh khai báo đã được gửi hay
bản app đã được Apple xét duyệt.
