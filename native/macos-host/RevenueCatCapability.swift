import Foundation

#if canImport(RevenueCat)
import RevenueCat
#endif

#if canImport(AppKit)
import AppKit
#endif

#if canImport(StoreKit)
import StoreKit
#endif

let meetlessPremiumEntitlement = "premium"
let meetlessPremiumAppBundle = "com.meetless.app"
let meetlessPremiumMonthlyProduct = "com.meetless.app.premium.monthly"
let meetlessPremiumAnnualProduct = "com.meetless.app.premium.annual"

enum MeetlessPremiumDiagnosticStage: String {
  case trustedNativeInvocation = "trusted_native_invocation"
  case presentationReadiness = "presentation_readiness"
  case storeKitCallback = "storekit_callback"
  case trustedNativeCompletion = "trusted_native_completion"
}

enum MeetlessPremiumDiagnosticOutcome: String {
  case invoked
  case ready
  case unsupported
  case unavailable
  case busy
  case mainThread = "main_thread"
  case active
  case cancelled
  case pending
  case failed
}

struct MeetlessPremiumDiagnostic: Equatable {
  let stage: MeetlessPremiumDiagnosticStage
  let outcome: MeetlessPremiumDiagnosticOutcome
}

protocol MeetlessPremiumDiagnosticSink {
  func record(_ diagnostic: MeetlessPremiumDiagnostic)
}

func meetlessPremiumDiagnosticLine(_ diagnostic: MeetlessPremiumDiagnostic) -> String {
  "MEETLESS_PREMIUM_DIAGNOSTIC v1 stage=\(diagnostic.stage.rawValue) outcome=\(diagnostic.outcome.rawValue)"
}

final class MeetlessPremiumStandardErrorDiagnosticSink: MeetlessPremiumDiagnosticSink {
  func record(_ diagnostic: MeetlessPremiumDiagnostic) {
    FileHandle.standardError.write(Data((meetlessPremiumDiagnosticLine(diagnostic) + "\n").utf8))
  }
}

struct MeetlessPremiumPackage {
  let packageId: String
  let productId: String
  let localizedPrice: String
  let trialEligible: Bool
}

struct MeetlessPremiumAccessResult {
  let status: String
  let packages: [MeetlessPremiumPackage]
  let reason: String?

  static func unavailable(_ reason: String) -> MeetlessPremiumAccessResult {
    MeetlessPremiumAccessResult(status: "unavailable", packages: [], reason: reason)
  }
}

struct MeetlessPremiumMutationResult {
  let outcome: String
  let access: MeetlessPremiumAccessResult
  let appleSignedTransaction: String?

  init(outcome: String, access: MeetlessPremiumAccessResult, appleSignedTransaction: String? = nil) {
    self.outcome = outcome
    self.access = access
    self.appleSignedTransaction = appleSignedTransaction
  }
}

protocol MeetlessPremiumPurchaseAccess {
  func status() -> MeetlessPremiumAccessResult
  func purchase(packageId: String) -> MeetlessPremiumMutationResult
  func restore() -> MeetlessPremiumMutationResult
  func recover() -> MeetlessPremiumMutationResult?
}

func meetlessPremiumPurchaseOutcome(succeeded: Bool, userCancelled: Bool, accessStatus: String) -> String {
  if userCancelled { return "cancelled" }
  return succeeded && accessStatus == "active" ? "active" : "failed"
}

/// A successful StoreKit callback is not yet a managed Premium result. The
/// opaque transaction must still be verified and enrolled by the backend
/// before the public plugin/UI contract can report active.
func meetlessPremiumVerifiedPurchaseOutcome(
  succeeded: Bool,
  userCancelled: Bool,
  hasSignedTransaction: Bool
) -> String {
  if userCancelled { return "cancelled" }
  return succeeded && hasSignedTransaction ? "pending" : "failed"
}

#if canImport(RevenueCat)
func meetlessPremiumExpectedPurchase(for packageId: String) -> (productId: String, packageType: PackageType)? {
  switch packageId {
  case "monthly": return (meetlessPremiumMonthlyProduct, .monthly)
  case "annual": return (meetlessPremiumAnnualProduct, .annual)
  default: return nil
  }
}
#endif

