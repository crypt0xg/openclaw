import Foundation

enum GatewayAutostartPolicy {
    static func shouldStartGateway(mode: AppState.ConnectionMode, paused: Bool) -> Bool {
        mode == .local && !paused
    }

    static func shouldEnsureLaunchAgent(
        mode: AppState.ConnectionMode,
        paused: Bool,
        defaults: UserDefaults = .standard,
        environment: [String: String] = ProcessInfo.processInfo.environment) -> Bool
    {
        self.shouldStartGateway(mode: mode, paused: paused) &&
            !GatewayNativeHostPolicy.shouldPreferNativeHost(
                mode: mode,
                defaults: defaults,
                environment: environment)
    }
}
