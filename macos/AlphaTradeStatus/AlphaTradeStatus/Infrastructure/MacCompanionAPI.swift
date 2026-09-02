import Foundation

struct MacCompanionPairingStartRequest: Encodable, Equatable, Sendable {
    let contractVersion: Int
    let deviceId: String
    let deviceName: String
    let deviceSecretHash: String
    let pairingCodeHash: String
    let appVersion: String?
}

struct MacCompanionPairingStartResponse: Decodable, Equatable, Sendable {
    let contractVersion: Int
    let pairingId: String
    let expiresAt: Date
    let pollAfterSeconds: Int
}

struct MacCompanionPairingStatusResponse: Decodable, Equatable, Sendable {
    let contractVersion: Int
    let paired: Bool
    let expiresAt: Date?
    let pollAfterSeconds: Int?
    let deviceId: String?
    let scope: String?
}

protocol MacCompanionAPIServing: Sendable {
    func startPairing(
        credential: CompanionCredentialRecord,
        deviceName: String,
        appVersion: String?
    ) async throws -> MacCompanionPairingStartResponse

    func pairingStatus(
        credential: CompanionCredentialRecord
    ) async throws -> MacCompanionPairingStatusResponse

    func status(
        credential: CompanionCredentialRecord
    ) async throws -> MacCompanionStatusDTO
}

actor MacCompanionAPI: MacCompanionAPIServing {
    static let productionBaseURL = URL(string: "https://alphatrade-mentor-15.vercel.app")!
    static let requiredScope = "copier.status.read"

    private let baseURL: URL
    private let session: URLSession
    private let redirectDelegate: NoRedirectURLSessionDelegate?
    private let maximumResponseBytes = 256 * 1024

    init(
        baseURL: URL = productionBaseURL,
        session: URLSession? = nil
    ) {
        precondition(baseURL.scheme == "https")
        precondition(baseURL.host == Self.productionBaseURL.host)
        self.baseURL = baseURL

        if let session {
            self.session = session
            self.redirectDelegate = nil
        } else {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
            configuration.urlCache = nil
            configuration.httpCookieStorage = nil
            configuration.httpShouldSetCookies = false
            configuration.timeoutIntervalForRequest = 8
            configuration.timeoutIntervalForResource = 12
            configuration.waitsForConnectivity = false
            let redirectDelegate = NoRedirectURLSessionDelegate()
            self.redirectDelegate = redirectDelegate
            self.session = URLSession(
                configuration: configuration,
                delegate: redirectDelegate,
                delegateQueue: nil
            )
        }
    }

    func startPairing(
        credential: CompanionCredentialRecord,
        deviceName: String,
        appVersion: String?
    ) async throws -> MacCompanionPairingStartResponse {
        let normalizedDeviceName = deviceName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard credential.phase == .pending,
              let pairingCodeHash = credential.pairingCodeHash,
              !normalizedDeviceName.isEmpty,
              normalizedDeviceName.utf16.count <= 120 else {
            throw MacCompanionAPIError.invalidLocalCredential
        }
        let body = MacCompanionPairingStartRequest(
            contractVersion: 1,
            deviceId: credential.deviceID.uuidString.lowercased(),
            deviceName: normalizedDeviceName,
            deviceSecretHash: credential.deviceSecretHash,
            pairingCodeHash: pairingCodeHash,
            appVersion: appVersion
        )
        let data = try JSONEncoder().encode(body)
        let responseData = try await send(
            path: "/api/mac-companion/pairing/start",
            method: "POST",
            body: data,
            authorization: nil,
            acceptedStatusCodes: [200, 201]
        )
        let response: MacCompanionPairingStartResponse = try decode(responseData)
        guard response.contractVersion == 1,
              response.pairingId.lowercased() == credential.deviceID.uuidString.lowercased(),
              response.pollAfterSeconds >= 1,
              response.pollAfterSeconds <= 30 else {
            throw MacCompanionAPIError.invalidResponse
        }
        return response
    }

    func pairingStatus(
        credential: CompanionCredentialRecord
    ) async throws -> MacCompanionPairingStatusResponse {
        let data = try await send(
            path: "/api/mac-companion/pairing/status",
            method: "GET",
            body: nil,
            authorization: credential.authorizationHeader,
            acceptedStatusCodes: [200]
        )
        let response: MacCompanionPairingStatusResponse = try decode(data)
        guard response.contractVersion == 1 else {
            throw MacCompanionAPIError.unsupportedContract
        }
        if response.paired {
            guard response.deviceId?.lowercased() == credential.deviceID.uuidString.lowercased(),
                  response.scope == Self.requiredScope,
                  response.expiresAt == nil,
                  response.pollAfterSeconds == nil else {
                throw MacCompanionAPIError.invalidScope
            }
        } else {
            guard response.expiresAt != nil,
                  let pollAfterSeconds = response.pollAfterSeconds,
                  pollAfterSeconds >= 1,
                  pollAfterSeconds <= 30,
                  response.deviceId == nil,
                  response.scope == nil else {
                throw MacCompanionAPIError.invalidResponse
            }
        }
        return response
    }

    func status(
        credential: CompanionCredentialRecord
    ) async throws -> MacCompanionStatusDTO {
        let data = try await send(
            path: "/api/mac-companion/status",
            method: "GET",
            body: nil,
            authorization: credential.authorizationHeader,
            acceptedStatusCodes: [200]
        )
        do {
            return try MacCompanionStatusDecoder.decode(data)
        } catch let error as MacCompanionStatusDecodingError {
            if case .unsupportedContractVersion = error {
                throw MacCompanionAPIError.unsupportedContract
            }
            throw MacCompanionAPIError.invalidResponse
        } catch {
            throw MacCompanionAPIError.invalidResponse
        }
    }
}