#if canImport(AppKit)
final class MeetlessPremiumPresentationAnchor: NSObject, NSWindowDelegate {
  typealias WindowFactory = () -> NSWindow?
  typealias WindowPresenter = (NSWindow) -> Bool
  typealias WindowVisibility = (NSWindow) -> Bool

  private let windowFactory: WindowFactory
  private let windowPresenter: WindowPresenter
  private let windowVisibility: WindowVisibility
  private var window: NSWindow?

  init(
    windowFactory: @escaping WindowFactory = { MeetlessPremiumPresentationAnchor.makeDefaultWindow() },
    windowPresenter: @escaping WindowPresenter = { MeetlessPremiumPresentationAnchor.presentDefaultWindow($0) },
    windowVisibility: @escaping WindowVisibility = { $0.isVisible && !$0.isMiniaturized }
  ) {
    self.windowFactory = windowFactory
    self.windowPresenter = windowPresenter
    self.windowVisibility = windowVisibility
    super.init()
  }

  var isPresented: Bool {
    if Thread.isMainThread { return window.map(windowVisibility) == true }
    return DispatchQueue.main.sync { self.window.map(self.windowVisibility) == true }
  }

  func isCurrentAndPresented(_ candidate: NSWindow) -> Bool {
    if Thread.isMainThread {
      return candidate === window && windowVisibility(candidate)
    }
    return DispatchQueue.main.sync {
      candidate === self.window && self.windowVisibility(candidate)
    }
  }

  func acquire() -> NSWindow? {
    if Thread.isMainThread { return acquireOnMain() }
    return DispatchQueue.main.sync { acquireOnMain() }
  }

  func release() {
    if Thread.isMainThread {
      releaseOnMain()
    } else {
      DispatchQueue.main.sync { self.releaseOnMain() }
    }
  }

  func windowWillClose(_ notification: Notification) {
    guard let closed = notification.object as? NSWindow, closed === window else { return }
    window = nil
  }

  func windowShouldClose(_ window: NSWindow) -> Bool {
    guard window === self.window else { return true }
    return false
  }

  func windowDidMiniaturize(_ notification: Notification) {
    guard let minimized = notification.object as? NSWindow, minimized === window else { return }
    minimized.deminiaturize(nil)
    minimized.makeKeyAndOrderFront(nil)
  }

  private func acquireOnMain() -> NSWindow? {
    assert(Thread.isMainThread)
    if let window {
      if windowVisibility(window) {
        return window
      }
      window.delegate = nil
      window.orderOut(nil)
      window.close()
      self.window = nil
    }
    guard let next = windowFactory() else { return nil }
    next.delegate = self
    next.isReleasedWhenClosed = false
    next.styleMask.remove([.closable, .miniaturizable])
    next.isMovable = false
    window = next
    guard windowPresenter(next), windowVisibility(next) else {
      next.delegate = nil
      next.orderOut(nil)
      next.close()
      window = nil
      return nil
    }
    return next
  }

  private func releaseOnMain() {
    assert(Thread.isMainThread)
    guard let current = window else { return }
    window = nil
    current.delegate = nil
    current.orderOut(nil)
    current.close()
  }

  private static func presentDefaultWindow(_ window: NSWindow) -> Bool {
    assert(Thread.isMainThread)
    window.center()
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    return window.isVisible && !window.isMiniaturized
  }

  private static func makeDefaultWindow() -> NSWindow? {
    assert(Thread.isMainThread)
    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 420, height: 160),
      styleMask: [.titled],
      backing: .buffered,
      defer: false
    )
    window.title = "Meetless Premium"
    window.isMovable = false
    let content = NSView()
    let message = NSTextField(labelWithString: "Meetless is opening Apple’s purchase confirmation.")
    message.alignment = .center
    message.maximumNumberOfLines = 0
    message.lineBreakMode = .byWordWrapping
    message.translatesAutoresizingMaskIntoConstraints = false
    content.addSubview(message)
    NSLayoutConstraint.activate([
      message.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 24),
      message.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -24),
      message.centerYAnchor.constraint(equalTo: content.centerYAnchor),
    ])
    window.contentView = content
    return window
  }
}

