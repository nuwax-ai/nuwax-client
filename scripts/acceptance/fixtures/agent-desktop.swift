import Cocoa
class Delegate: NSObject, NSApplicationDelegate {
  var window: NSWindow!
  var field: NSTextField!
  var status: NSTextField!
  func applicationDidFinishLaunching(_ notification: Notification) {
    window = NSWindow(contentRect: NSRect(x: 120, y: 120, width: 400, height: 220), styleMask: [.titled, .closable], backing: .buffered, defer: false)
    window.title = "Nuwax Agent Desktop Fixture"
    field = NSTextField(frame: NSRect(x: 20, y: 140, width: 350, height: 28))
    field.stringValue = "before"
    field.setAccessibilityLabel("Fixture input")
    status = NSTextField(labelWithString: "waiting")
    status.frame = NSRect(x: 20, y: 40, width: 350, height: 25)
    status.setAccessibilityLabel("Fixture status")
    let button = NSButton(title: "Apply fixture", target: self, action: #selector(apply))
    button.frame = NSRect(x: 20, y: 85, width: 180, height: 32)
    window.contentView?.addSubview(field)
    window.contentView?.addSubview(status)
    window.contentView?.addSubview(button)
    window.orderFront(nil)
  }
  @objc func apply() { status.stringValue = "applied:" + field.stringValue }
}
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = Delegate()
app.delegate = delegate
app.run()
