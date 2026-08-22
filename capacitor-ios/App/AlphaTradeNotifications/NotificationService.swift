import Foundation
import UserNotifications

final class NotificationService: UNNotificationServiceExtension, URLSessionDataDelegate {
    private let maximumImageSize = 5 * 1_024 * 1_024
    private let stateLock = NSLock()

    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var originalContent: UNNotificationContent?
    private var bestAttemptContent: UNMutableNotificationContent?
    private var session: URLSession?
    private var task: URLSessionDataTask?
    private var timeoutWorkItem: DispatchWorkItem?
    private var imageData = Data()
    private var imageExtension: String?
    private var didFinish = false

    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        stateLock.lock()
        self.contentHandler = contentHandler
        originalContent = request.content
        bestAttemptContent = request.content.mutableCopy() as? UNMutableNotificationContent
        didFinish = false
        imageData.removeAll(keepingCapacity: false)
        imageExtension = nil
        stateLock.unlock()

        guard
            let aps = request.content.userInfo["aps"] as? [String: Any],
            let mutableContent = aps["mutable-content"] as? NSNumber,
            mutableContent.intValue == 1,
            let imageURLString = request.content.userInfo["imageUrl"] as? String,
            let imageURL = URL(string: imageURLString),
            imageURL.scheme?.lowercased() == "https"
        else {
            finishWithOriginalContent()
            return
        }

        let timeout = DispatchWorkItem { [weak self] in
            self?.finishWithOriginalContent()
        }
        timeoutWorkItem = timeout
        DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 8, execute: timeout)

        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 8
        configuration.timeoutIntervalForResource = 8
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        self.session = session

        var urlRequest = URLRequest(url: imageURL)
        urlRequest.timeoutInterval = 8
        let task = session.dataTask(with: urlRequest)
        self.task = task
        task.resume()
    }

    override func serviceExtensionTimeWillExpire() {
        finishWithOriginalContent()
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        guard request.url?.scheme?.lowercased() == "https" else {
            completionHandler(nil)
            finishWithOriginalContent()
            return
        }
        completionHandler(request)
    }

    func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
        guard
            let response = response as? HTTPURLResponse,
            (200...299).contains(response.statusCode),
            response.expectedContentLength <= Int64(maximumImageSize) || response.expectedContentLength == NSURLSessionTransferSizeUnknown,
            let fileExtension = fileExtension(for: response.mimeType)
        else {
            completionHandler(.cancel)
            finishWithOriginalContent()
            return
        }

        imageExtension = fileExtension
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        stateLock.lock()
        guard !didFinish, imageData.count <= maximumImageSize - data.count else {
            stateLock.unlock()
            dataTask.cancel()
            finishWithOriginalContent()
            return
        }
        imageData.append(data)
        stateLock.unlock()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard error == nil else {
            finishWithOriginalContent()
            return
        }

        stateLock.lock()
        let data = imageData
        let fileExtension = imageExtension
        stateLock.unlock()

        guard !data.isEmpty, let fileExtension else {
            finishWithOriginalContent()
            return
        }

        do {
            let directoryURL = FileManager.default.temporaryDirectory
                .appendingPathComponent(UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: directoryURL, withIntermediateDirectories: true)
            let fileURL = directoryURL.appendingPathComponent("notification.\(fileExtension)")
            try data.write(to: fileURL, options: .atomic)
            let attachment = try UNNotificationAttachment(identifier: "image", url: fileURL)
            finish(with: attachment)
        } catch {
            finishWithOriginalContent()
        }
    }

    private func fileExtension(for mimeType: String?) -> String? {
        switch mimeType?.lowercased() {
        case "image/jpeg":
            return "jpg"
        case "image/png":
            return "png"
        default:
            return nil
        }
    }

    private func finish(with attachment: UNNotificationAttachment) {
        complete { originalContent, bestAttemptContent in
            guard let bestAttemptContent else { return originalContent }
            bestAttemptContent.attachments = [attachment]
            return bestAttemptContent
        }
    }

    private func finishWithOriginalContent() {
        complete { originalContent, _ in originalContent }
    }

    private func complete(
        content: (UNNotificationContent, UNMutableNotificationContent?) -> UNNotificationContent
    ) {
        stateLock.lock()
        guard
            !didFinish,
            let handler = contentHandler,
            let originalContent
        else {
            stateLock.unlock()
            return
        }
        didFinish = true
        let deliveredContent = content(originalContent, bestAttemptContent)
        contentHandler = nil
        timeoutWorkItem?.cancel()
        timeoutWorkItem = nil
        task?.cancel()
        task = nil
        session?.invalidateAndCancel()
        session = nil
        stateLock.unlock()

        handler(deliveredContent)
    }
}