#if canImport(RevenueCat)
struct MeetlessPremiumStoreCallback {
  let productId: String?
  let customerInfo: CustomerInfo?
  let error: Error?
  let userCancelled: Bool
}

func meetlessPremiumStoreCallbackOutcome(_ callback: MeetlessPremiumStoreCallback) -> MeetlessPremiumDiagnosticOutcome {
  if callback.userCancelled { return .cancelled }
  if callback.error != nil { return .failed }
  return .active
}

enum MeetlessPremiumCallbackOperationResult {
  case callback(MeetlessPremiumStoreCallback)
  case unavailable
  case busy
  case mainThread
}

final class MeetlessPremiumCallbackOperation {
  typealias Invoker = (NSWindow?, @escaping (MeetlessPremiumStoreCallback) -> Void) -> Void
  typealias PresentationDiagnostic = (MeetlessPremiumDiagnosticOutcome) -> Void
  typealias CallbackObserver = (MeetlessPremiumStoreCallback) -> Void

  private let anchor: MeetlessPremiumPresentationAnchor?
  private let mutationLock: NSLock
  private let invoke: Invoker

  init(
    anchor: MeetlessPremiumPresentationAnchor?,
    mutationLock: NSLock,
    invoke: @escaping Invoker
  ) {
    self.anchor = anchor
    self.mutationLock = mutationLock
    self.invoke = invoke
  }

  func run(
    onPresentationDiagnostic: PresentationDiagnostic? = nil,
    onCallback: CallbackObserver? = nil
  ) -> MeetlessPremiumCallbackOperationResult {
    guard !Thread.isMainThread else { return .mainThread }
    guard mutationLock.try() else { return .busy }
    defer { mutationLock.unlock() }

    let window: NSWindow?
    if let anchor {
      guard let acquired = anchor.acquire() else {
        onPresentationDiagnostic?(.unavailable)
        return .unavailable
      }
      window = acquired
      onPresentationDiagnostic?(.ready)
    } else {
      window = nil
    }

    let semaphore = DispatchSemaphore(value: 0)
    let resultBox = MeetlessResultBox<MeetlessPremiumCallbackOperationResult>()
    let callbackLock = NSLock()
    var callbackAccepted = false
    let accept: (MeetlessPremiumCallbackOperationResult) -> Void = { result in
      callbackLock.lock()
      guard !callbackAccepted else {
        callbackLock.unlock()
        return
      }
      callbackAccepted = true
      callbackLock.unlock()
      if case .callback(let callback) = result {
        onCallback?(callback)
      }
      resultBox.store(result)
      semaphore.signal()
    }
    let finish: (MeetlessPremiumStoreCallback) -> Void = { callback in
      accept(.callback(callback))
    }

    DispatchQueue.main.async {
      if let anchor = self.anchor {
        guard let window, anchor.isCurrentAndPresented(window) else {
          onPresentationDiagnostic?(.unavailable)
          accept(.unavailable)
          return
        }
      }
      self.invoke(window, finish)
    }
    semaphore.wait()
    anchor?.release()
    return resultBox.load() ?? .unavailable
  }
}

struct MeetlessPremiumPurchaseParameters {
  let params: PurchaseParams
  let confirmationWindow: NSWindow?
}

func meetlessPremiumPurchaseParameters(
  package: Package,
  confirmationWindow: NSWindow?
) -> MeetlessPremiumPurchaseParameters {
  let builder = PurchaseParams.Builder(package: package)
  if #available(macOS 15.2, *), let confirmationWindow {
    return MeetlessPremiumPurchaseParameters(
      params: builder.with(confirmInWindow: confirmationWindow).build(),
      confirmationWindow: confirmationWindow
    )
  }
  return MeetlessPremiumPurchaseParameters(params: builder.build(), confirmationWindow: nil)
}
#endif
#endif

#if canImport(RevenueCat)
enum MeetlessPremiumOperationKind: Equatable {
  case purchase(String)
  case restore
}

struct MeetlessPremiumOperationLease {
  let id: String
  let kind: MeetlessPremiumOperationKind
}

enum MeetlessPremiumOperationDecision {
  case started(MeetlessPremiumOperationLease)
  case pending(MeetlessPremiumAccessResult)
  case terminal(MeetlessPremiumMutationResult)
}

