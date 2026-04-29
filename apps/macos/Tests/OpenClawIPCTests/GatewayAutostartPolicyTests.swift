import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized)
struct GatewayAutostartPolicyTests {
    @Test func `starts gateway only when local and not paused`() {
        #expect(GatewayAutostartPolicy.shouldStartGateway(mode: .local, paused: false))
        #expect(!GatewayAutostartPolicy.shouldStartGateway(mode: .local, paused: true))
        #expect(!GatewayAutostartPolicy.shouldStartGateway(mode: .remote, paused: false))
        #expect(!GatewayAutostartPolicy.shouldStartGateway(mode: .unconfigured, paused: false))
    }

    @Test func `skips launch agent when native host is preferred`() {
        #expect(!GatewayAutostartPolicy.shouldEnsureLaunchAgent(
            mode: .local,
            paused: false,
            defaults: Self.cleanDefaults()))
        #expect(!GatewayAutostartPolicy.shouldEnsureLaunchAgent(
            mode: .local,
            paused: true))
        #expect(!GatewayAutostartPolicy.shouldEnsureLaunchAgent(
            mode: .remote,
            paused: false))
    }

    @Test func `launch agent remains fallback when native host disabled`() {
        #expect(GatewayAutostartPolicy.shouldEnsureLaunchAgent(
            mode: .local,
            paused: false,
            environment: [GatewayNativeHostPolicy.environmentKey: "launchd"]))
        #expect(!GatewayAutostartPolicy.shouldEnsureLaunchAgent(
            mode: .local,
            paused: false,
            environment: [GatewayNativeHostPolicy.environmentKey: "native"]))
    }
}

@Suite(.serialized)
struct GatewayNativeHostPolicyTests {
    @Test func `prefers native host for local mode by default`() {
        let defaults = Self.cleanDefaults()
        #expect(GatewayNativeHostPolicy.shouldPreferNativeHost(
            mode: .local,
            defaults: defaults,
            environment: [:]))
        #expect(!GatewayNativeHostPolicy.shouldPreferNativeHost(
            mode: .remote,
            defaults: defaults,
            environment: [:]))
        #expect(!GatewayNativeHostPolicy.shouldPreferNativeHost(
            mode: .unconfigured,
            defaults: defaults,
            environment: [:]))
    }

    @Test func `environment can force launchd fallback or native host`() {
        #expect(!GatewayNativeHostPolicy.shouldPreferNativeHost(
            mode: .local,
            environment: [GatewayNativeHostPolicy.environmentKey: "0"]))
        #expect(!GatewayNativeHostPolicy.shouldPreferNativeHost(
            mode: .local,
            environment: [GatewayNativeHostPolicy.environmentKey: "launchd"]))
        #expect(GatewayNativeHostPolicy.shouldPreferNativeHost(
            mode: .local,
            environment: [GatewayNativeHostPolicy.environmentKey: "1"]))
        #expect(GatewayNativeHostPolicy.shouldPreferNativeHost(
            mode: .local,
            environment: [GatewayNativeHostPolicy.environmentKey: "native"]))
    }
}

private extension GatewayAutostartPolicyTests {
    static func cleanDefaults() -> UserDefaults {
        UserDefaults(suiteName: "GatewayAutostartPolicyTests.\(UUID().uuidString)")!
    }
}

private extension GatewayNativeHostPolicyTests {
    static func cleanDefaults() -> UserDefaults {
        UserDefaults(suiteName: "GatewayNativeHostPolicyTests.\(UUID().uuidString)")!
    }
}
