import AppKit

// Runner-owned foreground surface, never a model target. Keeps background
// trials independent of which application the operator was previously using.
let ready = CommandLine.arguments[1]
let parent = getppid()
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let window = NSWindow(contentRect: NSRect(x: 80, y: 80, width: 350, height: 120),
                      styleMask: [.titled], backing: .buffered, defer: false)
window.title = "Nuwax Computer Use benchmark"
let label = NSTextField(wrappingLabelWithString: "Computer Use benchmark running.\nPlease leave the test windows in the background.")
label.frame = NSRect(x: 20, y: 20, width: 310, height: 80)
window.contentView?.addSubview(label)
window.makeKeyAndOrderFront(nil)
app.activate(ignoringOtherApps: true)
try Data("ready".utf8).write(to: URL(fileURLWithPath: ready))
let timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in
    if getppid() != parent { app.terminate(nil) }
}
app.run()
