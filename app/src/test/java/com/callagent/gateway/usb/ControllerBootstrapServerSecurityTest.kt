package com.callagent.gateway.usb

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ControllerBootstrapServerSecurityTest {
    @Test
    fun `bootstrap uses fixed loopback-only ADB forward with bounded claim and no exported component`() {
        val source = File("src/main/java/com/callagent/gateway/usb/ControllerBootstrapServer.kt").readText()
        assertTrue(source.contains("bindHost: String = LOOPBACK_HOST"))
        assertTrue(source.contains("ServerSocket(BOOTSTRAP_PORT, 1, InetAddress.getByName(bindHost))"))
        assertTrue(source.contains("tryClaimForwardedTunnel()"))
        assertTrue(source.contains("BootstrapAuthorizationWindow"))
        assertTrue(source.contains("onExpired"))
        assertTrue(source.contains("BOOTSTRAP_PORT = 27184"))
        assertTrue(source.contains("LOOPBACK_HOST = \"127.0.0.1\""))
        val manifest = File("src/main/AndroidManifest.xml").readText()
        assertFalse(manifest.contains("ControllerBootstrapServer"))
    }

    @Test
    fun `service starts bootstrap before telecom audio evidence and operational server for fresh enrollment`() {
        val source = File("src/main/java/com/callagent/gateway/usb/UsbGatewayService.kt").readText()
        val bootstrap = source.indexOf("startBootstrapGateway(enrollmentStore)")
        assertTrue(bootstrap >= 0)
        assertTrue(bootstrap < source.indexOf("AndroidAudioBridge(this)"))
        assertTrue(bootstrap < source.indexOf("ApprovedDeviceEvidenceProvisioner("))
        assertTrue(source.contains("onG2Authenticated"))
        assertTrue(source.contains("onOperationalG2AuthenticatedAndCommit"))
        assertTrue(source.contains("Desktop pairing timed out. Tap Connect desktop to try again."))
        assertTrue(source.contains("bootstrapServer?.stop()"))
        assertFalse(source.contains("ControllerCommitAckServer"))
    }

    @Test
    fun `bootstrap source cannot construct call audio evidence or operational frame executors`() {
        val source = File("src/main/java/com/callagent/gateway/usb/ControllerBootstrapServer.kt").readText()
        listOf("GsmCallManager", "AndroidAudioBridge", "ApprovedDeviceEvidenceProvisioner", "GatewayCommandExecutor", "FrameCodec", "Recording").forEach {
            assertFalse("bootstrap imported privileged boundary $it", source.contains(it))
        }
    }
}
