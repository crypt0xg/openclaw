import Foundation

enum GatewayNativeHostPolicy {
    static let environmentKey = "OPENCLAW_MAC_NATIVE_GATEWAY"

    private static let enabledValues: Set<String> = ["1", "true", "yes", "on", "native", "app"]
    private static let disabledValues: Set<String> = ["0", "false", "no", "off", "launchd"]

    static func shouldPreferNativeHost(
        mode: AppState.ConnectionMode,
        defaults: UserDefaults = .standard,
        environment: [String: String] = ProcessInfo.processInfo.environment) -> Bool
    {
        guard mode == .local else { return false }
        if let envValue = environment[self.environmentKey].map(self.normalizeFlagValue),
           !envValue.isEmpty
        {
            if self.disabledValues.contains(envValue) { return false }
            if self.enabledValues.contains(envValue) { return true }
        }
        if defaults.object(forKey: gatewayNativeHostEnabledKey) != nil {
            return defaults.bool(forKey: gatewayNativeHostEnabledKey)
        }
        return true
    }

    private static func normalizeFlagValue(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }
}