/**
 * A single host-owned operation slot. StoreKit callbacks can arrive after the
 * request socket has closed, so terminal state is retained until a later
 * trusted plugin retry consumes it. The opaque lease ID prevents a late
 * callback from completing a newer operation.
 */
final class MeetlessPremiumOperationSlot {
  private struct Entry {
    let lease: MeetlessPremiumOperationLease
    let pendingAccess: MeetlessPremiumAccessResult
    var terminal: MeetlessPremiumMutationResult?
  }

  private let lock = NSLock()
  private var entry: Entry?

  func begin(
    kind: MeetlessPremiumOperationKind,
    pendingAccess: MeetlessPremiumAccessResult
  ) -> MeetlessPremiumOperationDecision {
    lock.lock()
    defer { lock.unlock() }
    if let current = entry {
      if let terminal = current.terminal {
        entry = nil
        return .terminal(terminal)
      }
      return .pending(current.pendingAccess)
    }
    let lease = MeetlessPremiumOperationLease(id: UUID().uuidString, kind: kind)
    entry = Entry(lease: lease, pendingAccess: pendingAccess, terminal: nil)
    return .started(lease)
  }

  func pendingAccess() -> MeetlessPremiumAccessResult? {
    lock.lock()
    defer { lock.unlock() }
    return entry?.pendingAccess
  }

  func recover() -> MeetlessPremiumMutationResult? {
    lock.lock()
    defer { lock.unlock() }
    guard let terminal = entry?.terminal else { return nil }
    entry = nil
    return terminal
  }

  func complete(_ lease: MeetlessPremiumOperationLease, result: MeetlessPremiumMutationResult) {
    lock.lock()
    defer { lock.unlock() }
    guard entry?.lease.id == lease.id, entry?.terminal == nil else { return }
    entry?.terminal = result
  }
}
#endif

final class MeetlessRevenueCatPurchaseAccess: MeetlessPremiumPurchaseAccess {
  #if canImport(RevenueCat)
  private let purchases: Purchases?
  private let operationSlot = MeetlessPremiumOperationSlot()
  private let diagnosticSink: MeetlessPremiumDiagnosticSink
  #if canImport(AppKit)
  private let presentationAnchor: MeetlessPremiumPresentationAnchor
  #endif

  #if canImport(AppKit)
  init(
    apiKey: String? = Bundle.main.object(forInfoDictionaryKey: "MeetlessRevenueCatAPIKey") as? String,
    diagnosticSink: MeetlessPremiumDiagnosticSink = MeetlessPremiumStandardErrorDiagnosticSink(),
    presentationAnchor: MeetlessPremiumPresentationAnchor = MeetlessPremiumPresentationAnchor()
  ) {
    self.diagnosticSink = diagnosticSink
    self.presentationAnchor = presentationAnchor
    self.purchases = Self.configuredPurchases(apiKey: apiKey)
  }
  #else
  init(
    apiKey: String? = Bundle.main.object(forInfoDictionaryKey: "MeetlessRevenueCatAPIKey") as? String,
    diagnosticSink: MeetlessPremiumDiagnosticSink = MeetlessPremiumStandardErrorDiagnosticSink()
  ) {
    self.diagnosticSink = diagnosticSink
    self.purchases = Self.configuredPurchases(apiKey: apiKey)
  }
  #endif

  private static func configuredPurchases(apiKey: String?) -> Purchases? {
    guard let key = apiKey?.trimmingCharacters(in: .whitespacesAndNewlines), key.hasPrefix("appl_"), key.count > 8 else {
      return nil
    }
    return Purchases.isConfigured ? Purchases.shared : Purchases.configure(withAPIKey: key)
  }

  func status() -> MeetlessPremiumAccessResult {
    if let pending = operationSlot.pendingAccess() { return pending }
    guard !Thread.isMainThread else { return .unavailable("store_unavailable") }
    guard let purchases else { return .unavailable("not_configured") }
    guard let customerInfo = wait(timeout: 15, start: { completion in
      DispatchQueue.main.async { purchases.getCustomerInfo { info, _ in completion(info) } }
    }) else { return .unavailable("store_unavailable") }
    return access(purchases: purchases, customerInfo: customerInfo)
  }

