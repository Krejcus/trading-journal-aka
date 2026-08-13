import SwiftUI
import PhotosUI
import Vision
import UIKit

struct QuickCaptureView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(NativeLabStore.self) private var store
    @State private var symbol = "MNQ"
    @State private var side = "LONG"
    @State private var result = ""
    @State private var setup = "Sweep → MSS → FVG"
    @State private var note = ""
    @State private var selectedPhoto: PhotosPickerItem?
    @State private var capturedImageData: Data?
    @State private var showCamera = false
    @State private var scanStatus: String?
    @State private var isScanning = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Exekuce") {
                    Picker("Instrument", selection: $symbol) { ForEach(["MNQ", "NQ", "MES", "ES"], id: \.self) { Text($0) } }
                    Picker("Směr", selection: $side) { ForEach(["LONG", "SHORT"], id: \.self) { Text($0) } }.pickerStyle(.segmented)
                    TextField("Výsledek v USD", text: $result).keyboardType(.numbersAndPunctuation).accessibilityIdentifier("capture.result")
                }
                Section("Kontext") {
                    TextField("Setup", text: $setup)
                    TextField("Co se stalo?", text: $note, axis: .vertical).lineLimit(3...6)
                }
                Section("Screenshot a OCR") {
                    PhotosPicker(selection: $selectedPhoto, matching: .images) {
                        Label("Vybrat z Fotek", systemImage: "photo.on.rectangle")
                    }
                    Button { showCamera = true } label: { Label("Vyfotit", systemImage: "camera") }
                    if isScanning { HStack { ProgressView(); Text("Rozpoznávám lokálně…") }.font(.caption) }
                    if let scanStatus { Label(scanStatus, systemImage: "text.viewfinder").font(.caption).foregroundStyle(TradeTheme.secondary) }
                }
                Section {
                    Label("Vision OCR probíhá na zařízení; screenshot se nikam neodesílá.", systemImage: "iphone.gen3.radiowaves.left.and.right").font(.caption).foregroundStyle(TradeTheme.secondary)
                    Label("Ukládá se pouze do lokálního Native Lab store.", systemImage: "lock.shield").font(.caption).foregroundStyle(TradeTheme.success)
                }
            }
            .scrollContentBackground(.hidden).background(TradeTheme.page)
            .navigationTitle("Rychlý zápis").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Zrušit") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Uložit") {
                        store.addTrade(symbol: symbol, side: side, result: Double(result.replacingOccurrences(of: ",", with: ".")) ?? 0, setup: setup, note: note.isEmpty ? "Rychlý mobilní záznam." : note)
                        UINotificationFeedbackGenerator().notificationOccurred(.success)
                        Task { await SearchableIndexService.index(trades: store.trades) }
                        dismiss()
                    }.fontWeight(.semibold).accessibilityIdentifier("capture.save")
                }
            }
            .onChange(of: selectedPhoto) { _, item in
                guard let item else { return }
                Task { if let data = try? await item.loadTransferable(type: Data.self) { recognize(data) } }
            }
            .onChange(of: capturedImageData) { _, data in if let data { recognize(data) } }
            .sheet(isPresented: $showCamera) { CameraCapture(imageData: $capturedImageData) }
            .task {
                if let pending = UserDefaults.standard.string(forKey: "nativeLab.pendingCaptureNote") {
                    note = pending
                    UserDefaults.standard.removeObject(forKey: "nativeLab.pendingCaptureNote")
                }
            }
        }.preferredColorScheme(.light)
    }

    private func recognize(_ data: Data) {
        guard let image = UIImage(data: data), let cgImage = image.cgImage else { scanStatus = "Obrázek se nepodařilo načíst."; return }
        isScanning = true
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true
        request.customWords = ["MNQ", "NQ", "MES", "ES", "VWAP", "FVG", "LONG", "SHORT"]
        do {
            try VNImageRequestHandler(cgImage: cgImage).perform([request])
            let lines = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
            let text = lines.joined(separator: " ")
            let upper = text.uppercased()
            if upper.contains("MNQ") { symbol = "MNQ" }
            else if upper.contains("NQ") { symbol = "NQ" }
            else if upper.contains("MES") { symbol = "MES" }
            else if upper.contains("ES") { symbol = "ES" }
            if upper.contains("SHORT") { side = "SHORT" } else if upper.contains("LONG") { side = "LONG" }
            if !text.isEmpty { note = "OCR: " + lines.prefix(4).joined(separator: " · ") }
            scanStatus = text.isEmpty ? "Na obrázku nebyl rozpoznán text." : "Rozpoznáno \(lines.count) textových řádků. Zkontroluj návrh."
        } catch {
            scanStatus = "OCR se nepodařilo dokončit."
        }
        isScanning = false
    }
}

private struct CameraCapture: UIViewControllerRepresentable {
    @Environment(\.dismiss) private var dismiss
    @Binding var imageData: Data?

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }
    func makeUIViewController(context: Context) -> UIImagePickerController {
        let controller = UIImagePickerController()
        controller.sourceType = UIImagePickerController.isSourceTypeAvailable(.camera) ? .camera : .photoLibrary
        controller.delegate = context.coordinator
        return controller
    }
    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}

    final class Coordinator: NSObject, UINavigationControllerDelegate, UIImagePickerControllerDelegate {
        let parent: CameraCapture
        init(parent: CameraCapture) { self.parent = parent }
        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey : Any]) {
            parent.imageData = (info[.originalImage] as? UIImage)?.jpegData(compressionQuality: 0.88)
            parent.dismiss()
        }
        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { parent.dismiss() }
    }
}