final class NoRedirectURLSessionDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}

private extension MacCompanionAPI {
    struct ErrorEnvelope: Decodable {
        let error: String?
        let code: String?
        let retryAfterSeconds: Int?
    }

    func send(
        path: String,
        method: String,
        body: Data?,
        authorization: String?,
        acceptedStatusCodes: Set<Int>
    ) async throws -> Data {
        guard let url = URL(string: path, relativeTo: baseURL)?.absoluteURL,
              url.scheme == "https",
              url.host == Self.productionBaseURL.host else {
            throw MacCompanionAPIError.invalidEndpoint
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.httpBody = body
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        if body != nil {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if let authorization {
            request.setValue(authorization, forHTTPHeaderField: "Authorization")
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw MacCompanionAPIError.transport
        }

        guard let http = response as? HTTPURLResponse else {
            throw MacCompanionAPIError.invalidResponse
        }
        guard data.count <= maximumResponseBytes else {
            throw MacCompanionAPIError.responseTooLarge
        }
        guard acceptedStatusCodes.contains(http.statusCode) else {
            throw mapHTTPError(response: http, data: data)
        }
        return data
    }

    func decode<Response: Decodable>(_ data: Data) throws -> Response {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let value = try container.decode(String.self)
            guard let date = CompanionISO8601.date(from: value) else {
                throw DecodingError.dataCorruptedError(
                    in: container,
                    debugDescription: "Invalid ISO-8601 timestamp"
                )
            }
            return date
        }
        do {
            return try decoder.decode(Response.self, from: data)
        } catch {
            throw MacCompanionAPIError.invalidResponse
        }
    }

    func mapHTTPError(response: HTTPURLResponse, data: Data) -> MacCompanionAPIError {
        let envelope = try? JSONDecoder().decode(ErrorEnvelope.self, from: data)
        let code = envelope?.error ?? envelope?.code
        let statusCode = response.statusCode

        if statusCode == 401 || code == "invalid-mac-companion-auth" {
            return .invalidAuthentication
        }
        if statusCode == 410 || code == "pairing-expired" {
            return .pairingExpired
        }
        if statusCode == 409 || code == "pairing-device-conflict" {
            return .pairingConflict
        }
        if statusCode == 429 || code == "pairing-start-rate-limited" {
            let headerSeconds = response.value(forHTTPHeaderField: "Retry-After")
                .flatMap(Int.init)
            let retryAfter = envelope?.retryAfterSeconds ?? headerSeconds
            return .rateLimited(retryAfterSeconds: retryAfter.map {
                min(max($0, 1), 600)
            })
        }
        if statusCode == 503 {
            return .temporarilyUnavailable
        }
        if statusCode == 400 {
            return .invalidRequest
        }
        return .server(statusCode)
    }
}

enum MacCompanionAPIError: LocalizedError, Equatable {
    case invalidEndpoint
    case invalidLocalCredential
    case invalidRequest
    case invalidResponse
    case responseTooLarge
    case unsupportedContract
    case invalidScope
    case invalidAuthentication
    case pairingExpired
    case pairingConflict
    case rateLimited(retryAfterSeconds: Int?)
    case temporarilyUnavailable
    case transport
    case server(Int)

    var errorDescription: String? {
        switch self {
        case .invalidEndpoint:
            return "Cílová adresa companionu není povolená."
        case .invalidLocalCredential:
            return "Lokální párovací údaje nejsou platné."
        case .invalidRequest:
            return "Server odmítl párovací požadavek."
        case .invalidResponse:
            return "Server vrátil neplatnou odpověď."
        case .responseTooLarge:
            return "Odpověď serveru je neočekávaně velká."
        case .unsupportedContract:
            return "Tato verze aplikace nerozumí serverovému kontraktu."
        case .invalidScope:
            return "Server nepotvrdil oprávnění pouze pro čtení stavu."
        case .invalidAuthentication:
            return "Přístup tohoto Macu byl zrušen nebo není platný."
        case .pairingExpired:
            return "Párovací kód vypršel."
        case .pairingConflict:
            return "Tento Mac už má jinou párovací žádost."
        case .rateLimited(let retryAfterSeconds):
            if let retryAfterSeconds {
                return "Bylo vytvořeno příliš mnoho párovacích kódů. Zkus to znovu za \(retryAfterSeconds) s."
            }
            return "Bylo vytvořeno příliš mnoho párovacích kódů. Zkus to znovu za chvíli."
        case .temporarilyUnavailable, .transport:
            return "Cloudový stav je dočasně nedostupný."
        case .server(let statusCode):
            return "Cloudový stav selhal (HTTP \(statusCode))."
        }
    }
}
