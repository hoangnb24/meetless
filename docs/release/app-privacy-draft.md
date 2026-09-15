# Meetless App Privacy — bản nháp đề xuất

**Trạng thái:** đã lưu đủ 7 loại dữ liệu trong bản nháp App Store Connect;
reviewer độc lập xác nhận các trường đã lưu. Chưa bấm Publish. Việc đối chiếu
điều khoản provider và rà soát trước Publish vẫn còn riêng bên dưới.

**Đối tượng rà soát:** macOS Meetless 1.0 (1), packaged candidate từ source
commit 41cfc34382f95dcf3b08fca74347cccb673b15be. Bản nháp này dùng inventory
kỹ thuật đã được ghim trong docs/release/privacy-data-inventory.md, product
contract và code của candidate. Không đọc dữ liệu người dùng, secret hay
receipt thật.

## Kết luận để điền form

Chọn **Yes, we collect data from this app**. Meetless có luồng managed
transcription tùy chọn: sau khi người dùng chọn **Transcribe** và đồng ý, audio
được gửi khỏi Mac, lưu tạm trong Convex và được xử lý bởi OpenAI. Theo định
nghĩa hiện tại của Apple, dữ liệu truyền khỏi thiết bị và được app hoặc đối tác
truy cập lâu hơn thời gian xử lý request theo thời gian thực phải được khai
báo; việc tính năng là opt-in không biến câu trả lời thành “No”.

Các mục đề xuất trong App Store Connect:

| Data type | Collected | Linked to user | Used for tracking | Purpose | Mức chắc chắn |
| --- | --- | --- | --- | --- | --- |
| Audio Data | Yes | Yes | No | App Functionality | Cao |
| Other User Content | Yes | Yes | No | App Functionality | Cao |
| User ID | Yes | Yes | No | App Functionality | Cao |
| Device ID | Yes | Yes | No | App Functionality | Cao |
| Purchase History | Yes | Yes | No | App Functionality | Cao về collection; cao về linked |
| Other Usage Data | Yes | Yes | No | App Functionality | Cao về collection; vừa về category |
| Other Diagnostic Data | Yes | Yes | No | App Functionality | Cao về collection; vừa về linked |

Linked Yes ở Purchase History và Other Usage Data là kết luận từ luồng dữ liệu
đã triển khai: Convex lưu các projection cùng `accountId`/`deviceId`, còn
lineage của giao dịch dùng một khóa hash ổn định để nối các bản ghi. Hash không
tự biến dữ liệu thành anonymous khi khóa đó vẫn được dùng để liên kết lại bản
ghi; vì vậy không để người điền form đổi sang Linked No chỉ bằng cách xác nhận
rằng mã đã hash. RevenueCat manifest có thể khai báo dữ liệu do riêng SDK quản
lý là Linked false, nhưng câu trả lời của Meetless phải tính cả projection ở
backend.

Các câu trả lời trên là đề xuất kỹ thuật cụ thể cho candidate này. Owner/legal
chỉ cần rà soát trách nhiệm và tính chính xác chung trước khi gửi, không có
quyết định phân loại còn bỏ ngỏ trong bảng.

Tất cả mục trên chỉ dùng cho **App Functionality**. Không chọn Third-Party
Advertising, Developer’s Advertising or Marketing, Analytics, Product
Personalization hoặc Other Purposes. Meetless không dùng dữ liệu để quảng cáo,
đo lường quảng cáo, lập hồ sơ, bán dữ liệu hay nối dữ liệu với app/website của
doanh nghiệp khác.

## Vì sao chọn từng mục

### Audio Data — Yes / Linked Yes / Tracking No / App Functionality

Meetless giữ microphone và system audio cục bộ cho recording, nhưng recording
cục bộ không phải collection theo định nghĩa của Apple. Luồng managed
transcription upload canonical WAV qua Convex sau thao tác Transcribe; Convex
giữ các part/storage tạm thời và action gọi OpenAI transcription. Vì vậy phải
khai báo Audio Data cho phiên bản có tính năng này.

Audio upload gắn với account/device và recording/job identity trong backend
(accountId, deviceId, recordingId), nên đề xuất Linked Yes. Không có tracking:
audio chỉ phục vụ transcript của người dùng.

Evidence: docs/product/recording.md:34-54, docs/product/monetization.md:17-43,
docs/release/privacy-data-inventory.md:31-35, convex/schema.ts:153-275,
convex/managedTranscriptionActions.ts:111-168.