  func recover() -> MeetlessPremiumMutationResult? {
    #if canImport(RevenueCat)
    guard !Thread.isMainThread else { return nil }
    return operationSlot.recover()
    #else
    return nil
    #endif
  }

  func purchase(packageId: String) -> MeetlessPremiumMutationResult {
    guard !Thread.isMainThread else {
      diagnosticSink.record(MeetlessPremiumDiagnostic(stage: .trustedNativeInvocation, outcome: .mainThread))
      return failedMutation(access: .unavailable("store_unavailable"))
    }
    diagnosticSink.record(MeetlessPremiumDiagnostic(stage: .trustedNativeInvocation, outcome: .invoked))
    guard let purchases else {
      return failedMutation(access: .unavailable("not_configured"))
    }
    guard meetlessPremiumExpectedPurchase(for: packageId) != nil else {
      return failedMutation(access: .unavailable("store_unavailable"))
    }
    let pendingAccess = MeetlessPremiumAccessResult(status: "inactive", packages: [], reason: nil)
    switch operationSlot.begin(kind: .purchase(packageId), pendingAccess: pendingAccess) {
    case .pending(let access):
      diagnosticSink.record(MeetlessPremiumDiagnostic(stage: .trustedNativeInvocation, outcome: .busy))
      recordCompletion(outcome: "pending")
      return MeetlessPremiumMutationResult(outcome: "pending", access: access)
    case .terminal(let result):
      return result
    case .started(let lease):
      startPurchase(lease: lease, purchases: purchases, packageId: packageId)
      recordCompletion(outcome: "pending")
      return MeetlessPremiumMutationResult(outcome: "pending", access: pendingAccess)
    }
  }

  func restore() -> MeetlessPremiumMutationResult {
    guard !Thread.isMainThread else {
      diagnosticSink.record(MeetlessPremiumDiagnostic(stage: .trustedNativeInvocation, outcome: .mainThread))
      return failedMutation(access: .unavailable("store_unavailable"))
    }
    diagnosticSink.record(MeetlessPremiumDiagnostic(stage: .trustedNativeInvocation, outcome: .invoked))
    if let recovered = operationSlot.recover() {
      recordCompletion(outcome: recovered.outcome)
      return recovered
    }
    guard let purchases else {
      return failedMutation(access: .unavailable("not_configured"))
    }
    let pendingAccess = MeetlessPremiumAccessResult(status: "inactive", packages: [], reason: nil)
    switch operationSlot.begin(kind: .restore, pendingAccess: pendingAccess) {
    case .pending(let access):
      diagnosticSink.record(MeetlessPremiumDiagnostic(stage: .trustedNativeInvocation, outcome: .busy))
      recordCompletion(outcome: "pending")
      return MeetlessPremiumMutationResult(outcome: "pending", access: access)
    case .terminal(let result):
      return result
    case .started(let lease):
      startRestore(lease: lease, purchases: purchases)
      recordCompletion(outcome: "pending")
      return MeetlessPremiumMutationResult(outcome: "pending", access: pendingAccess)
    }
  }

