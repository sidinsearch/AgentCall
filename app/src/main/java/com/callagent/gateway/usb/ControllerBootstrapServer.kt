package com.callagent.gateway.usb

import androidx.annotation.RequiresApi
import android.util.Log
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.IOException
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.security.KeyPairGenerator
import java.security.SecureRandom
import java.util.Arrays
import java.util.concurrent.atomic.AtomicBoolean
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/** One-shot ADB-forwarded loopback bootstrap. It has no call, audio, evidence, or G2 dependency. */
@RequiresApi(33)
class ControllerBootstrapServer(
    private val enrollmentStore: ControllerEnrollmentStore,
    private val expectedIdentity: (ControllerBootstrapProtocol.Identity) -> Boolean,
    private val onStaged: (ByteArray) -> Unit,
    private val onExpired: () -> Unit = {},
    private val authorization: BootstrapAuthorizationWindow = BootstrapAuthorizationWindow(System.currentTimeMillis()),
    private val listenerDeadlineMillis: Long = BootstrapAuthorizationWindow.DEFAULT_DURATION_MILLIS,
    private val bindHost: String = LOOPBACK_HOST,
) {
    init { require(listenerDeadlineMillis in 1..BootstrapAuthorizationWindow.MAX_DURATION_MILLIS) }
    private val running = AtomicBoolean(false)
    @Volatile private var listener: ServerSocket? = null
    @Volatile private var client: Socket? = null

    fun start() {
        check(running.compareAndSet(false, true)) { "bootstrap listener already running" }
        listener = ServerSocket(BOOTSTRAP_PORT, 1, InetAddress.getByName(bindHost))
        Thread(::acceptOne, "controller-bootstrap-accept").apply { isDaemon = true; start() }
        Thread({
            try { Thread.sleep(listenerDeadlineMillis) }
            catch (_: InterruptedException) { return@Thread }
            if (running.get() && !authorization.isOpen()) expireListener()
        }, "controller-bootstrap-deadline").apply { isDaemon = true; start() }
    }

    fun stop() {
        running.set(false)
        authorization.revoke()
        try { client?.close() } catch (_: IOException) {}
        try { listener?.close() } catch (_: IOException) {}
        client = null
        listener = null
    }

    private fun acceptOne() {
        while (running.get() && authorization.isOpen()) {
            val socket = try { listener?.accept() } catch (_: IOException) { null } ?: return
            val claim = authorization.tryClaimForwardedTunnel()
            if (!claim.accepted) {
                try { socket.close() } catch (_: IOException) {}
                continue
            }
            client = socket
            var staged = false
            try {
                socket.soTimeout = BootstrapAuthorizationWindow.DEFAULT_DURATION_MILLIS.toInt()
                handle(socket, claim.generation)
                staged = true
                return
            } catch (error: Exception) {
                Log.w(TAG, "Rejected bootstrap client: ${error.message}")
                enrollmentStore.revokeStaged()
            } finally {
                client = null
                try { socket.close() } catch (_: IOException) {}
                authorization.release(claim.generation)
                if (staged) closeListener()
            }
        }
        if (running.get() && !authorization.isOpen()) expireListener() else closeListener()
    }

    private fun expireListener() {
        if (!running.compareAndSet(true, false)) return
        try { listener?.close() } catch (_: IOException) {}
        listener = null
        onExpired()
    }

    private fun closeListener() {
        running.set(false)
        try { listener?.close() } catch (_: IOException) {}
        listener = null
    }

    private fun handle(socket: Socket, generation: Long) {
        val input = DataInputStream(socket.inputStream)
        val output = DataOutputStream(socket.outputStream)
        val helloBytes = readFrame(input)
        val hello = try { ControllerBootstrapProtocol.decodeClientHello(helloBytes) } finally { helloBytes.fill(0) }
        check(expectedIdentity(hello.identity)) { "bootstrap identity mismatch" }
        check(authorization.isCurrent(generation)) { "bootstrap generation expired" }

        // Android Conscrypt exposes X25519 directly but rejects the generic
        // XDH + NamedParameterSpec initialization accepted by desktop JCA.
        val pair = KeyPairGenerator.getInstance("X25519").generateKeyPair()
        val privateBytes = pair.private.encoded.takeLast(32).toByteArray()
        val publicBytes = pair.public.encoded.takeLast(32).toByteArray()
        require(privateBytes.size == 32 && publicBytes.size == 32)
        val serverNonce = ByteArray(32).also(SecureRandom()::nextBytes)
        var shared: ByteArray? = null
        var transcript: ByteArray? = null
        var key: ByteArray? = null
        try {
            shared = ControllerBootstrapCrypto.x25519(privateBytes, hello.publicKey)
            transcript = ControllerBootstrapProtocol.canonicalTranscript(hello, serverNonce, publicBytes)
            key = ControllerBootstrapCrypto.deriveControllerKey(shared, hello.nonce, serverNonce, transcript)
            val proof = seal(key, SERVER_PROOF_NONCE, transcript)
            writeFrame(output, SERVER_MAGIC + serverNonce + publicBytes + proof)
            proof.fill(0)

            val confirm = readFrame(input)
            val expected = seal(key, CLIENT_CONFIRM_NONCE, transcript)
            try { check(java.security.MessageDigest.isEqual(confirm, CLIENT_MAGIC + expected)) { "client confirmation failed" } }
            finally { confirm.fill(0); expected.fill(0) }
            check(authorization.isCurrent(generation)) { "stale bootstrap generation" }
            enrollmentStore.stage(key)
            onStaged(key.copyOf())
        } finally {
            privateBytes.fill(0); publicBytes.fill(0); serverNonce.fill(0)
            shared?.fill(0); transcript?.fill(0); key?.fill(0)
            hello.nonce.fill(0); hello.publicKey.fill(0)
        }
    }

    private fun readFrame(input: DataInputStream): ByteArray {
        val length = input.readInt()
        require(length in 1..ControllerBootstrapProtocol.MAX_FRAME_BYTES) { "invalid bootstrap frame length" }
        return ByteArray(length).also(input::readFully)
    }

    private fun writeFrame(output: DataOutputStream, bytes: ByteArray) {
        require(bytes.size <= ControllerBootstrapProtocol.MAX_FRAME_BYTES)
        output.writeInt(bytes.size); output.write(bytes); output.flush()
    }

    private fun seal(key: ByteArray, nonce: ByteArray, transcript: ByteArray): ByteArray =
        Cipher.getInstance("AES/GCM/NoPadding").run {
            init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
            updateAAD(transcript)
            doFinal(PROOF_PLAINTEXT)
        }

    companion object {
        private const val TAG = "agentcall-bootstrap"
        const val BOOTSTRAP_PORT = 27184
        const val LOOPBACK_HOST = "127.0.0.1"
        private val SERVER_MAGIC = byteArrayOf('G'.code.toByte(), '2'.code.toByte(), 'B'.code.toByte(), 'S'.code.toByte(), 1)
        private val CLIENT_MAGIC = byteArrayOf('G'.code.toByte(), '2'.code.toByte(), 'B'.code.toByte(), 'C'.code.toByte(), 1)
        private val SERVER_PROOF_NONCE = ByteArray(12).also { it[11] = 1 }
        private val CLIENT_CONFIRM_NONCE = ByteArray(12).also { it[11] = 2 }
        private val PROOF_PLAINTEXT = "agentcall-bootstrap-proof-v1".toByteArray(Charsets.US_ASCII)
    }
}
