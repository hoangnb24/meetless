# Epic: Meetless trên Mac — Transcribe và Ask bằng subscription

Date: 2026-09-18

## Status

E1 hoàn tất ngày 2026-09-18: owner duyệt chính sách, Lead ACCEPT tài liệu.
E2 đã được cấp quyền code/build/install, gửi transcript đến OpenAI và upload
TestFlight, không áp trần chi phí trải nghiệm. Build 7 có một Ask thật thành công,
hai lượt sau thất bại tại parser/validation và thread failed chặn câu hỏi mới.
E2 đã đóng — Lead ACCEPT ở mức chứng minh đường tích hợp theo chỉ thị Human mới;
không ACCEPT Ask hoàn chỉnh. E4 bắt đầu với recovery. Parser/recovery là release blockers, không xóa
hay đổi các failure build 7 thành pass; xem Validation.
Reconcile sau phỏng vấn và chỉ thị release-first: đích là bản dùng được trên
Mac App Store. Rà khả năng phát hành ngay, không chờ hoàn thiện polish ở cuối.
Đây là một kế hoạch repo theo `docs/WORKFLOW.md`, không phải hệ thống task riêng.
Các mục E1–E8 bên dưới thay cho GitHub issues trong giai đoạn này. Cập nhật tiến
độ, quyết định và bằng chứng tại đây; không tạo bản tracker song song.

Owner cho phép tạo epic/issues, sau đó chọn theo dõi bằng docs vì GitHub chưa
ghi được. Lần tạo epic qua integration trả 403; `gh` trả 401. Chưa có epic hay
issue mới được tạo trên GitHub.

Quyết định E1 trong [ADR0008](../../decisions/0008-desktop-managed-ai-pivot.md)
thay hướng provider-reuse của ADR0007. Chỉ thị Human tiếp theo đã mở quyền E2
code/build/install, gửi transcript đến OpenAI và TestFlight upload, không đặt
trần chi phí trải nghiệm. Human tiếp tục chọn `gpt-5.6-luna`, chấp nhận retention
OpenAI đã trình bày và cho phép deploy/config Sandbox. Xác minh đúng backend
Sandbox trước mutation; Production giữ nguyên. Phỏng vấn sau đó đã chốt hành vi
Ask trong product; sau reconcile Human đã cho thực hiện rà E2 rồi sửa Ask ở E4.
Không mở E3/E5–E8 implementation, migration, App Review hay phát hành. Không mở lại V1 cũ; quyết định offer,
product/privacy mới và release vẫn thuộc Human.

## Outcome

Người dùng cài Meetless từ Mac App Store, không cần coding agent hay API key.
Họ ghi âm, transcribe và hỏi về cuộc họp bằng dịch vụ AI do Meetless cung cấp
trong subscription.

Flow mục tiêu để triển khai sau khi được phép:

```text
Ghi âm → Stop → Audio lưu trên Mac
  → Transcribe: kiểm tra quyền/hạn mức và consent
  → Transcript lưu trên Mac
  → Ask: kiểm tra quyền/hạn mức và consent
  → Câu trả lời có dẫn chứng → Nghe đoạn audio gốc
```

Đóng/mở app giữ transcript và chat. Lỗi hoặc hết quota không làm mất dữ liệu.
Owner đã duyệt: hết subscription hoặc quota vẫn ghi âm, đọc transcript/chat cũ
và nghe audio; chỉ chặn yêu cầu AI mới. Xem [product](../../product/desktop-managed-ai.md).

## Context

- [Product overview](../../product/overview.md), [knowledge/citations](../../product/knowledge-and-citations.md),
  [monetization](../../product/monetization.md), [recording](../../product/recording.md).
- [ADR0001](../../decisions/0001-maintained-paseo-fork.md): ranh giới Paseo/Meetless.
- [ADR0005](../../decisions/0005-mac-app-store-and-revenuecat.md): lịch sử Store và subscription.
- [ADR0007](../../decisions/0007-stop-v1-pending-product-direction.md): dừng V1 và giới hạn bằng chứng.
- [Workflow](../../WORKFLOW.md), [workspace protocol](../../WORKSPACE_PROTOCOL.md),
  [production evidence](../../patterns/production-evidence.md).
- Điểm bắt đầu khi khảo sát implementation: `packages/meetless-plugin/src/chat-service.ts`,
  `packages/meetless-plugin/src/provider-access.ts`, `packages/meetless-app/`,
  `packages/meetless-client/`, `packages/meeting-contracts/`, `convex/`, `native/`.

TestFlight build 4 có xác nhận giới hạn recording, monthly Sandbox purchase và
transcription. Build 6 chưa có Ask được chấp nhận qua provider cũ. Không dùng
các kết quả đó để suy ra pivot đã chạy được, release đã đạt hoặc các lỗi cũ đã
được giải quyết. Các tiêu chí chưa đạt trong stop record vẫn giữ nguyên.

## Scope

Trong phạm vi:

- Desktop macOS; Managed Transcribe và Managed Ask trong một cuộc họp.
- Dữ liệu lâu dài trên Mac; backend xử lý tạm thời tối đa 24 giờ, xóa sớm hơn
  sau xác nhận lưu local; retention phía AI provider cần xác minh ở E2.
- Subscription, usage, privacy, dẫn chứng, lịch sử chat và bảo toàn dữ liệu cũ.
- Tận dụng implementation hiện có khi phù hợp; đánh giá từng phần Paseo.

Ngoài phạm vi:

- Mobile (phase sau), đồng bộ cloud lâu dài, tài khoản đa thiết bị.
- Nhập tài liệu bên ngoài, hỏi xuyên nhiều cuộc họp, tự động summary/action items.
- Viết lại toàn bộ ứng dụng hoặc loại bỏ Paseo như một mục tiêu tự thân.
- Tự xóa dữ liệu, keys, backups, runtime hoặc decommission dịch vụ cũ.

## Approach And Progress

### Release-first: thứ tự thực thi và điểm dừng

E1–E8 là nhóm kết quả, không phải tám chặng tuần tự. Không đợi E8 mới phát hiện
đường lên Store không khả thi. Không thêm tracker hay epic riêng.

| Ưu tiên | Kết quả trước khi đi tiếp | Nhóm việc / bằng chứng |
| --- | --- | --- |
| P0 — kiểm tra rủi ro phát hành ngay | Danh sách blocker, unknown, owner và cách chứng minh; không còn giả định phát hành bị giấu ở cuối | E8 rà sớm producer/signing/native startup/permissions, route không cần agent, khoảng cách Sandbox–Production, subscription/offer, privacy/retention và hồ sơ review; E7 kiểm tra rủi ro giữ dữ liệu trước đổi schema/UI. Chưa xác minh không được đánh dấu đạt. |
| P0 — chứng minh một lát cắt Ask thật | Hỏi → câu ngoài phạm vi/thiếu nguồn → lỗi/retry → hỏi mới → nguồn/audio → mở lại; không mắc kẹt hoặc mất dữ liệu | E2 + phần recovery E4/E6/E7. Xác định parser boundary và thử kiến trúc SDK tối thiểu qua host/backend thật, rồi exact TestFlight candidate. Không redesign trước proof. |
| P1 — hoàn thành bản tối thiểu đủ phát hành | Hành vi đã chốt, gói bán đã được Human duyệt, quyền/usage và dữ liệu nhất quán | E3 quyết định offer từ evidence có sẵn và phép đo cần thiết; E4/E5/E6/E7 tích hợp theo dependency, không chờ nghiên cứu chi phí hoàn hảo mới sửa recovery. |
| P1 — release candidate sớm nhất đủ điều kiện | Exact candidate đạt core flow, negative/recovery, upgrade và release checklist; Human quyết định submit/release | E8 nghiệm thu cuối là xác nhận lại rủi ro đã xử lý, không phải lần đầu rà chúng. App Review/Production/publication có quyền riêng. |
| P2 — sau release hoặc khi không cản đường release | Cải thiện thẩm mỹ/tiện nghi không mở rộng core scope | Animation, tinh chỉnh layout/copy, markdown phong phú, rewrite/cleanup vì đẹp kiến trúc. Không lấy làm điều kiện chặn submit. |