  #if canImport(AppKit)
  private func startPurchase(
    lease: MeetlessPremiumOperationLease,
    purchases: Purchases,
    packageId: String
  ) {
    DispatchQueue.main.async {
      purchases.getOfferings { [weak self] offerings, _ in
        guard let self else { return }
        DispatchQueue.main.async {
          guard let package = offerings?.current?.availablePackages.first(where: {
            guard let expected = meetlessPremiumExpectedPurchase(for: packageId) else { return false }
            return $0.packageType == expected.packageType && $0.storeProduct.productIdentifier == expected.productId
          }) else {
            self.finish(lease: lease, result: MeetlessPremiumMutationResult(
              outcome: "failed",
              access: .unavailable("store_unavailable")
            ))
            return
          }
          let operationAnchor: MeetlessPremiumPresentationAnchor?
          if #available(macOS 15.2, *) {
            operationAnchor = self.presentationAnchor
          } else {
            self.diagnosticSink.record(MeetlessPremiumDiagnostic(stage: .presentationReadiness, outcome: .unsupported))
            operationAnchor = nil
          }
          let window = operationAnchor?.acquire()
          guard operationAnchor == nil || window != nil else {
            self.finish(lease: lease, result: MeetlessPremiumMutationResult(
              outcome: "failed",
              access: .unavailable("store_unavailable")
            ))
            return
          }
          let parameters = meetlessPremiumPurchaseParameters(package: package, confirmationWindow: window)
          var callbackAccepted = false
          let callbackLock = NSLock()
          purchases.purchase(parameters.params) { [weak self] transaction, customerInfo, error, userCancelled in
            callbackLock.lock()
            guard !callbackAccepted else {
              callbackLock.unlock()
              return
            }
            callbackAccepted = true
            callbackLock.unlock()
            let callback = MeetlessPremiumStoreCallback(
              productId: transaction?.productIdentifier,
              customerInfo: customerInfo,
              error: error,
              userCancelled: userCancelled
            )
            self?.resolvePurchase(lease: lease, package: package, callback: callback, hasAnchor: operationAnchor != nil)
          }
        }
      }
    }
  }

  private func startRestore(lease: MeetlessPremiumOperationLease, purchases: Purchases) {
    DispatchQueue.main.async {
      var callbackAccepted = false
      let callbackLock = NSLock()
      purchases.restorePurchases { [weak self] customerInfo, error in
        callbackLock.lock()
        guard !callbackAccepted else {
          callbackLock.unlock()
          return
        }
        callbackAccepted = true
        callbackLock.unlock()
        let callback = MeetlessPremiumStoreCallback(
          productId: nil,
          customerInfo: customerInfo,
          error: error,
          userCancelled: false
        )
        self?.resolveRestore(lease: lease, callback: callback)
      }
    }
  }

  private func resolvePurchase(
    lease: MeetlessPremiumOperationLease,
    package: Package,
    callback: MeetlessPremiumStoreCallback,
    hasAnchor: Bool
  ) {
    recordStoreKitCallback(callback)
    let releaseAnchor = { [weak self] in
      guard hasAnchor else { return }
      DispatchQueue.main.async { self?.presentationAnchor.release() }
    }
    if callback.userCancelled || callback.error != nil {
      releaseAnchor()
      let outcome = callback.userCancelled ? "cancelled" : "failed"
      finish(lease: lease, result: MeetlessPremiumMutationResult(
        outcome: outcome,
        access: inactiveAccess(for: package)
      ))
      return
    }
    let productId = callback.productId ?? package.storeProduct.productIdentifier
    Task { [weak self] in
      guard let self else { return }
      let signedTransaction = await self.signedTransactionFor(productId: productId)
      releaseAnchor()
      guard let signedTransaction else {
        self.finish(lease: lease, result: MeetlessPremiumMutationResult(
          outcome: "failed",
          access: inactiveAccess(for: package)
        ))
        return
      }
      let access = MeetlessPremiumAccessResult(
        status: "active",
        packages: [MeetlessPremiumPackage(
          packageId: package.packageType == .monthly ? "monthly" : "annual",
          productId: package.storeProduct.productIdentifier,
          localizedPrice: package.storeProduct.localizedPriceString,
          trialEligible: false
        )],
        reason: nil
      )
      self.finish(lease: lease, result: MeetlessPremiumMutationResult(
        outcome: meetlessPremiumVerifiedPurchaseOutcome(succeeded: true, userCancelled: false, hasSignedTransaction: true),
        access: access,
        appleSignedTransaction: signedTransaction
      ))
    }
  }

  private func resolveRestore(lease: MeetlessPremiumOperationLease, callback: MeetlessPremiumStoreCallback) {
    recordStoreKitCallback(callback)
    guard callback.error == nil else {
      finish(lease: lease, result: MeetlessPremiumMutationResult(
        outcome: "failed",
        access: .unavailable("store_unavailable")
      ))
      return
    }
    Task { [weak self] in
      guard let self else { return }
      guard let signedTransaction = await self.signedTransactionForActiveManagedProduct() else {
        self.finish(lease: lease, result: MeetlessPremiumMutationResult(
          outcome: "failed",
          access: .unavailable("store_unavailable")
        ))
        return
      }
      self.finish(lease: lease, result: MeetlessPremiumMutationResult(
        outcome: "pending",
        access: MeetlessPremiumAccessResult(status: "active", packages: [], reason: nil),
        appleSignedTransaction: signedTransaction
      ))
    }
  }

  private func finish(lease: MeetlessPremiumOperationLease, result: MeetlessPremiumMutationResult) {
    operationSlot.complete(lease, result: result)
    recordCompletion(outcome: result.outcome)
  }

  private func inactiveAccess(for package: Package) -> MeetlessPremiumAccessResult {
    MeetlessPremiumAccessResult(
      status: "inactive",
      packages: [MeetlessPremiumPackage(
        packageId: package.packageType == .monthly ? "monthly" : "annual",
        productId: package.storeProduct.productIdentifier,
        localizedPrice: package.storeProduct.localizedPriceString,
        trialEligible: false
      )],
      reason: nil
    )
  }
  #else
  private func startPurchase(lease: MeetlessPremiumOperationLease, purchases: Purchases, packageId: String) {
    finish(lease: lease, result: MeetlessPremiumMutationResult(outcome: "failed", access: .unavailable("store_unavailable")))
  }

  private func startRestore(lease: MeetlessPremiumOperationLease, purchases: Purchases) {
    finish(lease: lease, result: MeetlessPremiumMutationResult(outcome: "failed", access: .unavailable("store_unavailable")))
  }

  private func finish(lease: MeetlessPremiumOperationLease, result: MeetlessPremiumMutationResult) {
    operationSlot.complete(lease, result: result)
    recordCompletion(outcome: result.outcome)
  }
  #endif

  private func access(purchases: Purchases, customerInfo: CustomerInfo) -> MeetlessPremiumAccessResult {
    let active = customerInfo.entitlements[meetlessPremiumEntitlement]?.isActive == true
    guard let offerings = wait(timeout: 15, start: { completion in
      DispatchQueue.main.async { purchases.getOfferings { value, _ in completion(value) } }
    }), let offering = offerings.current else {
      return active
        ? MeetlessPremiumAccessResult(status: "active", packages: [], reason: nil)
        : .unavailable("store_unavailable")
    }
    let candidates = offering.availablePackages.filter { package in
      package.storeProduct.productIdentifier == meetlessPremiumMonthlyProduct ||
        package.storeProduct.productIdentifier == meetlessPremiumAnnualProduct
    }
    let productIds = candidates.map(\.storeProduct.productIdentifier)
    let eligibility = wait(timeout: 15, start: { completion in
      DispatchQueue.main.async {
        purchases.checkTrialOrIntroDiscountEligibility(productIdentifiers: productIds, completion: completion)
      }
    }) ?? [:]
    let packages = candidates.compactMap { package -> MeetlessPremiumPackage? in
      let productId = package.storeProduct.productIdentifier
      let packageId: String
      if productId == meetlessPremiumMonthlyProduct && package.packageType == .monthly { packageId = "monthly" }
      else if productId == meetlessPremiumAnnualProduct && package.packageType == .annual { packageId = "annual" }
      else { return nil }
      let hasFreeTrial = package.storeProduct.introductoryDiscount?.paymentMode == .freeTrial
      return MeetlessPremiumPackage(
        packageId: packageId,
        productId: productId,
        localizedPrice: package.storeProduct.localizedPriceString,
        trialEligible: hasFreeTrial && eligibility[productId]?.status == .eligible
      )
    }.sorted { $0.packageId == "monthly" && $1.packageId == "annual" }
    return MeetlessPremiumAccessResult(status: active ? "active" : "inactive", packages: packages, reason: nil)
  }

  private func packageForPurchase(purchases: Purchases, packageId: String) -> Package? {
    guard let expected = meetlessPremiumExpectedPurchase(for: packageId) else { return nil }
    guard let offerings = wait(timeout: 15, start: { completion in
      DispatchQueue.main.async { purchases.getOfferings { value, _ in completion(value) } }
    }) else { return nil }
    return offerings.current?.availablePackages.first {
      $0.packageType == expected.packageType && $0.storeProduct.productIdentifier == expected.productId
    }
  }

  private func failedMutation(access: MeetlessPremiumAccessResult) -> MeetlessPremiumMutationResult {
    recordCompletion(outcome: "failed")
    return MeetlessPremiumMutationResult(outcome: "failed", access: access)
  }

  #if canImport(AppKit)
  private func failedInteractiveMutation(_ result: MeetlessPremiumCallbackOperationResult) -> MeetlessPremiumMutationResult {
    let outcome: MeetlessPremiumDiagnosticOutcome
    switch result {
    case .callback:
      outcome = .failed
    case .unavailable:
      outcome = .unavailable
    case .busy:
      outcome = .busy
    case .mainThread:
      outcome = .mainThread
    }
    diagnosticSink.record(MeetlessPremiumDiagnostic(stage: .trustedNativeInvocation, outcome: outcome))
    return failedMutation(access: .unavailable("store_unavailable"))
  }

  private func recordStoreKitCallback(_ callback: MeetlessPremiumStoreCallback) {
    diagnosticSink.record(MeetlessPremiumDiagnostic(
      stage: .storeKitCallback,
      outcome: meetlessPremiumStoreCallbackOutcome(callback)
    ))
  }
  #endif

  private func recordCompletion(outcome: String) {
    let normalized: MeetlessPremiumDiagnosticOutcome
    switch outcome {
    case "active": normalized = .active
    case "cancelled": normalized = .cancelled
    case "pending": normalized = .pending
    default: normalized = .failed
    }
    diagnosticSink.record(MeetlessPremiumDiagnostic(stage: .trustedNativeCompletion, outcome: normalized))
  }

  #if canImport(StoreKit)
  private func signedTransactionFor(productId: String) async -> String? {
    guard productId == meetlessPremiumMonthlyProduct || productId == meetlessPremiumAnnualProduct else { return nil }
    guard let result = await StoreKit.Transaction.latest(for: productId) else { return nil }
    switch result {
    case .verified(let transaction):
      guard transaction.productID == productId,
            transaction.appBundleID == meetlessPremiumAppBundle,
            transaction.environment == .sandbox else { return nil }
      return result.jwsRepresentation
    case .unverified:
      return nil
    }
  }

  private func signedTransactionForActiveManagedProduct() async -> String? {
    for await result in StoreKit.Transaction.currentEntitlements {
      guard case .verified(let transaction) = result,
            transaction.productID == meetlessPremiumMonthlyProduct || transaction.productID == meetlessPremiumAnnualProduct,
            transaction.appBundleID == meetlessPremiumAppBundle,
            transaction.environment == .sandbox,
            transaction.revocationDate == nil,
            transaction.expirationDate.map({ $0 > Date() }) ?? true else { continue }
      return result.jwsRepresentation
    }
    return nil
  }
  #else
  private func signedTransactionFor(productId: String) async -> String? { nil }
  private func signedTransactionForActiveManagedProduct() async -> String? { nil }
  #endif

  private func wait<Value>(timeout: TimeInterval, start: (@escaping (Value?) -> Void) -> Void) -> Value? {
    let semaphore = DispatchSemaphore(value: 0)
    let box = MeetlessResultBox<Value>()
    start { value in
      box.store(value)
      semaphore.signal()
    }
    guard semaphore.wait(timeout: .now() + timeout) == .success else { return nil }
    return box.load()
  }
  #else
  init(apiKey: String? = nil) {}
  func status() -> MeetlessPremiumAccessResult { .unavailable("not_configured") }
  func purchase(packageId: String) -> MeetlessPremiumMutationResult {
    MeetlessPremiumMutationResult(outcome: "failed", access: .unavailable("not_configured"))
  }
  func restore() -> MeetlessPremiumMutationResult {
    MeetlessPremiumMutationResult(outcome: "failed", access: .unavailable("not_configured"))
  }
  func recover() -> MeetlessPremiumMutationResult? { nil }
  #endif
}

private final class MeetlessResultBox<Value>: @unchecked Sendable {
  private let lock = NSLock()
  private var value: Value?
  func store(_ next: Value?) { lock.lock(); value = next; lock.unlock() }
  func load() -> Value? { lock.lock(); defer { lock.unlock() }; return value }
}
