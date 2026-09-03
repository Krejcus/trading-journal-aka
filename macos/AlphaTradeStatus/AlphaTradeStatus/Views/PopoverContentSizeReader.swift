import SwiftUI

private struct PopoverContentSizePreferenceKey: PreferenceKey {
    static var defaultValue: CGSize = .zero

    static func reduce(value: inout CGSize, nextValue: () -> CGSize) {
        let next = nextValue()
        if next.width > 0, next.height > 0 {
            value = next
        }
    }
}

extension View {
    func onPopoverContentSizeChange(
        _ action: @escaping (CGSize) -> Void
    ) -> some View {
        background {
            GeometryReader { proxy in
                Color.clear.preference(
                    key: PopoverContentSizePreferenceKey.self,
                    value: proxy.size
                )
            }
        }
        .onPreferenceChange(
            PopoverContentSizePreferenceKey.self,
            perform: action
        )
    }
}