### Other User Content — Yes / Linked Yes / Tracking No / App Functionality

Transcript text do audio tạo ra, câu hỏi và câu trả lời của chat, cùng
citation/segment context, là nội dung gắn với meeting. Transcript/provider
checkpoint có thể tồn tại tạm trong backend trước khi được publish về
MeetingStore; đây là lý do chọn Other User Content dù bản copy sau cùng vẫn
được giữ trên Mac. Cùng category này đại diện cho nội dung text tự do trong
chat; không cần suy đoán người dùng có thể nói dữ liệu nhạy cảm nào trong
recording.

Meetless chỉ dùng nội dung này để transcribe, trả lời câu hỏi trong meeting
đang mở và hiển thị evidence. Không chọn Emails or Text Messages: chat của
Meetless là câu hỏi với provider/agent, không phải SMS hoặc nhắn tin giữa
người dùng.

Đề xuất Linked Yes vì managed transcript/job được gắn với account/device và
local chat/meeting được liên kết với recording của cùng installation. Ask qua
provider người dùng chọn có retention/subprocessor policy chưa được repo quy
định; khoảng trống này không phải cơ sở để trả lời “No collection”.

Evidence: docs/release/privacy-data-inventory.md:32-34,
docs/product/knowledge-and-citations.md:7-25,41-52,
packages/meetless-plugin/src/chat-service.ts:247-290,620-697.

### User ID — Yes / Linked Yes / Tracking No / App Functionality

Managed backend lưu accountId, tokenIdentifier và account-level
subscription/enrollment records. accountId được tạo từ Apple-verified
subscription lineage sau khi originalTransactionId đã được hash; đây không
phải Meetless login hoặc email, nhưng vẫn là account-level identifier dùng để
giữ quota, entitlement và ownership nhất quán.

Mục đích là authenticate/authorize managed transcription, reconcile entitlement
và giữ dữ liệu đúng account. Linked Yes là đề xuất bảo thủ theo việc
identifier này được dùng để liên kết nhiều bản ghi cùng account. Tracking No vì
không nối identifier này với dữ liệu bên ngoài cho quảng cáo hoặc ad measurement.

Evidence: convex/schema.ts:24-102,120-151, convex/managedAuth.ts:24-66,211-314,
convex/appleSubscription.ts:230-293,
docs/decisions/0005-mac-app-store-and-revenuecat.md:92-101,305-316.

### Device ID — Yes / Linked Yes / Tracking No / App Functionality

Native host tạo UUID deviceId, keyId và public key; private key ở Keychain
không rời máy. Public/device identity được gửi để enrollment, refresh, giới
hạn tối đa ba Mac, revoke và authorize job. Convex lưu device/account
association, enrolled/last-active/revoked timestamps và token subject.

Đây là Device ID theo nhóm identifier của Apple và được lưu ngoài thiết bị
trong thời gian dài hơn một request. Linked Yes vì backend dùng nó để gắn
installation với account và các job; Tracking No vì nó chỉ phục vụ security,
authorization và service functionality.

Evidence: native/macos-host/ManagedAuthCapability.swift:1-20,56-112,
convex/schema.ts:24-59,104-118, convex/managedAuth.ts:24-66,211-314,
docs/release/privacy-data-inventory.md:35.

### Purchase History — Yes / Linked Yes / Tracking No / App Functionality

Meetless dùng StoreKit/RevenueCat để đọc offerings, entitlement, purchase và
restore; backend chỉ giữ projection đã chuẩn hóa của product, environment,
subscription period, state và hashed lineage cần cho entitlement/quota.
Purchase/restore state được dùng để mở managed transcription, không dùng cho
marketing hay personalization.

Payment card/bank details không đi vào Meetless: StoreKit/RevenueCat không cung
cấp payment details cho app, nên không chọn Payment Info.

RevenueCat 5.87.1 bundled privacy manifest trong candidate khai báo Purchase
History với App Functionality, Linked false và Tracking false cho dữ liệu do
SDK quản lý. Ở cấp Meetless, backend còn tạo projection gắn với
`accountId`/`deviceId` và lineage hash để nối các giao dịch; do đó câu trả lời
app-level vẫn là Linked Yes. SDK manifest không thay thế việc khai báo luồng
backend của ứng dụng. Purchase History vẫn phải được khai báo vì SDK đã nêu rõ
collection.

