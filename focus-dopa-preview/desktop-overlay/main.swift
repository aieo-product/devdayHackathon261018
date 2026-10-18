import AppKit
import WebKit

// This helper receives visual events only. It never accesses the camera, screen,
// keyboard, or the shared API credentials.
struct BridgeConfiguration: Decodable {
    let url: String
    let token: String

    var origin: URL? {
        guard let value = URL(string: url), value.scheme == "http",
              value.host == "127.0.0.1", value.port != nil,
              value.user == nil, value.password == nil,
              value.query == nil, value.fragment == nil,
              value.path.isEmpty || value.path == "/" else { return nil }
        return value
    }

    static func read(_ path: String) -> BridgeConfiguration? {
        guard path.hasPrefix("/"),
              let data = try? Data(contentsOf: URL(fileURLWithPath: path)), data.count < 4096,
              let config = try? JSONDecoder().decode(Self.self, from: data),
              config.origin != nil, (16...512).contains(config.token.count),
              !config.token.contains("\r"), !config.token.contains("\n") else { return nil }
        return config
    }
}

struct OverlayEvent: Decodable {
    let action: String
    let sequence: Int64
    let sourceId: String
    let character: String?
    let message: String?
    let kind: String?
    let intensity: String?
    let reduced: Bool?
    let createdAt: Double

    var age: TimeInterval { Date().timeIntervalSince1970 - createdAt / 1000 }
    var isFresh: Bool { age >= -2 && age < 6 }

    var payload: [String: Any] {
        ["action": action, "sequence": sequence, "sourceId": sourceId,
         "character": ["green", "cloud", "cat"].contains(character ?? "") ? character! : "green",
         "message": String((message ?? "いまの作業に戻ろう！").prefix(280)),
         "kind": kind == "test" ? "test" : "detect",
         "intensity": ["max", "pop", "off"].contains(intensity ?? "") ? intensity! : "max",
         "reduced": (reduced ?? false) || NSWorkspace.shared.accessibilityDisplayShouldReduceMotion,
         "createdAt": createdAt]
    }
}

struct PollResponse: Decodable {
    let event: OverlayEvent?
    let sequence: Int64
}

final class PassivePanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

