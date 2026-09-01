import Foundation

#if canImport(RevenueCat)
import RevenueCat
#endif

#if canImport(StoreKit)
import StoreKit
#endif

let meetlessPremiumEntitlement = "premium"
let meetlessPremiumAppBundle = "com.meetless.app"
let meetlessPremiumMonthlyProduct = "com.meetless.app.premium.monthly"
let meetlessPremiumAnnualProduct = "com.meetless.app.premium.annual"

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
}

func meetlessPremiumPurchaseOutcome(succeeded: Bool, userCancelled: Bool, accessStatus: String) -> String {
  if userCancelled { return "cancelled" }
  return succeeded && accessStatus == "active" ? "active" : "failed"
}

final class MeetlessRevenueCatPurchaseAccess: MeetlessPremiumPurchaseAccess {
  #if canImport(RevenueCat)
  private let purchases: Purchases?

  init(apiKey: String? = Bundle.main.object(forInfoDictionaryKey: "MeetlessRevenueCatAPIKey") as? String) {
    guard let key = apiKey?.trimmingCharacters(in: .whitespacesAndNewlines), key.hasPrefix("appl_"), key.count > 8 else {
      purchases = nil
      return
    }
    purchases = Purchases.isConfigured ? Purchases.shared : Purchases.configure(withAPIKey: key)
  }

  func status() -> MeetlessPremiumAccessResult {
    guard let purchases else { return .unavailable("not_configured") }
    guard let customerInfo = wait(timeout: 15, start: { completion in
      DispatchQueue.main.async { purchases.getCustomerInfo { info, _ in completion(info) } }
    }) else { return .unavailable("store_unavailable") }
    return access(purchases: purchases, customerInfo: customerInfo)
  }

  func purchase(packageId: String) -> MeetlessPremiumMutationResult {
    guard let purchases else {
      return MeetlessPremiumMutationResult(outcome: "failed", access: .unavailable("not_configured"))
    }
    guard let package = packageForPurchase(purchases: purchases, packageId: packageId) else {
      return MeetlessPremiumMutationResult(outcome: "failed", access: status())
    }
    let result = wait(timeout: 300, start: { completion in
      DispatchQueue.main.async {
        purchases.purchase(package: package) { transaction, customerInfo, error, userCancelled in
          completion((transaction?.productIdentifier, customerInfo, error == nil, userCancelled))
        }
      }
    })
    guard let result else {
      return MeetlessPremiumMutationResult(outcome: "failed", access: .unavailable("store_unavailable"))
    }
    let nextAccess = result.1.map { access(purchases: purchases, customerInfo: $0) } ?? status()
    let signedTransaction = result.3 == false && result.2 && nextAccess.status == "active"
      ? signedTransactionFor(productId: result.0 ?? package.storeProduct.productIdentifier)
      : nil
    return MeetlessPremiumMutationResult(
      outcome: meetlessPremiumPurchaseOutcome(
        succeeded: result.2,
        userCancelled: result.3,
        accessStatus: nextAccess.status
      ),
      access: nextAccess,
      appleSignedTransaction: signedTransaction
    )
  }

  func restore() -> MeetlessPremiumMutationResult {
    guard let purchases else {
      return MeetlessPremiumMutationResult(outcome: "failed", access: .unavailable("not_configured"))
    }
    guard let customerInfo = wait(timeout: 120, start: { completion in
      DispatchQueue.main.async { purchases.restorePurchases { info, _ in completion(info) } }
    }) else {
      return MeetlessPremiumMutationResult(outcome: "failed", access: .unavailable("store_unavailable"))
    }
    let nextAccess = access(purchases: purchases, customerInfo: customerInfo)
    let signedTransaction = nextAccess.status == "active" ? signedTransactionForActiveManagedProduct() : nil
    return MeetlessPremiumMutationResult(
      outcome: nextAccess.status == "active" && signedTransaction != nil ? "active" : "failed",
      access: nextAccess,
      appleSignedTransaction: signedTransaction
    )
  }

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
    guard packageId == "monthly" || packageId == "annual" else { return nil }
    let expectedProduct = packageId == "monthly" ? meetlessPremiumMonthlyProduct : meetlessPremiumAnnualProduct
    let expectedType: PackageType = packageId == "monthly" ? .monthly : .annual
    guard let offerings = wait(timeout: 15, start: { completion in
      DispatchQueue.main.async { purchases.getOfferings { value, _ in completion(value) } }
    }) else { return nil }
    return offerings.current?.availablePackages.first {
      $0.packageType == expectedType && $0.storeProduct.productIdentifier == expectedProduct
    }
  }

  #if canImport(StoreKit)
  private func signedTransactionFor(productId: String) -> String? {
    guard productId == meetlessPremiumMonthlyProduct || productId == meetlessPremiumAnnualProduct else { return nil }
    return wait(timeout: 30, start: { completion in
      Task {
        guard let result = await StoreKit.Transaction.latest(for: productId) else {
          completion(nil)
          return
        }
        switch result {
        case .verified(let transaction):
          guard transaction.productID == productId,
                transaction.appBundleID == meetlessPremiumAppBundle,
                transaction.environment == .sandbox else {
            completion(nil)
            return
          }
          completion(result.jwsRepresentation)
        case .unverified:
          completion(nil)
        }
      }
    })
  }

  private func signedTransactionForActiveManagedProduct() -> String? {
    wait(timeout: 60, start: { completion in
      Task {
        for await result in StoreKit.Transaction.currentEntitlements {
          guard case .verified(let transaction) = result,
                transaction.productID == meetlessPremiumMonthlyProduct || transaction.productID == meetlessPremiumAnnualProduct,
                transaction.appBundleID == meetlessPremiumAppBundle,
                transaction.environment == .sandbox,
                transaction.revocationDate == nil,
                transaction.expirationDate.map({ $0 > Date() }) ?? true else { continue }
          completion(result.jwsRepresentation)
          return
        }
        completion(nil)
      }
    })
  }
  #else
  private func signedTransactionFor(productId: String) -> String? { nil }
  private func signedTransactionForActiveManagedProduct() -> String? { nil }
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
  #endif
}

private final class MeetlessResultBox<Value>: @unchecked Sendable {
  private let lock = NSLock()
  private var value: Value?
  func store(_ next: Value?) { lock.lock(); value = next; lock.unlock() }
  func load() -> Value? { lock.lock(); defer { lock.unlock() }; return value }
}