Evidence: native/macos-host/Package.swift:12-18,
native/macos-host/RevenueCatCapability.swift:500-690,806-839,
docs/release/privacy-data-inventory.md:36,
convex/appleSubscription.ts:135-207,230-293,
convex/schema.ts:61-102,120-151.

### Other Usage Data — Yes / Linked Yes / Tracking No / App Functionality

Backend lưu thời lượng, billable seconds, quota used/reserved, job status và
các mốc xử lý cho managed transcription. Những trường này dùng để kiểm tra
quota, settle charge một lần, khôi phục job và vận hành đúng entitlement; chúng
không phải product analytics và không dùng để đo audience, quảng cáo hay
personalize sản phẩm.

Giữ mục Other Usage Data vì Apple mô tả mục này là dữ liệu khác về hoạt động
của người dùng trong app, và các counters này được lưu ngoài thiết bị trong
managed job/account records. Đây là phân loại có độ chắc chắn thấp hơn do
Apple không có mục riêng cho quota/processing counters, nhưng đường dữ liệu và
purpose đã rõ; không coi việc dữ liệu phục vụ billing/quota là lý do để bỏ qua
collection. Không chọn Product Interaction hoặc Analytics vì không có event
stream app launches, clicks, scrolling hay audience measurement.

Evidence: convex/schema.ts:140-151,232-283,
convex/managedTranscription.ts:1280-1307,
packages/meetless-plugin/src/managed-transcription.ts:555-570.

### Other Diagnostic Data — Yes / Linked Yes / Tracking No / App Functionality

Candidate có log vận hành được phát ra ngoài thiết bị trong runtime hosted của
Convex: quota checks ghi stage, outcome, thời điểm và các counters số; lifecycle
managed transcription ghi stage, `recordingId`, `transcriptId`, `jobId`, status,
request count và timestamp. Các giá trị này được allowlist để không chứa audio,
transcript, credential hay full job, nhưng vẫn là diagnostic data về việc app
đang xử lý một job. Chưa có bằng chứng candidate bảo đảm log bị bỏ ngay sau
request thời gian thực hoặc không được nền tảng/provider giữ lại, nên bản nháp
chọn **Yes** để không bỏ sót dữ liệu được phát ra và có thể được truy cập ngoài
thiết bị.

Chọn Linked Yes vì các ID của recording/transcript/job và correlation của
managed account/device cho phép nối diagnostic event với phiên xử lý cụ thể
của người dùng. Purpose chỉ là App Functionality để quota, retry, phục hồi và
vận hành managed transcription; không phải Analytics hay Tracking. Việc log
chỉ chứa metadata allowlisted không biến nó thành local-only data.

