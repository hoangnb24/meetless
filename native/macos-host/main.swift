import AppKit

let application = NSApplication.shared
private let delegate = HostDelegate()
application.setActivationPolicy(.accessory)
application.delegate = delegate
application.run()