Lỗi khóa chat, nguồn sai được trình bày như đã xác minh, rò dữ liệu, mất lịch sử,
vượt quyền và app không khởi động **không phải polish**. Hành vi phỏng vấn đã
chốt vẫn là contract; muốn bỏ khỏi bản đầu phải xin Human quyết định riêng.
Không cam kết Apple sẽ duyệt trước khi có review thật. Chỉ thị lên Store xác
định đích và ưu tiên, không thay quyền submit/Production hay tiêu chí an toàn.

Mỗi blocker sớm ghi ngay ở mục E tương ứng: evidence, ảnh hưởng release, owner,
bước kiểm chứng nhỏ nhất, và disposition (đạt / phải sửa / cần Human / chưa rõ).
Nếu kiến trúc không đi qua host, packaged app, local persistence hoặc privacy
boundary, dừng mở rộng UI và đổi route trước. Sau một lát cắt không đủ proof,
reconcile lại route; không kéo dài polish để né blocker.

| Mục | Đầu ra | Phụ thuộc | Trạng thái |
| --- | --- | --- | --- |
| [E1](#e1-chốt-phạm-vi-và-chính-sách-pivot) | Product/ADR được duyệt | Owner đã duyệt policy | Hoàn tất — Lead ACCEPT |
| [E2](#e2-chứng-minh-managed-ask-trên-bản-apple-phân-phối) | Chứng minh đường Managed Ask trên TestFlight | E1; quyền/model/retention/Sandbox | Hoàn tất — ACCEPT integration feasibility; không product acceptance |
| [E3](#e3-đo-chi-phí-và-chốt-subscription) | Giá, hạn mức và usage policy | Số đo E2 từng phần; Human chốt trước E5/release | Chưa bắt đầu; đưa quyết định offer lên sớm |
| [E4](#e4-hoàn-thiện-managed-ask-và-dẫn-chứng) | Ask nhiều lượt, nguồn hợp lệ, recovery | Contract phỏng vấn; route E2 đã ACCEPT; E3 chỉ cho limits/settlement | Recovery source/local ACCEPT; parser/SDK và contract còn lại chưa đạt; chưa TestFlight proof |
| [E5](#e5-mở-rộng-premium-và-hạn-mức-sang-ask) | Quyền/usage ở backend | E3; tích hợp E4 | Chưa bắt đầu |
| [E6](#e6-đơn-giản-hóa-trải-nghiệm-desktop) | Flow không cần cấu hình agent | Thiết kế: E1, E3; nghiệm thu: E4, E5 | Chưa bắt đầu |
| [E7](#e7-bảo-toàn-dữ-liệu-và-chuyển-phiên-bản) | Update giữ dữ liệu và chat cũ | Rà trước thay store/UI; proof trên candidate tích hợp | Chưa bắt đầu; không để data risk đến cuối |
| [E8](#e8-nghiệm-thu-end-to-end-và-chuẩn-bị-phát-hành) | Rà release risk sớm + nghiệm thu exact candidate cuối | Rà sớm dùng evidence hiện có; đóng sau các release gates E1–E7 | Rà sớm là frontier tiếp theo; chưa release acceptance |

Frontier hiện tại: source/package đã ACCEPT, Sandbox deployed, Apple validation
và processing pass; build 7 đã được gán vào Meetless Internal, IN_BETA_TESTING.
Human đã chạy TestFlight 1.0 (7) và Ask thành công trên transcript cũ, nhưng các
lượt tiếp theo thất bại. Frontier: E2 integration đã ACCEPT có giới hạn; lát cắt
E4 recovery source/local đã ACCEPT. Tiếp theo phân biệt invalid_answer/no-evidence
và chốt route SDK/streaming trước mở rộng code, rồi exact TestFlight proof cho
candidate tích hợp. Không quay lại upload build 7 hay mở polish toàn app.
Citation audio, consent cancel, quit/reopen và máy không có coding agent vẫn
chưa đủ bằng chứng; chuyển rõ sang E4/E7/E8, không coi là pass hoặc mở quyền release.
Lead sở hữu docs/operations và source sau handback recovery; không còn writable
Peer active. Fresh read-only inspection đã DONE, Lead ACCEPT phạm vi local.
Khi giao việc, Lead chỉ định một owner cho mỗi moving write scope,
tối đa một writable Peer đang active. Dependency phải có artifact/decision được
chấp nhận; đóng mục việc một mình không chứng minh readiness.

### E1: Chốt phạm vi và chính sách pivot

**Kết quả:** flow và chính sách mới đủ rõ để triển khai, thay thế các yêu cầu cũ
một cách tường minh trong product/ADR sau khi owner duyệt.

Phần việc:

- Managed Ask thay yêu cầu coding agent sẵn có; subscription gồm Transcribe/Ask.
- Chốt free/expired/quota-exhausted behavior, quyền đọc/nghe dữ liệu cũ;
  trial và allowance chuyển sang E3, không kế thừa giá trị V1.
- Chốt dữ liệu gửi AI, thời hạn lưu backend, consent, xóa và bảo mật.
- Xác định phần chính sách còn mở cho E3; không tự đặt giá/quota/model mặc định.
- Cập nhật product/ADR và chính kế hoạch này khi được phép; giữ bằng chứng V1 cũ.

Điều kiện hoàn tất:

- [x] Owner duyệt flow, phạm vi và các chính sách thuộc E1.
- [x] Product/ADR ghi rõ yêu cầu nào được thay, phần nào giữ, quyền execute nào có hiệu lực.
- [x] Quyết định kinh tế còn mở được chuyển rõ sang E3, không chặn thử nghiệm E2 bằng chính sách ngầm.

**Reopen:** còn lựa chọn materially khác về dữ liệu, privacy, free access hoặc
scope; xin owner quyết định trước implementation phụ thuộc.

### E2: Chứng minh Managed Ask trên bản Apple phân phối

**Kết quả:** câu hỏi về transcript có sẵn nhận được câu trả lời thực trong app
TestFlight qua đường managed không phụ thuộc coding-agent API/credential.
Human đã đồng ý đóng E2 theo phạm vi integration feasibility, rồi thực hiện E4;
không giữ E2 mở cho toàn bộ chất lượng chat. Fresh-install/no-agent-machine,
playback và upgrade/relaunch end-to-end vẫn cần trước release ở E7/E8.

Phần việc:

- Khảo sát phần chat giữ lại và phần gọi agent phải thay; không mặc định bỏ Paseo.
- Thiết kế app → backend → AI, credential chỉ ở backend; quyền thử nghiệm có giới hạn.
- Lead xác định actual producer, dữ liệu thử được phép, backend/config, consumer,
  exact artifact và proof trước khi giao implementation; không lấy fixture làm thực tế.
- Dùng transcript thử không nhạy cảm, đối chiếu câu trả lời với nguồn.
- Quyền code/build/install/transcript/OpenAI/TestFlight đã cấp; không hỏi lại
  các quyền này và không tự đặt trần chi phí. Ghi usage/cost thực đã quan sát.
  Model E2 `gpt-5.6-luna`, retention OpenAI và deploy/config Sandbox đã được Human
  duyệt. Không suy TTL backend áp dụng cho OpenAI hay quota E3 đã được duyệt.

Điều kiện hoàn tất:

- [x] Architecture/contract và ranh giới ownership được ghi nhận, phản biện độc lập khi cần.
- [x] Exact TestFlight candidate trả lời thực và nguồn transcript được đối chiếu.
  Build 7 có Human report/screenshot và backend success lượt đầu. Lượt sau
  failed/recovery khóa chuyển nguyên evidence sang E4, không phải pass.
- [x] Build 7 VALID, thuộc nhóm Meetless Internal hiện hữu và IN_BETA_TESTING;
  upload thành công một mình không đủ đóng checkpoint phân phối nội bộ.
- [x] Actual managed call path không dùng coding-agent API/auth hay fallback;
  request trái phép bị từ chối trước provider. Không suy clean-machine proof.
- [x] Có số đo usage/latency phục vụ E3 và ghi rõ lỗi/chưa thử.
- [x] Request configuration và disclosure đối chiếu retention OpenAI đã được
  Human chấp nhận: foreground/store:false/no tools, abuse exceptions/cache 24h.
  Không chứng minh xóa thực tế ở provider hay project ZDR; xem giới hạn audit.

**Giới hạn:** chưa phải Ask hoàn chỉnh, App Review hay release acceptance.
Không cần xác định chính xác field parser bị từ chối để đóng integration gate;
đây là việc chẩn đoán E4 nếu còn cần cho route được chọn. E4 giữ lỗi khóa thread
là blocker phát hành, cùng proof retry/new question/playback/reopen.
**Reopen:** luồng thật không chạy, cần mở rộng trust/permission, thêm dịch vụ hoặc
chi phí chưa được phép; dừng phần phụ thuộc và đưa quyết định đúng owner.

### E3: Đo chi phí và chốt subscription

**Kết quả:** owner duyệt giá, quyền lợi, trial, hạn mức và quy tắc usage.

Phần việc:

- Đo Ask với transcript ngắn/dài và hội thoại nhiều lượt; dùng ngân sách đã được phép.
- Tính transcription, Ask, lưu trữ tạm, truyền dữ liệu, vận hành và phí cửa hàng.
- So sánh hai hạn mức riêng với credit chung, cho nhóm dùng thông thường và dùng nhiều.
- Chốt lỗi/cancel/retry, kết quả đã có nhưng app mất kết nối, renewal/restore.
- Chọn model và giới hạn phù hợp số đo; không mặc định giữ giá/quota V1 rồi thêm Ask.

Điều kiện hoàn tất:

- [ ] Bảng chi phí có nguồn, ngày, input/usage thực và giả định; phân biệt đo được với ước tính.
- [ ] Owner duyệt giá, quota/trial, đơn vị usage và cách xử lý các nhánh lỗi.
- [ ] Chính sách được ghi vào product và có đầu vào cụ thể cho E4–E6.

**Reopen:** chi phí hoặc chất lượng thực không đáp ứng gói đã chọn; không tự giảm
quyền lợi hay nới quota để làm test đạt.

### E4: Hoàn thiện Managed Ask và dẫn chứng

**Kết quả:** Ask nhiều lượt về cuộc họp đang mở, lịch sử bền vững và nguồn kiểm chứng được.

Lát cắt đầu — recovery độc lập SDK:

- Authority: product Accepted Ask Behavior; sau lỗi cho câu mới, giữ history,
  retry explicit mới nhất, không auto dispatch, tối đa một attempt/meeting.
- Lead đã xác định nguyên nhân lock: `startChatQuestion` chỉ nhận `ready` dù
  failed thread không còn active attempt; UI đã cho submit. Thay SDK không tự
  sửa domain gate này. Sửa nhỏ, không migration hay đổi provider contract.
- Proof thiết kế: dùng actual `MeetingStore`/`MeetingChatService` trong thư mục
  tạm độc lập; initial success → provider failure → new question success;
  failed/retried attempts và user messages giữ nguyên qua store reopen, không
  tự dispatch; concurrent turn và stale retry vẫn bị từ chối đúng lý do.
  Fixture transport chỉ cô lập failure, không thay bằng chứng provider/native.
- Candidate định danh hash/diff; Lead review + focused checks. Sau tích hợp,
  exact TestFlight candidate phải chứng minh recovery qua UI, nguồn và reopen
  bằng Human manual verification như đã chọn. Local pass không đóng E4.
- Không gộp parser remediation/SDK migration/streaming/consent persistence vào
  patch này. Chúng vẫn là scope E4 tiếp theo; không bị loại khỏi release.
- Writer đã DONE/relinquish: Peer `35178d6f-87c2-462e-9931-be6baaa87d04`
  (“E4 failed-thread recovery slice”), scope domain
  `src/index.ts`, domain `test/chat.test.ts`, store `test/chat-store.test.ts`,
  plugin `test/chat-service.test.ts` và optional `test/managed-chat-recovery.test.ts`.
  Không đổi schema/store/service source, provider, UI hoặc docs ngoài scope;
  cần scope khác phải DEPENDENCY_REQUEST. Lead sở hữu integration/review/build.
- SDK assessment: tài liệu [transport](https://ai-sdk.dev/docs/ai-sdk-ui/transport)
  và [streamText](https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text) được
  đọc lại cho bước tiếp theo. Custom transport/streaming là seam đáng thử, không
  thay domain/store ownership. Patch recovery không phụ thuộc chọn SDK, không
  thêm dependency. Adoption phải chứng minh host bridge + local durability,
  tắt mọi automatic retry ở version được chọn và không ghi content telemetry.

Phần việc:

- Thực hiện [contract Ask sau phỏng vấn](../../product/desktop-managed-ai.md#accepted-ask-behavior):
  off-topic/no-evidence là kết quả hợp lệ, history giúp hiểu câu hỏi nhưng không
  thành nguồn; lỗi không khóa câu hỏi mới; retry mới nhất thay kết quả tại chỗ.
- Streaming tentative; partial/nguồn không xác minh gắn nhãn, không đưa lại vào
  context. Stop, đổi meeting vẫn chạy đúng meeting, tối đa một request/meeting;
  đóng cửa sổ/quit yêu cầu dừng tất cả, lưu partial, không auto-resume.
- Chỉ dùng nguồn thuộc cuộc họp được chọn; xử lý transcript dài theo giới hạn E3.
- Lưu/khôi phục chat; timeout, mất kết nối và retry theo policy, không tự nhân đôi lượt.
- Dẫn chứng dùng segment ID có thật; model-written timestamp không phải authority.
- Thiếu bằng chứng phải nói rõ; transcript là dữ liệu, không phải chỉ dẫn hệ thống.

Điều kiện hoàn tất:

- [ ] Hội thoại nhiều lượt đúng scope; đóng/mở app giữ lịch sử.
- [ ] Bấm dẫn chứng nghe đúng khoảng audio thật; nguồn không hợp lệ bị từ chối.
- [ ] Kiểm tra câu hỏi không có đáp án, transcript dài, nội dung cố ghi đè chỉ dẫn và nguồn khác cuộc họp.
- [ ] Lỗi/mất kết nối/retry có proof, không chỉ fixture; dữ liệu cũ không bị mất.
- [ ] Hello/thiếu nguồn → retry lỗi mới nhất → câu mới không bị khóa; retry cũ
  thành câu mới, không duplicate question; partial/unverified không vào context.
- [ ] Stop, đổi meeting, hai meeting chạy đồng thời, đóng cửa sổ/quit/reopen
  đúng contract trên app thật; lưu đúng meeting, không auto-dispatch.

**Reopen:** chất lượng dẫn chứng, giới hạn context hoặc recovery đòi đổi policy/chi phí.

### E5: Mở rộng Premium và hạn mức sang Ask

**Kết quả:** backend kiểm tra quyền và usage trước AI, theo policy E3.

Phần việc:

- Tái sử dụng verification/enrollment phù hợp; không tin entitlement từ renderer.
- Chống tính usage trùng khi retry/concurrent request; xử lý trạng thái chưa biết đúng policy.
- Giới hạn chống lạm dụng và chi phí theo quyết định được duyệt, không tự sáng tác quota.
- Tách Sandbox/Production; giữ an toàn receipt/credential và không làm hỏng transcription.

Điều kiện hoàn tất:

- [ ] Còn/hết hạn mức, expired/refunded/revoked và restore được kiểm chứng theo policy.
- [ ] Gửi lại/đồng thời/lỗi giữa chừng không vượt quyền hoặc tính usage trùng.
- [ ] Transcribe và Ask cùng gói hoạt động qua backend thật, không dùng fixture entitlement thay bằng chứng.
- [ ] Sandbox không cấp quyền/usage Production; regression transcription được kiểm tra.

**Reopen:** hợp đồng subscription hoặc cost settlement chưa rõ; chuyển về E3/E1.

### E6: Đơn giản hóa trải nghiệm desktop

**Kết quả:** người chưa dùng coding agent hoàn thành flow mà không cấu hình kỹ thuật.

Phần việc:

- Bỏ tìm/cài/chọn coding agent khỏi flow chính, trình bày quyền lợi và usage dễ hiểu.
- Consent Ask một lần mỗi meeting, giữ qua reopen/thay transcript; Ask/Retry
  vẫn explicit. Transcribe không đổi consent. Trạng thái lỗi/partial/unverified
  và đường hỏi tiếp phải dùng được, không xem là polish.
- Paywall không làm mất ngữ cảnh; không tự chạy AI sau mua theo policy E1.
- Giữ phần Apple sheet do hệ thống sở hữu; không mở rộng sang redesign toàn bộ app.

Điều kiện hoàn tất:

- [ ] Flow thực được quan sát trên app, gồm thành công, cancel, lỗi và hết quota.
- [ ] Không cần agent/API key; UI không lộ provider internals hoặc secrets.
- [ ] Paywall đóng/mở giữ cuộc họp; purchase/restore cập nhật đúng trạng thái.
- [ ] Nội dung consent/quyền lợi khớp product và backend; keyboard/focus cơ bản dùng được.

**Reopen:** UX cần thêm product policy hoặc không khớp API/capability thực.

### E7: Bảo toàn dữ liệu và chuyển phiên bản

**Kết quả:** cài mới và update từ bản cũ dùng được, giữ recording/transcript/chat.

Phần việc:

- Kiểm kê định dạng hiện hữu; chốt hiển thị chat cũ và tiếp tục bằng Managed Ask.
- Không tự upload/xử lý AI với dữ liệu cũ khi update.
- Ngừng dùng provider local trong flow mới; chỉ dọn phần đã chứng minh không còn cần.
- Thiết kế backup/recovery trước migration; không reset TCC, data hoặc keys để né lỗi.

Điều kiện hoàn tất:

- [ ] Upgrade exact candidate giữ audio/transcript/chat và mở/nghe lại được.
- [ ] Fresh install không cần cấu hình agent; continuation chat theo policy đã duyệt.
- [ ] Update không tự upload/gọi AI; migration bị gián đoạn có recovery được kiểm chứng.
- [ ] Không đổi identity/trust hoặc xóa dữ liệu ngoài quyền; giữ các failed/unknown results riêng.

**Reopen:** phát hiện migration khó đảo ngược, mất dữ liệu hoặc cần thay identity;
owner quyết định rủi ro trước khi vận hành.

### E8: Nghiệm thu end-to-end và chuẩn bị phát hành

**Kết quả:** bằng chứng đầy đủ cho exact Apple-distributed candidate và giới hạn phát hành rõ ràng.

Phần việc và điều kiện hoàn tất:

- [ ] Rà sớm trước mở rộng implementation: đối chiếu release gates/lỗi V1,
  exact package/runtime/startup/permissions, không cần agent, Store/IAP offer,
  Production configuration và privacy/disclosure/review metadata. Dùng yêu cầu
  Apple hiện hành khi thực hiện audit; plan này chưa chứng minh compliance.
- [ ] Ghi riêng khoảng cách Sandbox–Production và từng quyết định còn thuộc Human;
  chưa có quyền không gọi đó là technical pass. Không chờ polish để báo blocker.
- [ ] Cài mới → recording → purchase/restore → Transcribe → Ask → nghe dẫn chứng trên TestFlight.
- [ ] Quit/relaunch và upgrade giữ dữ liệu thực; không cần coding agent.
- [ ] Nhánh lỗi mạng, quota và subscription khớp policy; giữ evidence thất bại/chưa thử riêng.
- [ ] Rà lại các release gates/lỗi V1 còn tồn tại (startup, permissions, branding, native validation...);
  ghi disposition theo relevance, không coi epic mới tự xóa backlog cũ.
- [ ] Consent, privacy, retention và mô tả gói khớp hành vi thật.
- Rà sớm 2026-09-18 (read-only, chưa external audit):
  `docs/release/app-store-submission.md` còn copy lịch sử “Ask riêng khỏi Premium”,
  trial bảy ngày/monthly+annual. Không còn khớp pivot, không dùng nguyên draft để
  submit; disposition **phải cập nhật sau E3 offer**, owner Lead nội dung, Human
  offer/submission. Không sửa ASC trong lượt này. Current managed adapter chủ
  động từ chối Production; disposition **cần route/config và quyền Production
  trước release**, không suy từ Sandbox success. Hai mục này là release blockers
  đã thấy sớm, không cản bounded E4 recovery.
- [ ] Lead kiểm tra exact artifact/provenance và chấp nhận hoặc từ chối có lý do.
- [ ] Kế hoạch/product cập nhật trạng thái và remaining limits; chỉ chuyển completed sau validation.

**Giới hạn:** technical acceptance không phải Apple approval. E2 TestFlight
upload/distribution đã có quyền; App Review, publication và Production cần
quyền riêng. Annual/Production/platforms
chưa thử phải ghi rõ, không suy từ monthly Sandbox hay một máy đã kiểm chứng.

## Risks And Recovery

- Chốt giá sớm: E3 phải dùng số đo E2 và quyết định owner trước quota implementation.
- Lặp lại fixture-first: E2 kiểm chứng trên consumer thật trước mở rộng luồng.
- Scope trượt sang mobile/sync: chỉ tạo phase sau khi owner yêu cầu, không thêm ngầm.
- Drift giữa backlog và authority: E1 cập nhật product/ADR trước implementation;
  quyết định lâu dài không chỉ nằm trong plan.
- Data loss: E7 thiết kế recovery và dùng state được phép; không xóa recording thật để thử.
- Shared scopes trong E4–E7: Lead chia ownership tuần tự, không nhiều writer cùng sửa.

## Decisions

- 2026-09-18, sau reconcile: Human nói “OK đồng ý, thế thì triển khai đi” với
  route rà foundation E2, ACCEPT có giới hạn nếu đủ evidence rồi chuyển thẳng
  sang E4 làm Ask dùng được. Quyền bao gồm sửa lỗi trong phạm vi đã chốt, không
  chọn giá/quota E3, không Production/App Review/publication. Lead quyết định SDK
  theo proof và chi phí thay đổi kỹ thuật, không hỏi Human chọn parser.
  Đây là thay phạm vi milestone có phê duyệt, không hạ chuẩn release: lỗi và
  kiểm chứng chưa đạt được chuyển rõ sang E4/E7/E8; giữ nguyên lịch sử REJECT.
- 2026-09-18, sau build 7: Human chốt contract Ask qua phỏng vấn; nội dung đầy
  đủ được lưu trong product/desktop-managed-ai.md (Accepted Ask Behavior và
  Data, Consent, And Retention). Consent một lần/meeting thay per-turn; giữ cả
  qua retranscribe. Không suy chuỗi lựa chọn số là quyền release hay chọn SDK.
- 2026-09-18: Human sẵn sàng thay chat UI để tận dụng Vercel AI SDK. Lead sẽ
  đánh giá Core + UI/transport, không chỉ provider wrapper. Chưa adopt dependency.
  Proof cần xác minh SDK qua bridge host/backend hiện hữu, không gửi credential
  ra renderer; local store vẫn authority. Lifecycle phải sống ngoài component
  đang mount để đổi meeting không hủy nhầm; close/quit vẫn yêu cầu cancel tất cả.
  Kiểm tra retries mặc định/version và tắt auto retry, persistence/partial,
  citation completion và usage unknown. SDK không tự giải quyết domain lock,
  consent, admission hay retention. Không thêm resumable cloud state/sync.
  Chọn route nhỏ nhất qua được proof; nếu SDK cần rewrite lớn hoặc phá boundary,
  Lead đưa tradeoff/route thay thế trước mở rộng. Không hứa SDK chữa invalid_answer.
- 2026-09-18: Human yêu cầu reconcile theo đích App Store, tránh mất thời gian
  polish trước khi biết đường phát hành khả thi. Lead chuyển rà E8/E7 lên P0,
  gỡ dependency E3 khỏi sửa recovery E4, giữ E3 trước offer/quota E5/release.
  Basic chat formatting đủ; full redesign/cleanup không phải release gate.
  Lượt reconcile chỉ cập nhật plan và authority docs, không implementation.
- 2026-09-18: Owner chọn mobile ở phase sau và duyệt cấu trúc một epic + tám issue.
- 2026-09-18: Owner cho phép tạo backlog, chưa ra lệnh execute.
- 2026-09-18: Do GitHub không ghi được, owner chọn theo dõi trong docs Harness;
  một plan này là nguồn trạng thái, các index chỉ liên kết.
- 2026-09-18: Owner yêu cầu bắt đầu E1 và trả lời “Đồng ý” với đề xuất Mac-only,
  subscription Transcribe/Ask, miễn phí ghi âm/đọc/nghe dữ liệu cũ, dữ liệu AI
  giới hạn cuộc họp, consent chủ động và backend retention 24 giờ/xóa sớm.
  Quyền chỉ gồm chốt policy và cập nhật docs, không gồm paid AI/upload.
- Chưa chốt ở E3: giá, trial/quota mới, credit chung hay riêng, model và usage
  settlement mới cho Ask. Model E2 đã chọn riêng, không chốt model sản phẩm E3;
  khác biệt privacy mới đáng kể phải hỏi lại owner.
- 2026-09-18, chỉ thị Human: “Lead toàn quyền về sửa code, build, cài đặt.
  Dữ liệu trong meeting transcript được gửi đến AI. Dùng openai provider cho
  Ask. Chưa áp chi phí trần trải nghiệm. Toàn quyền up lên Testflight”. Quyền
  chỉ áp dụng E2; không tự đặt cost cap, model hay E3–E8 policy.
- 2026-09-18: Human trả lời “1. Chấp nhận; 2. gpt-5.6-luna; 3. Đồng ý”:
  chấp nhận retention OpenAI đã công bố, chọn model E2 và cho deploy/config
  Sandbox phục vụ TestFlight. Production giữ nguyên. Không còn chờ ba quyền này.

### E2 preparation — 2026-09-18

Các ghi nhận preparation/execution dưới đây là lịch sử build 7, không phải
assignment hiện hành. Đặc biệt consent mỗi thao tác và giữ domain không đổi đã
bị contract phỏng vấn thay thế; source acceptance cũ không chứng minh contract mới.

#### Accepted implementation route / ownership

Lead ACCEPT thiết kế sau phản biện read-only của Peer `9344e357` trên code base
`a28d0efca8cb8c28a53e798375f39e8256e64cd2`: giữ service/store/lifecycle, thay
provider port, thêm strict DTO dependency-light, consent trên cả bốn Ask/retry
entrypoints, và internal admission query trước OpenAI action. Đây là acceptance
kiến trúc, không phải runtime/candidate acceptance.

- Sandbox target đã đọc live bằng deploy credential hiện hữu:
  `posh-mink-212` / `https://posh-mink-212.convex.cloud`; CLI target có prefix
  `prod:` là loại deployment Convex, không phải Apple Production. Live env xác
  nhận `hosted-development`, `SANDBOX`, provider `real`, verifier
  `app-store-server-api`, có tên `OPENAI_API_KEY`. Không đọc/in secret ra output.
- Contract: DTO chỉ attempt ID, consent, segment IDs/text, question/history.
  Backend cố định `gpt-5.6-luna`, Responses foreground `store:false`, không tools.
  Không gửi audio/path/full TranscriptState. Validate citation IDs ở backend và
  host, record các segment đã thực sự truyền trước hoàn tất local chat.
- Admission: authenticated internal query tái dùng requirePrincipal, kiểm tra
  real Apple lineage, Sandbox, active/grace và expiry hiện tại. Không đụng quota
  transcription; E2 không áp cost cap hay định nghĩa quota/giá E3.
- Host giữ đúng một router operation, từ chối Production/unrouted trước auth/
  dispatch. Consent mỗi thao tác, kiểm tra trước tạo turn; pass xuyên async path,
  không global flag. Không auto-retry kết quả chưa rõ; timeout không chứng minh
  OpenAI đã dừng. Metadata usage/latency không chứa nội dung; unknown không là 0.
- UI fixed managed selection, không probe/chọn coding-agent trong managed flow;
  đọc lịch sử không phụ thuộc entitlement. Không migration/domain rewrite.
- Proof: exact signed TestFlight build → native enrollment thật → local transcript
  → consent/Ask → OpenAI → câu trả lời/citation/audio → relaunch giữ chat.
  Negative: missing consent ở bốn RPC, expired/revoked, wrong environment/fixture
  lineage, unknown citation. Hosted unauthorized denial cần evidence không dispatch
  provider. Local fixtures chỉ chứng minh logic, không thay proof trên app.
- Writable ownership tiếp theo: một Peer sở hữu `packages/meeting-contracts/`,
  `packages/meetless-client/`, `packages/meetless-plugin/`, `packages/meetless-app/`,
  `convex/` và focused tests trong `test/managed-ask*`. Lead không sửa các scope
  này trong assignment; Lead sở hữu docs và vận hành/build/deploy sau handback.
  Không cho Peer sửa native, store/domain, vendor, scripts, billing/transcription
  lifecycle hay deploy. Reopen nếu cần đổi policy/shared scope hoặc producer thật
  khác thiết kế. Peer phải báo exact diff/checks/limits, không tự ACCEPT E2.

- Code khảo sát: `MeetingChatService` đã có `MeetingChatAgentPort`, local thread
  persistence và lifecycle. Adapter hiện tại vẫn tạo Paseo workspace/agent và
  transcript MCP. Hướng đề xuất: giữ domain/store/citation boundary, thay port
  bằng managed backend transport; không viết lại toàn bộ Paseo.
- Backend hiện có `managedAuthActions.ts`, `deviceAuth.ts`, và OpenAI credential
  reader trong `managedConfig.ts`; cần thiết kế admission Ask tách quota
  transcription, không dùng renderer entitlement hay tự định nghĩa E3 allowance.
- Đường chứng minh dự kiến: transcript thật trong local MeetingStore → explicit
  Ask/consent → trusted host/authenticated backend → OpenAI → validated segment
  IDs → local chat → UI của exact signed Apple/TestFlight candidate. Ghi artifact
  digest/build ID, backend identity, model/config, request correlation, usage và
  latency; không log transcript/secrets. Negative: request thiếu/sai auth bị từ
  chối trước provider; citations đối chiếu segment nguồn. Còn cần thiết kế chi
  tiết và phản biện trước giao writer.
- OpenAI Docs được fetch ngày 2026-09-18:
  [Data controls](https://developers.openai.com/api/docs/guides/your-data).
  Abuse logs mặc định có thể chứa input/output, giữ tới 30 ngày với ngoại lệ
  pháp lý/an toàn lâu hơn. `store:false` không phải ZDR; prompt-cache retention
  còn phụ thuộc model/config. Chưa có bằng chứng project bật ZDR/MAM.
- ATTENTION trước đó đã được Human giải quyết: `gpt-5.6-luna`, retention OpenAI
  được chấp nhận, Sandbox deploy/config được phép. Route foreground Responses
  `store:false`, không Files/Conversations/hosted tools; chưa có live evidence.
  Không sửa Production. OpenAI model docs xác nhận Responses/structured outputs;
  account access vẫn phải thử trên actual backend credential, không suy từ docs.
- Chưa sửa runtime code, build/install, gọi inference hay upload trong lượt này.
  E2 chưa ACCEPT; authorization không thay bằng chứng chưa đạt.

#### E2 execution observations — 2026-09-18

- Writer `8037ae7a` DONE và relinquish source ownership. Candidate 17 files,
  base `a28d0efca8cb8c28a53e798375f39e8256e64cd2`; snapshot
  `/private/tmp/meetless-managed-ask-handoff.wStTYM/candidate.tar` SHA-256
  `26a4ac04aa0586876c4e12f546f54a011d611e04353452706c6dc03d7fd6409c`;
  manifest `SHA256SUMS` cùng directory SHA-256
  `08c3dbdadc0ac7d785691fbcee062c25295c3c1b406d2b2f7b534f966cee0099`.
  Lead chạy `shasum -a 256 -c` manifest: cả 17 file OK.
  Writer báo 111 focused tests + 25 chat-service tests pass; typechecks contracts,
  client, plugin, app, Convex và diff-check pass. Initial sandbox MCP tests có
  4 `listen EPERM`, rerun đúng test với loopback permission pass; không xóa failure.
  Peer read-only `b989c5c4-bdb7-4ec4-9eb4-4fe9c2975c88` inspect exact candidate;
  Lead đang chạy `npm run build` đầy đủ. Chưa ACCEPT source để deploy hay E2.
- Sau handback read-only của `b989c5c4`, Lead ACCEPT exact 17-file candidate
  trên để kiểm chứng Sandbox: consent trước turn, strict content DTO, real Apple
  current-expiry admission trước provider, citation validation hai đầu, metadata
  không content và bounded waits khớp authority. Peer không thấy blocking finding,
  xác minh lại cả 17 hashes. Đây là source acceptance, không E2/product acceptance.
  Live Sandbox configuration preflight qua CLI capture secret trong memory PASS:
  target `posh-mink-212`, hosted-development, SANDBOX, real provider,
  app-store-server-api. Production không được đọc secret hay thay đổi.
  Next: build result, deploy đúng Sandbox, hosted negative proof và exact signed
  TestFlight producer; app consent/playback/relaunch vẫn chưa được kiểm chứng.
- Lead observed `npm run build` exit 0: native policy required/PASSED, app export
  thành công. Candidate 17 hashes vẫn khớp sau build; diff-check pass.
  `convex deploy --typecheck enable --codegen disable` bằng credential khóa đúng
  `posh-mink-212`: exit 0, schema validation pass, chỉ thêm index
  `managedAskUsage.by_attempt`, không xóa index. Không đổi env hay Production.
  Package-source snapshot `bc8ace003b3d86e9634f0f250868a14b2395606b030e1790772322195ce852be`;
  backend identity theo manifest 17 files riêng (package snapshot không bao Convex).
  ASC read-only HTTP 200 xác nhận max build 6, tất cả builds 1–6 VALID.
  Producer build 7 đang chạy tại `/private/tmp/meetless-e2-build7-s37Jop/proof`.
  Hai lần invocation đầu bị guard từ chối proof-root trong repo / đã tồn tại,
  trước build; không nới guard, đổi sang child directory mới ngoài repo.
- Hosted negative proof ngày 2026-09-18 14:27 UTC: anonymous request consent false
  bị từ chối; consent true cũng bị từ chối. CLI logs correlation request IDs
  `7e0eb889337651d3` và `a65acf5633dba260` cho thấy `managedAsk:admit` fail với
  verified-active-Sandbox diagnostic trước `managedAsk:ask` fail. Source đã
  ACCEPT chỉ gọi provider sau admission resolve; đây chứng minh anonymous
  denial trước dispatch, không thay expired/revoked authenticated proof.
  Client chỉ nhận generic Server Error; backend log lỗi đã sanitize, không content.
- Provider-adapter-only live diagnostic dùng exact `convex/openAIAsk.ts`, actual
  Sandbox OpenAI credential và một transcript demo tổng hợp không nhạy cảm:
  attempt `0dd1e6b8-fa09-48f6-9dc3-3f1d6c63290e`, model `gpt-5.6-luna`, supported,
  answer “Blue.”, citation `e2-demo-1` đúng segment. Latency 3814 ms; input 172,
  output 29, total 201 tokens, cached/cache-write/reasoning 0 theo provider.
  Không suy đây là bill thực hay quota E3. Đây chỉ là provider request/parser
  proof, không phải hosted enrolled inference hay native/TestFlight proof.
- UI automation prerequisite: `osascript` query System Events `UI elements enabled`
  trả `false`. Không tự thay privacy settings. Human đã được hỏi chọn tự thao tác
  TestFlight build 7 khi sẵn sàng hoặc bật Accessibility cho verification.
  Human chọn “Tôi tự thao tác trên TestFlight”. Lead tiếp tục build/upload và
  gửi checklist sau Apple processing; không chờ hay yêu cầu bật Accessibility.
  Chưa cài đè app, chưa đụng dữ liệu cũ; các UI gates tiếp tục pending.
- Build 7 distribution producer exit 0: clean rebuild, native tests required/PASSED,
  Apple Distribution signature verified, installer payload matches app, source
  snapshot không đổi. Lead ACCEPT exact package cho Apple validation/internal
  TestFlight upload, không phải runtime/product acceptance.
  Installer SHA-256 `21ffedc2f91bfc55d6dcfda8680b7f5c4a76a8509c8cbc8743b0cccb6ebaf64f`;
  app artifact digest `d8cb44ecaa197e4d6b762aa6bbe176328e9470c65c268c6b4376260b778430df`;
  signed CDHash `b065cc0e2b93a0305faa76bc9cda175fd34fe80c` (Apple may re-sign).
  Lead `cmp` packaged managed adapter/contract JS với current build output: match.
  Exact installer, manifests, source tar/hash manifest được copy giữ tại
  `.artifacts/macos-mas-distribution/20260918-e2-build7/`; copied pkg hash khớp.
  Apple validation đang chạy qua bounded runner
  `.artifacts/app-store-upload/20260918-e2-build7/run-apple.mjs`; upload chỉ chạy
  sau validation exit 0 của đúng digest. App data vẫn không đổi.
- Apple `altool --validate-app` exit 0 lúc 2026-09-18 14:41:50 UTC,
  “No errors validating archive”, exact pkg digest khớp. Evidence
  `.artifacts/app-store-upload/20260918-e2-build7/validate.{result,stdout}.json`.
  Upload cùng digest đang chạy; chưa suy upload/processing đã đạt.
- Apple `altool --upload-app` exit 0 lúc 2026-09-18 14:46:33 UTC, “No errors
  uploading archive”, delivery UUID `1d593d25-b5c0-47b8-8684-bfcccd1f8b85`,
  transferred 320403992 bytes. Evidence `upload.{result,stdout}.json` cùng thư mục
  validation; exact digest không đổi. ASC GET build7 ngay sau upload HTTP 200
  nhưng chưa có record; processing/readiness chưa được suy là thành công.
- ASC recheck 2026-09-18 14:52:16 UTC HTTP 200 vẫn chưa có build7 record;
  query latest builds cũng chỉ có 6/5 VALID. Không reupload, không claim TestFlight
  ready hay coi pending ingestion là failed. Frontier: Apple ingestion/processing,
  rồi Human manual proof theo lựa chọn của Human. Checklist cho đúng 1.0 (7):
  update qua TestFlight không uninstall/reset; mở meeting/transcript cũ; Ask rồi
  Cancel phải không tạo lượt; Ask/Confirm câu hỏi có nguồn rõ; kiểm tra câu trả lời
  và citation audio; quit/reopen giữ chat, không tự gửi thêm. Ghi thời điểm/lỗi
  nếu có để Lead correlate backend usage/admission; không gửi lại liên tục.
- Writer: `8037ae7a-55b8-4451-904a-068032853949`, scope/contract ở trên.
  Read-only architecture Peer đã DONE; không còn ownership ghi của Peer đó.
- Lead kiểm tra actual Sandbox credential bằng GET OpenAI
  `/v1/models/gpt-5.6-luna`: HTTP 200, returned ID đúng. Không gửi transcript,
  không inference; đây chỉ là access proof, chưa phải Ask proof.
- App Store Connect read-only HTTP 200: builds 1–6 hiện VALID; build 6 là
  build-number cao nhất quan sát được. App đang cài version build 6, signed
  Sandbox URL `https://posh-mink-212.convex.cloud`. Không upload trong check này.
- `npm run build:native` với native-test-policy mặc định `required`: FAILED exit 1
  ở Debug `MeetlessHostTests`: “actual packaged Node desktop must register and
  attest its detached daemon through native host protocol”. Native build/link
  Debug/Release thành công; Release test chưa chạy vì Debug fail. Đây là blocker
  packaging/TestFlight, không được đổi thành passed hay dùng ngoại lệ V1 cũ.
  Lead đang chẩn đoán scope native read-only; writer Ask tiếp tục độc lập.
- Lead ACCEPT kết luận giới hạn của Peer read-only `dafd7d98`: runtime dist cũ
  pin `a2c8ff…`, khác source/test marker `249539…`; đây là blocker chắc chắn nếu
  execution tới `prepareRuntime`, chưa chứng minh vị trí child bị chặn thực tế.
  SHA-256 dist cũ: `cdbac25b3e9c21054c346587a61fc715b678126065775c78dae1a0d8304fc2c3`.
  Full `build-all.mjs` đã đúng thứ tự TypeScript trước native; chỉ standalone
  native/pretest/host:install có prerequisite/order chưa bảo đảm. Không kết luận
  clean full-build bị sai. Empty stderr không chứng minh startup thành công.
  Lead chạy `tsc -p packages/runtime/tsconfig.json --pretty false`: exit 0,
  dist pin đã khớp source. Không dùng `tsc -b` để tránh rebuild scope của writer.
  Debug native executable không đổi, chạy bằng Node wrapper với
  `MEETLESS_TEST_PACKAGE_NODE_SOURCE=process.execPath`: PASS exit 0, in
  “Meetless native transcription boundary tests passed”. Runtime dist mới có
  SHA-256 `99157f74d763d79ae3f4cbbf00adee4ea8cf57f56ded814c0236c285c9d16f33`.
  Đây xác nhận stale output góp phần gây lỗi; không sửa test/native source hay
  nới tiêu chí. Release executable chạy bằng cùng wrapper cũng PASS exit 0,
  cùng thông báo boundary tests passed. Lead ACCEPT kết quả bounded native
  protocol check này; không phải TestFlight acceptance. Lần thất bại ban đầu
  vẫn được giữ ở trên. Producer distribution vẫn phải chạy native gates required
  trên candidate tích hợp sau handback.
- [OpenAI model docs](https://developers.openai.com/api/docs/models/gpt-5.6-luna)
  xác nhận model hỗ trợ Responses/structured outputs; credential access đã kiểm
  tra riêng như trên. [Pricing](https://developers.openai.com/api/docs/pricing)
  fetch ngày 2026-09-18: Standard short-context USD/million tokens input 0.20,
  cached input 0.02, cache writes 0.25, output 1.20. Long-context rates khác;
  chỉ tính ước lượng sau khi có actual usage/cache/service tier, không coi là bill.

## Validation

### E4 recovery local candidate — 2026-09-18

Writer DONE, ownership về Lead. Candidate snapshot
`/private/tmp/meetless-e4-recovery.FmqQUV/candidate.tar` SHA-256
`4b413bce51f52cef41809964a6afe8b8dce366fee66033136f1c345eb7ec2714`;
`candidate.diff`, `files.sha256` và red/green verification logs cùng thư mục.
Production diff chỉ `meeting-domain/src/index.ts`: cho failed/inactive bắt đầu
câu mới, vẫn từ chối running/non-null active; diagnostic chỉ rõ thread và rule.
Ba test files kiểm tra domain, real store và real managed service; không đổi
schema/provider/UI. Synthetic transport fault không phải live OpenAI proof.

- Writer báo regression domain/store/service fail trước fix, pass sau fix;
  focused 56 tests và broader domain/store/service 83 tests pass. Lần sandbox
  ban đầu 4 loopback EPERM, rerun đúng tests với quyền loopback pass. Một test
  assertion ban đầu nhầm wire với durable fields đã sửa test, không đổi interface.
- Lead inspect toàn bộ exact diff và test mới; `shasum -a 256 -c files.sha256`
  4/4 OK, snapshot digest khớp. Manifest E2 17/17 vẫn OK, không overwrite E2.
- Lead tự chạy `./node_modules/.bin/vitest run --config vitest.config.ts packages/meeting-domain/test/chat.test.ts packages/meeting-store/test/chat-store.test.ts packages/meetless-plugin/test/managed-chat-recovery.test.ts test/managed-ask.test.ts test/managed-ask-ui.test.ts`:
  **58/58 pass**, exit 0. `./node_modules/.bin/tsc -p
  packages/meeting-domain/tsconfig.json --noEmit --pretty false` và
  `git diff --check`: exit 0.
- Local proof: success → failure → explicit retry failure → new question success,
  4 explicit dispatches, none on reopen, old messages/attempts preserved;
  concurrency/stale retry denied. `encode-invariant` dùng existing Vitest owner.
  Không thấy applicable hook/CI invocation; branch protection chưa xác minh.
- Fresh read-only Peer `1a2270a5-8da8-4e1c-a011-a2d76e980e8a` DONE, không
  blocking finding, hash trước/sau khớp. Lead xác minh lại 4/4 hashes và archive,
  **ACCEPT exact candidate cho source/local integration**: sửa đúng gate đã
  xác định, giữ schema/history/concurrency/retry. Không ACCEPT toàn E4.
  Chưa build/package/deploy/upload,
  không sửa installed TestFlight app hoặc dữ liệu thật. E4 runtime chưa đạt.

### E2 narrow integration acceptance — 2026-09-18

Theo thay đổi milestone được Human đồng ý, Lead ACCEPT E2 integration feasibility,
không đảo ngược REJECT chất lượng runtime build 7 và không ACCEPT release.
Đầu vào downstream: actual TestFlight first Ask + backend usage, hosted anonymous
denial, exact artifact/source provenance và inspection call path. Hai lỗi
`invalid_answer`/lock vẫn nguyên ở bảng build 7 bên dưới, owner tiếp theo E4.

- Lead `shasum -a 256 -c` durable manifest: 17/17 OK; Peer read-only
  `00a3eb8c-1b82-4027-b152-829a493eff09` độc lập xác minh cùng source và pkg
  `21ffedc2f91bfc55d6dcfda8680b7f5c4a76a8509c8cbc8743b0cccb6ebaf64f`,
  không blocking finding cho phạm vi hẹp. Package-source snapshot và backend
  source identities giữ như execution evidence, không đánh đồng hai snapshot.
- Lead đối chiếu producer với installed build 7: `server.js`, `managed-ask.js`,
  `chat-service.js` và `meeting-contracts/dist/managed-ask.js` có SHA khớp.
  Service luôn chọn managed port, không dùng tham số Paseo/agent auth/fallback;
  provider credential chỉ backend. Legacy agent code vẫn packaged, không xóa.
- Bounded check import installed JS dưới local Node, isolated temp store,
  Paseo proxy ném lỗi nếu bị truy cập: service initialize/controls/close pass,
  0 agent API reads, provider openai. Scratch giữ tại
  `/var/folders/07/p5pz8vnd0cx_1hll7nsmrm9c0000gn/T/meetless-e2-no-agent-BbdLwJ`.
  Đây không phải clean-machine/native inference proof. Thử gọi bundled Node
  trực tiếp trước đó exit 133, không output; không dùng lần đó làm pass hay
  kết luận app startup lỗi (đường chạy khác LaunchServices).
- Admission/source inspection: request/consent → authenticated device/principal
  → real Apple Sandbox/current expiry → provider. Hosted anonymous denial trước
  dispatch đã ghi ở execution evidence; expired/revoked authenticated live test
  còn ở E5/E8. Không sửa entitlement thật để tạo negative test.
- OpenAI Docs skill search/fetch lại
  [data controls](https://developers.openai.com/api/docs/guides/your-data):
  abuse retention tới 30 ngày với ngoại lệ, foreground store:false không phải
  ZDR, encrypted prompt cache có tối đa 24h. Request body và disclosure trong
  exact source khớp phạm vi này. Không chứng minh cấu hình org/project ZDR/MAM,
  deletion nội bộ OpenAI hay infrastructure-wide retention. Ask application code
  không lưu content vào mutation/scheduler/log; usage chỉ metadata. Không gọi
  inference mới, deploy, upload hay thay provider configuration trong audit.
- Clean install/no-agent-machine và startup chuẩn: E7/E8. Citation playback,
  retry/new question và relaunch: E4/E7. Consent một lần/meeting chưa có trong
  build 7 (vẫn per-operation), phải triển khai theo contract mới ở E4/E6.

### Release-first reconciliation — 2026-09-18

Lead ACCEPT bản reconcile tài liệu: đưa release/data/architecture risk lên P0,
giữ contract phỏng vấn và bằng chứng build 7, không cấp thêm quyền external.
Peer read-only `6bb2d3dc-543b-4a5a-96dc-fe9aee7552ae` đọc cả ba tài liệu,
không có blocking finding; Lead xác minh lại đúng SHA-256 trước ghi acceptance:

- Product: `8c790ec76c7ff19ee3101c9ef4ec15d34160af73fd70dabc1127131e5f53fcc4`.
- ADR0008: `92460b29d44430fc22f6667c483f1d708dd16e45a05beb56ae4c8e3badf78a26`.
- Plan trước đoạn acceptance này: `80b142beac096483667dcc25576f6aa405848cb308d9b84e864cbecbe6c04e9f`.

`git diff --check` và `git diff --no-index --check /dev/null <file>` cho từng
tài liệu đều pass; Node read-only check xác nhận 16 local file targets trong
ba tài liệu tồn tại, không kiểm tra heading anchors. Không sửa code, build,
runtime test, inference, deploy hay upload. Không có writable Peer active.
Acceptance này chỉ cho kế hoạch/authority nhất quán; release-risk audit và
proof parser/recovery/SDK còn là việc tiếp theo, không phải kết quả đã đạt.

### E2 internal distribution checkpoint — 2026-09-18

Prior handoff was incomplete: upload succeeded, but build 7 was subsequently
VALID / READY_FOR_BETA_TESTING and absent from Meetless Internal. This was a
missing distribution step, not an Ask runtime pass or a reason to reupload.
Under existing E2 TestFlight authority, Lead resolved only that relationship:

- Exact app `6807070739`, build `1d593d25-b5c0-47b8-8684-bfcccd1f8b85` (7),
  existing internal group `5c7491b1-1c64-4077-abd1-2bd3e28c075b` (Meetless Internal).
- Live preflight at 15:05:05 UTC: matching app/build, VALID, internal group,
  six existing build memberships; build 7 absent, READY_FOR_BETA_TESTING.
- `POST /v1/betaGroups/{id}/relationships/builds` with only that build ID:
  HTTP 204. No tester, group settings, external distribution or App Review changes.
- Fresh GET membership and buildBetaDetail at 15:05:10 UTC: versions 7–1 present,
  build 7 membership verified, internalBuildState IN_BETA_TESTING,
  autoNotifyEnabled true. External state remains READY_FOR_BETA_SUBMISSION;
  no external submission was performed. Command exited 0.
- Lead ACCEPTS the internal-distribution checkpoint based on these live reads.
  At this checkpoint, actual appearance/install and consent/Ask/audio/relaunch
  were unverified. Subsequent Human runtime evidence is recorded below; the
  distribution success remains valid and does not imply product acceptance.

Human handoff: refresh TestFlight and install 1.0 (7) without uninstall/reset;
confirm old transcript exists; Cancel Ask consent leaves no new turn; confirm a
source-grounded Ask, play its citation, quit/reopen and confirm persisted chat
without automatic new dispatch. Report outcome/time or screenshot for correlation.

### E2 build-7 runtime evidence and unresolved failure — 2026-09-18

Evidence sources: Human reports running build 7 from TestFlight, asking an
existing meeting with a saved transcript, then failing on “Hello”, retry and
new questions. The attached screenshot shows the first answer with a citation,
the next user message and the operational-error/retry UI. This is Human-observed
runtime evidence, not a Lead-observed playback or persistence test. Candidate
identity is the build-7 package/ASC ID above; installed Apple re-sign identity
was not independently captured during this interaction.

Lead read-only diagnosis used Sandbox `posh-mink-212` only:
`convex data managedAskUsage --limit 25 --format json` and
`convex logs --history 100 --success --jsonl` (bounded log stream), projecting
only usage/status/correlation metadata and sanitized errors. No transcript or
raw provider response was logged or retained by this diagnostic. Observations:

| UTC time | Attempt ID | Request ID | Observed status | Input/output/total tokens | Latency |
| --- | --- | --- | --- | --- | --- |
| 15:07:54.382 | `633b029c-5b21-48ee-8306-577360b18915` | `13a823759bfa47c4` | supported | 407 / 72 / 479 | 4390 ms |
| 15:08:20.590 | `787b83c9-486a-43c2-9f42-bd11c610b299` | `402f99cca39402e0` | invalid_answer | 446 / 24 / 470 | 1957 ms |
| 15:09:31.101 | `25945064-702d-4474-b5d2-93506d9f992d` | `deb3c8c760c1908d` | invalid_answer | 446 / 24 / 470 | 1613 ms |

All three usage records report model `gpt-5.6-luna` and cached input, cache-write
and reasoning tokens 0. Billed cost remains unknown. Logs correlate admission
and usage recording with each request; the latter two Ask actions then fail.
These failures reached OpenAI and returned usage/output tokens: not an admission
denial or failure to reach the provider for these two attempts. Matching to the
Human sequence is based on report/screenshot and temporal ordering, not retained
request content; no additional new-question provider call was observed here.

Keep the unresolved boundary explicit: `convex/openAIAsk.ts` sets `invalid_answer`
after reading the response body/usage, before checking completion status,
message/content shape, JSON parsing and `parseManagedAskAnswer` semantics/citations.
The exact rejected field/branch is UNKNOWN. Do not assert that “Hello” necessarily
caused a specific schema defect, that OpenAI returned a valid no-evidence answer,
or that changing SDK will fix it. Under the current contract, insufficient evidence
is a valid completed outcome, distinct from an operational failure.

Recovery consequence is separately established by source inspection:
`startChatQuestion` in `packages/meeting-domain/src/index.ts` permits new turns
only when thread status is `ready`; a `failed` thread is rejected even with no
active attempt. `retryChatAttempt` retries the last failed user turn. Together
with the Human report, this explains why a failed “Hello” can trap the thread:
retry repeats the failing path and new questions cannot bypass it. It does not
establish a loss of transcript/history or failure of all meetings.

Lead disposition: ACCEPT the bounded evidence that build 7 launched and one
real existing-transcript Ask succeeded; retain both subsequent failures and
REJECT E2 runtime completion for this candidate. Prior source/package/internal
distribution acceptance is not erased or promoted to product acceptance.
Citation playback, cancel-without-dispatch, relaunch persistence, and the
no-coding-agent environment remain unverified by this report.

At the diagnostic handoff, next bounded work before implementation/SDK choice was to isolate the failing response
boundary with content-safe reason codes or an authorized non-sensitive repro;
trace failed-turn recovery against existing policy; specify proof for initial
success → no-evidence input → explicit retry → new question → quit/reopen,
including preserved history, valid citations and no automatic dispatch. Do not
weaken validation, log raw meeting content, clear history, add automatic retries,
or expand paid/live calls solely to make the gate pass. No implementation was
performed by the diagnostic or this documentation update. Vercel AI SDK Core is
an option discussed, not an adopted dependency or accepted remedy; any proposed
adapter change must retain consent, admission, retention and local-store ownership.
The subsequent interview resolves off-topic/recovery/consent/lifecycle behavior
in the current product contract; the rejected parser branch remains unknown.
Current sequencing and authority are in Approach And Progress. No later product
decision erases these failures or establishes a fix; Production stays closed.

### E1 documentation validation

E1 chỉ nghiệm thu policy/documentation, không chứng minh runtime. Candidate gồm
product/desktop-managed-ai.md, ADR0008, các authority notices/index và plan này.
Ngày 2026-09-18, Lead ACCEPT: nội dung khớp phê duyệt owner, có precedence rõ
với V1, giữ failed/unknown evidence, tách quyền E2 và quyết định kinh tế E3.
Peer đọc độc lập `8b21db7f-88c2-49fb-928a-8633d3f3fa4a` trả DONE, không có
blocking finding. Lead đối chiếu lại hash và kiểm tra exact candidate:

- Base commit: `a28d0efca8cb8c28a53e798375f39e8256e64cd2`.
- Product SHA-256: `b147cb992fb24658672a11b0f8a382abcc3fde53c431a79898cc8ededcf94f4f`.
- ADR0008 SHA-256: `7f3dbb0a0bae204675237b80d1c07c8439e840cb3adb589c7d8a502907e81403`.
- Plan trước cập nhật acceptance: `f1e6c6377dee22184782db124318331732955d473d4951079ffb1236e1e45725`.
- `git diff --check`: pass. Node read-only link check: 15 tài liệu, 82 local
  file targets tồn tại; không kiểm tra heading anchors. Peer xác minh độc lập
  cùng kết quả. `shasum -a 256` xác nhận các identity trên.

Sau review, chỉ đổi trạng thái/acceptance trong plan và active index; không đổi
policy. Runtime enforcement và provider retention vẫn chưa kiểm chứng.
Không build/test runtime, gọi AI, upload hay purchase trong E1.

Khi execute: mỗi mục ghi candidate/commit, môi trường, lệnh/bước tái lập, kết quả
thực, vị trí evidence đã lược bỏ thông tin riêng và quyết định acceptance. Local
tests chỉ chứng minh phạm vi local; App Store/runtime proof theo production-evidence.

## Result

E1 hoàn tất: product/ADR được owner duyệt về policy và Lead chấp nhận bản ghi.
E2 đã đóng có giới hạn integration feasibility; E4 recovery source/local đã
ACCEPT exact candidate, chưa tích hợp vào TestFlight. E3 offer và release gates
chưa hoàn tất. Đầu vào dùng được là
product/desktop-managed-ai.md và ADR0008 đã cập nhật đủ quyền/model/retention/
Sandbox cùng source/package đã ACCEPT cho verification. Native gate và Apple
validation, upload, processing và internal-group distribution đã pass. Human
xác nhận build 7 chạy và Ask đầu thành công; backend ghi nhận một supported và
hai invalid_answer. Parser/validation branch chưa rõ; failed-thread gate chặn
câu hỏi mới. Broad runtime completion của build 7 vẫn bị REJECT; không dùng
closure integration E2 để tuyên bố lỗi đã sửa. E4 nhận phần remediation;
chưa chọn SDK. Bằng chứng thành công và thất bại cùng được giữ.
Provider-only demo trước đó 201 tokens vẫn là bằng chứng riêng; billed cost chưa
biết. Không có product/release acceptance hay Production changes. Tiếp theo là
xử lý E4 invalid_answer/no-evidence và route SDK theo proof, rồi candidate tích
hợp/recovery qua UI thật. Không polish toàn app hay coi source pass là release.