Evidence: convex/managedTranscription.ts:1284-1325,
packages/meetless-plugin/src/managed-transcription.ts:556-570,
docs/release/privacy-data-inventory.md:41-44,
[Apple — App privacy details](https://developer.apple.com/app-store/app-privacy-details/).

## Các mục không đề xuất chọn

| Data type | Lý do không chọn trong bản draft |
| --- | --- |
| Name, Email Address, Phone Number, Physical Address, Other User Contact Info | App không yêu cầu Meetless profile hoặc contact field. hoang@2m0r.com và tên người chịu trách nhiệm chỉ thuộc website/privacy policy, không phải dữ liệu app thu từ người dùng. |
| Payment Info | StoreKit/RevenueCat xử lý giao dịch; Meetless không nhận payment card, bank account hoặc form of payment. |
| Health, Fitness, Sensitive Info | Recording/chat là free-form user content. Audio Data/Other User Content đại diện cho dữ liệu người dùng có thể tự nói/nhập; không có feature hỏi riêng nhóm này. |
| Precise Location, Coarse Location, Contacts, Photos or Videos, Browsing History, Search History | Không có code hoặc product feature thu các nhóm này trong candidate. |
| Emails or Text Messages | Chat hỏi đáp meeting không phải SMS hoặc private messaging giữa người dùng. |
| Product Interaction, Advertising Data | Không có analytics, ad network, attribution hoặc advertising feature trong app. |
| Crash Data | Không thấy crash reporter hoặc crash upload path trong source/package list của candidate; không suy diễn log quota/lifecycle thành crash data. |
| Performance Data | Không thấy performance analytics hoặc performance upload path trong source/package list; các timing/counters vận hành đã được map vào Other Diagnostic Data. |
| Other Data Types | Không cần mục catch-all khi payload đã map được vào Audio Data, Other User Content, Identifiers, Purchase History, Usage Data và Other Diagnostic Data. |

Meeting, recording, transcript, chat và citation chỉ được xử lý cục bộ thì không
phải collection theo Apple. Chúng vẫn được mô tả trong Privacy Policy; riêng
các bản audio/transcript trung gian đi qua managed backend đã được map ở trên.

Website https://meetless.2m0r.com/, Cloudflare request data và email hỗ trợ
không được cộng vào nhãn privacy của macOS app chỉ vì URL được đặt trong App
Store Connect. Đây là website processing và đã có mô tả riêng trong privacy
policy. Nếu binary sau này nhúng web view, analytics SDK, support form hoặc
thêm provider SDK, phải rà soát lại toàn bộ bảng này.

## Tracking và third-party partner

Trả lời tracking ở cấp app: **No**. Không có ATT prompt, IDFA, ad SDK, ad
network, attribution hoặc data broker. RevenueCat privacy manifest cũng khai
báo Tracking false; app/backend chỉ dùng RevenueCat và Apple signals cho
purchase/entitlement. Apple vẫn yêu cầu developer chịu trách nhiệm rà soát
third-party code được tích hợp, nên bản xác nhận cuối phải bao gồm mọi SDK có
trong candidate, không chỉ code Meetless.

Ask provider được người dùng chọn qua Paseo là một external processing path;
provider credential vẫn thuộc provider và repo chưa quy định retention,
subprocessor hoặc logging của provider đó. Bản draft đã khai báo Other User
Content cho transcript/chat path này. Đây là giới hạn bằng chứng cần rà soát
theo provider được bật trong bản phát hành; không suy diễn thành Analytics,
Advertising hoặc Tracking khi chưa có hành vi tương ứng. Với managed path,
contract của candidate ghi nhận Convex lưu tạm tối đa 24 giờ và action gọi
OpenAI transcription, nhưng retention/logging phía dịch vụ ngoài app chưa được
ghi rõ trong repo.

## Cổng rà soát trước Publish

1. **Owner/legal review:** rà soát và phê duyệt bảng đề xuất ở trên để người
   có thẩm quyền nhập form. Linked Yes cho các projection gắn với
   `accountId`/`deviceId` và Other Usage Data là câu trả lời đã được xác định
   từ candidate, không phải lựa chọn kinh doanh.
2. **Named provider evidence:** đối chiếu retention/logging hiện hành của
   Convex, OpenAI managed transcription và provider Ask thực sự được bật trong
   release. Repo chưa chứa cam kết phía dịch vụ ngoài app; nếu evidence đó cho
   thấy thêm collection hoặc purpose, cập nhật bảng trước Publish.
3. **Final artifact check:** candidate manifest liệt kê `electron-log`,
   `electron-updater`, `@opentelemetry/api` và không cho thấy SDK analytics,
   crash hoặc tracking code. Hosted diagnostic logs đã được map riêng ở trên;
   nếu release artifact thay đổi thì rà lại cả bốn nhóm này. Không chọn “No, we
   do not collect data” vì sẽ bỏ sót
   managed audio, temporary transcript/provider output, enrollment identifiers
   purchase history và hosted diagnostic data.

## Nguồn Apple đã đối chiếu

- [App privacy details on the App Store](https://developer.apple.com/app-store/app-privacy-details/): định nghĩa collection, optional disclosure, nhóm data types, purposes, linked và tracking.
- [Manage app privacy](https://developer.apple.com/help/app-store-connect/manage-app-information/manage-app-privacy): quy trình nhập data types và Publish trong App Store Connect.
- [NSPrivacyCollectedDataType](https://developer.apple.com/documentation/bundleresources/app-privacy-configuration/nsprivacycollecteddatatypes/nsprivacycollecteddatatype): tên và mô tả các giá trị data type.
- [User Privacy and Data Use](https://developer.apple.com/app-store/user-privacy-and-data-use/): trách nhiệm với third-party SDK và tracking/ATT.

Các nguồn Apple chỉ cung cấp định nghĩa và quy trình. Chúng không thay cho
owner/legal approval về việc gửi bảng khai báo, cũng như việc rà soát các điều
khoản provider và retention thực tế theo từng thị trường.
