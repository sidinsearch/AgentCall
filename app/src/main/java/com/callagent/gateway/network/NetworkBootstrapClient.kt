package com.callagent.gateway.network

import android.content.Context
import android.os.Build
import com.callagent.gateway.BuildConfig
import com.callagent.gateway.usb.ControllerBootstrapCrypto
import com.callagent.gateway.usb.ControllerBootstrapProtocol
import java.io.DataInputStream
import java.io.DataOutputStream
import java.net.Socket
import java.security.KeyPairGenerator
import java.security.SecureRandom
import java.util.Arrays
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/** Outbound first-time pairing client for the CLI server. */
class NetworkBootstrapClient(private val context: Context) {
    fun pair(host: String, port: Int): ByteArray {
        require(host.isNotBlank() && port in 1..65535)
        Socket(host, port).use { socket ->
            socket.soTimeout = 30_000
            val input = DataInputStream(socket.getInputStream())
            val output = DataOutputStream(socket.getOutputStream())
            val pair = KeyPairGenerator.getInstance("X25519").generateKeyPair()
            val privateBytes = pair.private.encoded.takeLast(32).toByteArray()
            val publicBytes = pair.public.encoded.takeLast(32).toByteArray()
            val clientNonce = ByteArray(32).also(SecureRandom()::nextBytes)
            val identity = ControllerBootstrapProtocol.Identity(
                adbSerial = "NETWORK-PHONE",
                systemFingerprint = Build.FINGERPRINT,
                vendorFingerprint = Build.MANUFACTURER,
                packageName = context.packageName,
                versionCode = BuildConfig.VERSION_CODE.toString(),
                signingCertificateSha256 = "0".repeat(64),
                artifactManifestSha256 = "0".repeat(64),
                desktopBootstrapVersion = "1",
            )
            val hello = ControllerBootstrapProtocol.ClientHello(clientNonce, publicBytes, identity)
            val serverBody = try {
                writeFrame(output, ControllerBootstrapProtocol.encodeClientHello(hello))
                readFrame(input)
            } finally { hello.nonce.fill(0); hello.publicKey.fill(0) }
            try {
                require(serverBody.size == 5 + 32 + 32 + 32 + 16)
                require(serverBody.copyOfRange(0, 5).contentEquals(byteArrayOf('G'.code.toByte(), '2'.code.toByte(), 'B'.code.toByte(), 'S'.code.toByte(), 1)))
                val serverNonce = serverBody.copyOfRange(5, 37)
                val serverPublic = serverBody.copyOfRange(37, 69)
                val transcript = ControllerBootstrapProtocol.canonicalTranscript(hello, serverNonce, serverPublic)
                val key = ControllerBootstrapCrypto.deriveControllerKey(ControllerBootstrapCrypto.x25519(privateBytes, serverPublic), clientNonce, serverNonce, transcript)
                openProof(key, transcript, serverBody.copyOfRange(69, 101), serverBody.copyOfRange(101, 117))
                val confirm = sealProof(key, transcript)
                writeFrame(output, byteArrayOf('G'.code.toByte(), '2'.code.toByte(), 'B'.code.toByte(), 'C'.code.toByte(), 1) + confirm)
                confirm.fill(0); transcript.fill(0); serverNonce.fill(0); serverPublic.fill(0)
                return key
            } finally {
                serverBody.fill(0); privateBytes.fill(0); publicBytes.fill(0); clientNonce.fill(0)
            }
        }
    }

    private fun readFrame(input: DataInputStream): ByteArray {
        val length = input.readInt()
        require(length in 1..ControllerBootstrapProtocol.MAX_FRAME_BYTES)
        return ByteArray(length).also(input::readFully)
    }

    private fun writeFrame(output: DataOutputStream, body: ByteArray) {
        require(body.size <= ControllerBootstrapProtocol.MAX_FRAME_BYTES)
        output.writeInt(body.size); output.write(body); output.flush()
    }

    private fun sealProof(key: ByteArray, transcript: ByteArray): ByteArray {
        val nonce = ByteArray(12).also { it[11] = 2 }
        return Cipher.getInstance("AES/GCM/NoPadding").run {
            init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
            updateAAD(transcript)
            doFinal("agentcall-bootstrap-proof-v1".toByteArray(Charsets.US_ASCII))
        }.also { nonce.fill(0) }
    }

    private fun openProof(key: ByteArray, transcript: ByteArray, ciphertext: ByteArray, tag: ByteArray) {
        val nonce = ByteArray(12).also { it[11] = 1 }
        val plain = Cipher.getInstance("AES/GCM/NoPadding").run {
            init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
            updateAAD(transcript); update(ciphertext); doFinal(tag)
        }
        try { require(plain.contentEquals("agentcall-bootstrap-proof-v1".toByteArray(Charsets.US_ASCII))) }
        finally { plain.fill(0); nonce.fill(0) }
    }
}