final class OverlaySurface: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    let panel: PassivePanel
    let webView: WKWebView
    private let origin: URL
    private var ready = false
    private var pending: OverlayEvent?
    private var hideTimer: Timer?
    private var generation = 0
    private var activeIdentity: String?
    private var loadFailed = false

    init(screen: NSScreen, origin: URL) {
        self.origin = origin
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.mediaTypesRequiringUserActionForPlayback = .all
        webView = WKWebView(frame: NSRect(origin: .zero, size: screen.frame.size), configuration: configuration)
        panel = PassivePanel(contentRect: screen.frame,
                             styleMask: [.borderless, .nonactivatingPanel],
                             backing: .buffered, defer: false)
        super.init()

        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.ignoresMouseEvents = true
        panel.acceptsMouseMovedEvents = false
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.level = .screenSaver
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.isMovable = false
        panel.animationBehavior = .none
        panel.contentView = webView
        panel.setFrame(screen.frame, display: false)

        webView.autoresizingMask = [.width, .height]
        webView.setValue(false, forKey: "drawsBackground")
        webView.underPageBackgroundColor = .clear
        webView.navigationDelegate = self
        webView.uiDelegate = self
        configuration.userContentController.add(self, name: "overlayReady")
        configuration.userContentController.add(self, name: "overlayFinished")
        loadPage()
    }

    private func loadPage() {
        ready = false
        loadFailed = false
        webView.load(URLRequest(url: origin.appendingPathComponent("desktop-overlay.html"),
                               cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 5))
    }

    func reloadAfterFailure() {
        if loadFailed && !webView.isLoading { loadPage() }
    }

    func show(_ event: OverlayEvent) {
        guard event.isFresh, event.action == "detect" else { return }
        clear()
        pending = event
        // An event waiting for WebKit may not become a stale surprise later.
        let remaining = min(5, max(0, 5 - event.age))
        guard remaining > 0 else { pending = nil; return }
        let timer = Timer(timeInterval: remaining, repeats: false) { [weak self] _ in self?.clear() }
        RunLoop.main.add(timer, forMode: .common)
        hideTimer = timer
        if ready { playPending() }
    }

    private func playPending() {
        guard ready, let event = pending, event.isFresh else { return }
        pending = nil
        let expectedGeneration = generation
        activeIdentity = "\(event.sourceId):\(event.sequence)"
        webView.callAsyncJavaScript("window.focusOverlay.play(event)",
                                    arguments: ["event": event.payload], in: nil, in: .page) { [weak self] result in
            guard let self = self, self.generation == expectedGeneration else { return }
            switch result {
            case .success:
                // orderFrontRegardless never activates this accessory application.
                self.panel.orderFrontRegardless()
            case .failure:
                self.clear()
            }
        }
    }

    func clear() {
        generation += 1
        activeIdentity = nil
        pending = nil
        hideTimer?.invalidate()
        hideTimer = nil
        panel.orderOut(nil)
        if ready { webView.evaluateJavaScript("window.focusOverlay?.clear()", completionHandler: nil) }
    }

    func close() {
        clear()
        webView.stopLoading()
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "overlayReady")
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "overlayFinished")
        panel.close()
    }

    private func sameOrigin(_ url: URL?) -> Bool {
        guard let url = url else { return false }
        return url.scheme == origin.scheme && url.host == origin.host && url.port == origin.port
            && url.user == nil && url.password == nil
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, sameOrigin(message.frameInfo.request.url) else { return }
        if message.name == "overlayReady" {
            ready = true
            playPending()
        } else if message.name == "overlayFinished",
                  let body = message.body as? [String: Any],
                  let sequence = body["sequence"] as? NSNumber,
                  let sourceId = body["sourceId"] as? String,
                  activeIdentity == "\(sourceId):\(sequence.int64Value)" {
            // JavaScript can finish early; the native five-second deadline is the failsafe.
            panel.orderOut(nil)
            hideTimer?.invalidate()
            hideTimer = nil
            activeIdentity = nil
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let url = navigationAction.request.url
        decisionHandler(sameOrigin(url) && url?.path == "/desktop-overlay.html" ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        guard sameOrigin(navigationResponse.response.url),
              let response = navigationResponse.response as? HTTPURLResponse,
              response.statusCode == 200 else { decisionHandler(.cancel); return }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { clear(); ready = false; loadFailed = true }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { clear(); ready = false; loadFailed = true }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { clear(); loadPage() }

    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) { decisionHandler(.deny) }
}

final class NoRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private let bridgeFile: String
    private var configuration: BridgeConfiguration?
    private var surfaces: [OverlaySurface] = []
    private var statusItem: NSStatusItem?
    private let connectionItem = NSMenuItem(title: "デスクトップ演出：接続待ち", action: nil, keyEquivalent: "")
    private var pollTimer: Timer?
    private var pollInFlight = false
    private var sequence: Int64 = 0
    private var synchronizing = true
    private var lastCharacter = "green"
    private var lastConfigCheck = Date.distantPast
    private let redirects = NoRedirects()
    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 2
        config.timeoutIntervalForResource = 3
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.httpShouldSetCookies = false
        config.urlCache = nil
        return URLSession(configuration: config, delegate: redirects, delegateQueue: nil)
    }()

    init(bridgeFile: String) { self.bridgeFile = bridgeFile }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        item.button?.image = NSImage(systemSymbolName: "sparkles", accessibilityDescription: "FOCUS デスクトップ演出")
        item.button?.toolTip = "FOCUS デスクトップ演出"
        let menu = NSMenu()
        connectionItem.isEnabled = false
        menu.addItem(connectionItem)
        let test = NSMenuItem(title: "デスクトップ表示をテスト", action: #selector(testOverlay), keyEquivalent: "")
        test.target = self
        menu.addItem(test)
        menu.addItem(.separator())
        let quit = NSMenuItem(title: "デスクトップ演出を終了", action: #selector(quitApp), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)
        item.menu = menu
        statusItem = item

        NotificationCenter.default.addObserver(self, selector: #selector(screensChanged),
                                               name: NSApplication.didChangeScreenParametersNotification, object: nil)
        updateConfiguration()
        let timer = Timer(timeInterval: 0.5, repeats: true) { [weak self] _ in self?.poll() }
        RunLoop.main.add(timer, forMode: .common)
        pollTimer = timer
        poll()
    }

    private func updateConfiguration() {
        lastConfigCheck = Date()
        guard let next = BridgeConfiguration.read(bridgeFile) else {
            configuration = nil
            hideAll()
            connectionItem.title = "デスクトップ演出：接続情報待ち"
            return
        }
        guard configuration?.url != next.url || configuration?.token != next.token else { return }
        configuration = next
        sequence = 0
        synchronizing = true
        rebuildSurfaces()
    }

    private func rebuildSurfaces() {
        surfaces.forEach { $0.close() }
        surfaces.removeAll()
        guard let origin = configuration?.origin else { return }
        surfaces = NSScreen.screens.map { OverlaySurface(screen: $0, origin: origin) }
    }

    @objc private func screensChanged() { rebuildSurfaces() }

    private func poll() {
        guard !pollInFlight else { return }
        if (configuration == nil || synchronizing) && Date().timeIntervalSince(lastConfigCheck) > 2 {
            updateConfiguration()
        }
        guard let config = configuration, let origin = config.origin else { return }
        var parts = URLComponents(url: origin.appendingPathComponent("api/desktop-overlay/native/poll"), resolvingAgainstBaseURL: false)!
        parts.queryItems = [URLQueryItem(name: "after", value: String(sequence))]
        var request = URLRequest(url: parts.url!, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 2)
        request.setValue("Bearer \(config.token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        pollInFlight = true
        session.dataTask(with: request) { [weak self] data, response, error in
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.pollInFlight = false
                guard self.configuration?.token == config.token else { return }
                guard error == nil, let response = response as? HTTPURLResponse,
                      response.statusCode == 200, let data = data, data.count <= 65_536,
                      let result = try? JSONDecoder().decode(PollResponse.self, from: data), result.sequence >= 0 else {
                    self.synchronizing = true
                    self.hideAll()
                    self.connectionItem.title = "デスクトップ演出：再接続待ち"
                    return
                }
                self.connectionItem.title = "デスクトップ演出：接続中"
                self.surfaces.forEach { $0.reloadAfterFailure() }
                if self.synchronizing || result.sequence < self.sequence {
                    // Initial/reconnected polls only establish a cursor; no old alert is replayed.
                    self.synchronizing = false
                    self.sequence = result.sequence
                    self.hideAll()
                    return
                }
                let previousSequence = self.sequence
                self.sequence = result.sequence
                guard let event = result.event, event.sequence > previousSequence,
                      event.sequence <= result.sequence else { return }
                if event.action == "clear" { self.hideAll(); return }
                guard event.action == "detect", event.isFresh else { return }
                self.lastCharacter = event.character ?? "green"
                self.surfaces.forEach { $0.show(event) }
            }
        }.resume()
    }

    private func hideAll() { surfaces.forEach { $0.clear() } }

    @objc private func testOverlay() {
        guard configuration != nil else { return }
        let event = OverlayEvent(action: "detect", sequence: sequence, sourceId: "native-menu",
                                 character: lastCharacter, message: "いまの作業に戻ろう！", kind: "test",
                                 intensity: "max", reduced: false, createdAt: Date().timeIntervalSince1970 * 1000)
        surfaces.forEach { $0.show(event) }
    }

    @objc private func quitApp() { NSApp.terminate(nil) }

    func applicationWillTerminate(_ notification: Notification) {
        pollTimer?.invalidate()
        session.invalidateAndCancel()
        surfaces.forEach { $0.close() }
        NotificationCenter.default.removeObserver(self)
    }
}

let arguments = CommandLine.arguments
var bridgeFile = ProcessInfo.processInfo.environment["FOCUS_OVERLAY_BRIDGE_FILE"]
if let index = arguments.firstIndex(of: "--bridge-file"), arguments.indices.contains(index + 1) {
    bridgeFile = arguments[index + 1]
}
if bridgeFile == nil { bridgeFile = Bundle.main.object(forInfoDictionaryKey: "FOCUSOverlayBridgeFile") as? String }
guard let bridgeFile = bridgeFile, bridgeFile.hasPrefix("/") else {
    fputs("FOCUS_OVERLAY_BRIDGE_FILE must name an absolute local bridge configuration file.\n", stderr)
    exit(64)
}
let application = NSApplication.shared
let delegate = AppDelegate(bridgeFile: bridgeFile)
application.delegate = delegate
application.run()
