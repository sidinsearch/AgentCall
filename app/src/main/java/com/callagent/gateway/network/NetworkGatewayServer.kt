package com.callagent.gateway.network

import com.callagent.gateway.usb.*
import java.io.IOException
import java.io.InputStream
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Arrays
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * TCP gateway that accepts exactly one PC client over the network (not loopback-only),
 * reads canonical streaming [Frame]s, enforces CONTROL/EVENT/PCM direction rules and the
 * exact PCM-640 contract, applies strict command validation + idempotent replay handling,
 * redacts sensitive fields, bounds the downlink (RX) queue, and on a protocol error or
 * disconnect closes the connection and runs cleanup exactly once.
 *
 * This is the network-mode equivalent of [UsbGatewayServer]. The protocol, auth, framing,
 * and command handling are identical — only the bind address differs.
 *
 * Bind address is configurable via [networkBindAddress]; the default is 0.0.0.0 to accept
 * connections from any interface (Tailscale, LAN, Wi-Fi). For production use, restrict via
 * firewall to the Tailscale subnet.
 */
class NetworkGatewayServer(
    private val serverSocketFactory: ServerSocketFactory,
    private val commandExecutor: GatewayCommandExecutor = RejectingCommandExecutor,
    private val listener: NetworkGatewayListener = NetworkGatewayListener.NONE,
    private val recordingArtifactReceiver: RecordingArtifactReceiver = RecordingArtifactReceiver.NONE,
    enrollmentSecret: ByteArray? = null,
    private val authenticationTimeoutMillis: Int = 3_000,
    private val authenticationSuccessGate: (() -> Boolean)? = null,
) {
    private val enrollmentSecret: ByteArray? = enrollmentSecret?.copyOf()?.also {
        require(it.size == AUTH_SECRET_BYTES) { "enrollmentSecret must be exactly 32 bytes" }
    }

    init {
        require(authenticationTimeoutMillis in 100..30_000) {
            "authenticationTimeoutMillis must be 100..30000"
        }
    }

    private class OutboundMessage(
        val generation: Long,
        val kind: FrameKind,
        payload: ByteArray,
        val timestampMicros: Long,
    ) {
        val payload: ByteArray = payload.copyOf()
    }

    @Volatile private var server: ServerSocket? =
        serverSocketFactory.create(BIND_ADDRESS, BIND_PORT)
    private val running = AtomicBoolean(false)

    private val connectionLock = Any()
    @Volatile private var currentClient: Socket? = null
    @Volatile private var currentReader: Thread? = null
    @Volatile private var currentWriter: Thread? = null
    @Volatile private var currentCleanupGuard: AtomicBoolean? = null
    @Volatile private var currentGeneration: Long = NO_GENERATION
    private val nextGeneration = AtomicLong(0L)
    private val outboundQueue = ArrayBlockingQueue<OutboundMessage>(OUTBOUND_QUEUE_CAPACITY)
    private val outboundSequence = AtomicLong(0L)
    private val inboundLastSequence = AtomicLong(NO_SEQUENCE)
    private val inboundSequenceGaps = AtomicLong(0L)
    private val inboundLostFrames = AtomicLong(0L)

    private val downlinkQueue = GenerationDownlinkQueue(DOWNLINK_QUEUE_CAPACITY)

    private val idempotency = IdempotencyCache(IDEMPOTENCY_CACHE_CAPACITY)
    private val mutationWorker = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "network-gateway-mutation").apply { isDaemon = true }
    }

    private val cleanupCount = AtomicInteger(0)
    private val appliedMutations = AtomicInteger(0)
    private val connectedClients = AtomicInteger(0)

    fun start() {
        if (!running.compareAndSet(false, true)) return
        listener.onListenerStarted(server?.localPort ?: BIND_PORT)
        Thread({
            while (running.get()) {
                val accepted = try {
                    server?.accept()
                } catch (e: IOException) {
                    if (running.get()) continue else null
                } ?: continue
                admitClient(accepted)
            }
        }, "network-gateway-accept").apply { isDaemon = true; start() }
    }

    fun stop() {
        if (running.compareAndSet(true, false)) {
            val socket = currentClient
            val guard = currentCleanupGuard
            if (socket != null && guard != null) {
                teardownConnection(socket, guard, runCleanup = false)
            }
            try { server?.close() } catch (_: IOException) {}
            server = null
        }
        enrollmentSecret?.fill(0)
        mutationWorker.shutdownNow()
    }

    fun sendEvent(payload: ByteArray): Boolean {
        if (payload.size > FrameCodec.MAX_PAYLOAD_SIZE) return false
        return sendOutbound(FrameKind.EVENT, payload)
    }

    fun authenticatedGeneration(): Long? = synchronized(connectionLock) {
        currentGeneration.takeIf { it != NO_GENERATION && currentClient?.let { socket -> !socket.isClosed && socket.isConnected } == true }
    }

    fun sendEventForAuthenticatedGeneration(generation: Long, payload: ByteArray): Boolean {
        if (payload.size > FrameCodec.MAX_PAYLOAD_SIZE) return false
        return sendEventForGeneration(generation, payload)
    }

    fun sendPcm(payload: ByteArray): Boolean {
        if (payload.size != PcmContract.BYTES_PER_FRAME) return false
        return sendOutbound(FrameKind.PCM, payload)
    }

    private fun sendOutbound(kind: FrameKind, payload: ByteArray): Boolean {
        synchronized(connectionLock) {
            val socket = currentClient ?: return false
            val generation = currentGeneration
            if (generation == NO_GENERATION || socket.isClosed || !socket.isConnected) return false
            val message = OutboundMessage(
                generation = generation,
                kind = kind,
                payload = payload,
                timestampMicros = System.nanoTime() / 1_000L,
            )
            if (currentClient === socket && currentGeneration == generation && outboundQueue.offer(message)) return true
            zeroizePcm(message)
            try { socket.close() } catch (_: IOException) {}
            return false
        }
    }

    private fun startWriter(socket: Socket, cleanupGuard: AtomicBoolean, sessionId: Long, generation: Long) {
        currentWriter = Thread({
            try {
                val output = socket.getOutputStream()
                while (running.get() && !socket.isClosed) {
                    val message = outboundQueue.poll(100, TimeUnit.MILLISECONDS) ?: continue
                    if (message.generation != generation || currentGeneration != generation) {
                        zeroizePcm(message)
                        continue
                    }
                    val frame = Frame(
                        kind = message.kind,
                        direction = FrameDirection.DEVICE_TO_HOST,
                        sessionId = sessionId,
                        sequence = outboundSequence.getAndIncrement() and 0xFFFF_FFFFL,
                        timestampMicros = message.timestampMicros,
                        flags = FrameFlags.NONE,
                        payload = message.payload,
                    )
                    try {
                        output.write(FrameCodec.encode(frame))
                        output.flush()
                    } finally {
                        zeroizePcm(message)
                    }
                }
            } catch (_: IOException) {
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
            } finally {
                try { socket.close() } catch (_: IOException) {}
                synchronized(connectionLock) {
                    if (currentClient === socket && currentCleanupGuard === cleanupGuard) {
                        clearOutboundQueue()
                    }
                }
            }
        }, "network-gateway-write").apply { isDaemon = true; start() }
    }

    private fun clearOutboundQueue() {
        while (true) zeroizePcm(outboundQueue.poll() ?: return)
    }

    private fun zeroizePcm(message: OutboundMessage) {
        if (message.kind == FrameKind.PCM) Arrays.fill(message.payload, 0)
    }

    private fun admitClient(socket: Socket) {
        val cleanupGuard = AtomicBoolean(false)
        val generation: Long
        synchronized(connectionLock) {
            if (currentClient != null || connectedClients.get() != 0) {
                try { socket.close() } catch (_: IOException) {}
                return
            }
            connectedClients.set(1)
            currentClient = socket
            currentCleanupGuard = cleanupGuard
            generation = nextGeneration.incrementAndGet()
            currentGeneration = generation
            downlinkQueue.activate(generation)
            outboundSequence.set(0L)
            inboundLastSequence.set(NO_SEQUENCE)
            clearOutboundQueue()
        }
        currentReader = Thread({
            var authenticated = false
            try {
                val input: InputStream = socket.getInputStream()
                val secret = enrollmentSecret
                val authenticatedSessionId = if (secret != null) {
                    authenticate(socket, input, secret) ?: run {
                        listener.onAuthenticationFailed("Controller authentication failed")
                        return@Thread
                    }
                } else {
                    0L
                }
                authenticated = true
                startWriter(socket, cleanupGuard, authenticatedSessionId, generation)
                listener.onDesktopConnected(generation)
                val decoder = StreamingFrameDecoder()
                val buf = ByteArray(READ_CHUNK)
                while (running.get() && !socket.isClosed) {
                    val n = try {
                        input.read(buf)
                    } catch (e: IOException) {
                        break
                    }
                    if (n < 0) break
                    if (n == 0) continue
                    val frames = try {
                        decoder.feed(buf.copyOf(n))
                    } catch (e: FrameMalformedException) {
                        protocolError(socket, cleanupGuard); return@Thread
                    }
                    for (frame in frames) {
                        if (secret != null && frame.sessionId != authenticatedSessionId) {
                            protocolError(socket, cleanupGuard); return@Thread
                        }
                        if (!admitInboundSequence(frame.sequence)) continue
                        if (!handleFrame(frame, generation)) {
                            protocolError(socket, cleanupGuard); return@Thread
                        }
                    }
                }
            } catch (_: IOException) {
            } finally {
                if (teardownConnection(socket, cleanupGuard, runCleanup = true)) {
                    if (authenticated) listener.onDesktopDisconnected(generation, "Network tunnel closed")
                }
            }
        }, "network-gateway-read").apply { isDaemon = true; start() }
    }

    private fun authenticate(socket: Socket, input: InputStream, secret: ByteArray): Long? {
        val originalTimeout = socket.soTimeout
        val serverNonce = ByteArray(AUTH_NONCE_BYTES)
        val clientRecord = ByteArray(AUTH_CLIENT_RECORD_BYTES)
        var expectedClientProof: ByteArray? = null
        var serverProof: ByteArray? = null
        var sessionDigest: ByteArray? = null
        return try {
            socket.soTimeout = authenticationTimeoutMillis
            SecureRandom().nextBytes(serverNonce)
            socket.getOutputStream().apply {
                write(AUTH_MAGIC_SERVER_HELLO)
                write(serverNonce)
                flush()
            }
            readFully(input, clientRecord)
            if (!clientRecord.copyOfRange(0, AUTH_MAGIC_BYTES).contentEquals(AUTH_MAGIC_CLIENT_PROOF)) {
                return null
            }
            val clientNonce = clientRecord.copyOfRange(AUTH_MAGIC_BYTES, AUTH_MAGIC_BYTES + AUTH_NONCE_BYTES)
            try {
                expectedClientProof = authProof(secret, AUTH_CLIENT_DOMAIN, serverNonce, clientNonce)
                val suppliedProof = clientRecord.copyOfRange(
                    AUTH_MAGIC_BYTES + AUTH_NONCE_BYTES,
                    AUTH_CLIENT_RECORD_BYTES,
                )
                if (!MessageDigest.isEqual(expectedClientProof, suppliedProof)) return null
                val admitted = try {
                    authenticationSuccessGate?.invoke() ?: true
                } catch (_: Exception) {
                    false
                }
                if (!admitted) return null
                serverProof = authProof(secret, AUTH_SERVER_DOMAIN, serverNonce, clientNonce)
                socket.getOutputStream().apply {
                    write(AUTH_MAGIC_SERVER_PROOF)
                    write(serverProof)
                    flush()
                }
                sessionDigest = authProof(secret, AUTH_SESSION_DOMAIN, serverNonce, clientNonce)
                readU32(sessionDigest)
            } finally {
                Arrays.fill(clientNonce, 0)
            }
        } catch (_: SocketTimeoutException) {
            null
        } catch (_: IOException) {
            null
        } finally {
            try { socket.soTimeout = originalTimeout } catch (_: IOException) {}
            Arrays.fill(serverNonce, 0)
            Arrays.fill(clientRecord, 0)
            expectedClientProof?.let { Arrays.fill(it, 0) }
            serverProof?.let { Arrays.fill(it, 0) }
            sessionDigest?.let { Arrays.fill(it, 0) }
        }
    }

    private fun readU32(bytes: ByteArray): Long =
        ((bytes[0].toLong() and 0xFFL) shl 24) or
            ((bytes[1].toLong() and 0xFFL) shl 16) or
            ((bytes[2].toLong() and 0xFFL) shl 8) or
            (bytes[3].toLong() and 0xFFL)

    private fun readFully(input: InputStream, destination: ByteArray) {
        var offset = 0
        while (offset < destination.size) {
            val count = input.read(destination, offset, destination.size - offset)
            if (count < 0) throw IOException("controller authentication ended early")
            if (count > 0) offset += count
        }
    }

    private fun authProof(
        secret: ByteArray,
        domain: ByteArray,
        serverNonce: ByteArray,
        clientNonce: ByteArray,
    ): ByteArray = Mac.getInstance("HmacSHA256").run {
        init(SecretKeySpec(secret, "HmacSHA256"))
        update(domain)
        update(serverNonce)
        doFinal(clientNonce)
    }

    private fun admitInboundSequence(sequence: Long): Boolean {
        val previous = inboundLastSequence.get()
        if (previous == NO_SEQUENCE) {
            inboundLastSequence.set(sequence)
            return true
        }
        val distance = (sequence - previous) and U32_MASK
        if (distance !in 1..U32_FORWARD_LIMIT) return false
        inboundLastSequence.set(sequence)
        if (distance > 1L) {
            inboundSequenceGaps.incrementAndGet()
            inboundLostFrames.addAndGet(distance - 1L)
        }
        return true
    }

    private fun handleFrame(frame: Frame, generation: Long): Boolean {
        when (frame.kind) {
            FrameKind.CONTROL -> {
                if (frame.direction != FrameDirection.HOST_TO_DEVICE) return false
                val cmd = try {
                    CommandParser.parse(frame.payload)
                } catch (e: CommandProtocolException) {
                    return false
                }
                when (cmd) {
                    is GatewayCommand.RecordingArtifactBegin -> return recordingArtifactReceiver.begin(cmd)
                    is GatewayCommand.RecordingArtifactCommit -> return recordingArtifactReceiver.commit(cmd)
                    else -> Unit
                }
                if (!cmd.isMutation) {
                    return sendQueryResult(generation, commandExecutor.execute(cmd))
                }
                val fingerprint = cmd.requestFingerprint()
                when (val decision = idempotency.begin(cmd.idempotencyKey, fingerprint, generation)) {
                    IdempotencyCache.Decision.Execute -> Unit
                    is IdempotencyCache.Decision.Replay ->
                        return sendCommandResult(generation, cmd.idempotencyKey, decision.result)
                    IdempotencyCache.Decision.InFlight -> return true
                    IdempotencyCache.Decision.Collision -> return false
                    IdempotencyCache.Decision.GenerationMismatch -> return false
                    IdempotencyCache.Decision.Capacity -> return false
                }
                mutationWorker.execute {
                    if (!isCurrentGeneration(generation)) {
                        idempotency.cancelGeneration(generation)
                        return@execute
                    }
                    try {
                        appliedMutations.incrementAndGet()
                        val result = commandExecutor.execute(cmd)
                        val deliveries = idempotency.complete(
                            cmd.idempotencyKey,
                            fingerprint,
                            result,
                            generation,
                        )
                        if (isCurrentGeneration(generation)) repeat(deliveries) {
                            sendCommandResult(generation, cmd.idempotencyKey, result)
                        }
                    } catch (_: Throwable) {
                        val deliveries = idempotency.fail(cmd.idempotencyKey, fingerprint, generation)
                        val failed = CommandExecutionResult.Rejected(cmd.name, "command executor failed")
                        if (isCurrentGeneration(generation)) repeat(deliveries) {
                            sendCommandResult(generation, cmd.idempotencyKey, failed)
                        }
                    }
                }
                return true
            }
            FrameKind.EVENT -> return false
            FrameKind.PCM -> {
                if (frame.direction != FrameDirection.HOST_TO_DEVICE) return false
                if (frame.payload.size != PcmContract.BYTES_PER_FRAME) return false
                return downlinkQueue.offer(generation, frame)
            }
            FrameKind.ARTIFACT -> {
                if (frame.direction != FrameDirection.HOST_TO_DEVICE) return false
                if (frame.payload.isEmpty() || frame.payload.size > FrameCodec.MAX_PAYLOAD_SIZE) return false
                return recordingArtifactReceiver.append(frame.payload)
            }
        }
    }

    private fun sendCommandResult(generation: Long, key: String, result: CommandExecutionResult): Boolean {
        val fields = when (result) {
            is CommandExecutionResult.Accepted ->
                "\"accepted\":true,\"command\":\"${jsonString(result.command)}\""
            is CommandExecutionResult.Rejected ->
                "\"accepted\":false,\"command\":\"${jsonString(result.command)}\",\"reason\":\"${jsonString(result.reason.take(160))}\""
            is CommandExecutionResult.Status ->
                "\"accepted\":true,\"command\":\"status\""
            is CommandExecutionResult.Capabilities ->
                "\"accepted\":true,\"command\":\"capabilities\""
        }
        return sendEventForGeneration(
            generation,
            "{\"event\":\"command_result\",\"idempotencyKey\":\"${jsonString(key)}\",$fields}"
                .toByteArray(StandardCharsets.UTF_8)
        )
    }

    private fun sendQueryResult(generation: Long, result: CommandExecutionResult): Boolean {
        val payload = when (result) {
            is CommandExecutionResult.Capabilities -> {
                val values = result.values.sorted().joinToString(",") { "\"${jsonString(it)}\"" }
                "{\"event\":\"capabilities\",\"values\":[$values]}"
            }
            is CommandExecutionResult.Status -> {
                val snapshot = result.snapshot
                val activeCall = snapshot.activeCallId?.let { "\"${jsonString(it)}\"" } ?: "null"
                "{\"event\":\"status\",\"listenerRunning\":${snapshot.listenerRunning}," +
                    "\"desktopConnected\":${snapshot.desktopConnected},\"activeCallId\":$activeCall," +
                    "\"recordingHealthy\":${snapshot.recordingHealthy}}"
            }
            is CommandExecutionResult.Accepted,
            is CommandExecutionResult.Rejected -> return true
        }
        return sendEventForGeneration(generation, payload.toByteArray(StandardCharsets.UTF_8))
    }

    private fun isCurrentGeneration(generation: Long): Boolean = synchronized(connectionLock) {
        currentGeneration == generation && currentClient?.let { !it.isClosed && it.isConnected } == true
    }

    private fun sendEventForGeneration(generation: Long, payload: ByteArray): Boolean =
        synchronized(connectionLock) {
            if (currentGeneration != generation) return@synchronized false
            sendOutbound(FrameKind.EVENT, payload)
        }

    private fun jsonString(value: String): String = buildString(value.length) {
        value.forEach { character ->
            when (character) {
                '\\' -> append("\\\\\\\\")
                '"' -> append("\\\"")
                '\n' -> append("\\n")
                '\r' -> append("\\r")
                '\t' -> append("\\t")
                else -> if (character.code >= 0x20) append(character)
            }
        }
    }

    private fun applyMutation(cmd: GatewayCommand) {
        appliedMutations.incrementAndGet()
        @Suppress("UNUSED_VARIABLE")
        val safe = cmd.redactedSummary()
    }

    private fun protocolError(socket: Socket, cleanupGuard: AtomicBoolean) {
        try { socket.close() } catch (_: IOException) {}
        teardownConnection(socket, cleanupGuard, runCleanup = true)
    }

    private fun teardownConnection(
        socket: Socket,
        cleanupGuard: AtomicBoolean,
        runCleanup: Boolean,
    ): Boolean {
        synchronized(connectionLock) {
            if (currentClient !== socket || currentCleanupGuard !== cleanupGuard) return false
            if (!cleanupGuard.compareAndSet(false, true)) return false

            val disconnectedGeneration = currentGeneration
            recordingArtifactReceiver.abort()
            try { socket.close() } catch (_: IOException) {}
            currentWriter?.interrupt()
            currentWriter = null
            clearOutboundQueue()
            downlinkQueue.clear()
            if (runCleanup) cleanupCount.incrementAndGet()
            currentClient = null
            currentCleanupGuard = null
            currentGeneration = NO_GENERATION
            connectedClients.set(0)
            idempotency.cancelGeneration(disconnectedGeneration)
            return true
        }
    }

    fun connectedClientCount(): Int = connectedClients.get()
    fun cleanupCount(): Int = cleanupCount.get()
    fun awaitCleanupCount(target: Int, timeout: Long, unit: TimeUnit): Boolean {
        val deadline = System.currentTimeMillis() + unit.toMillis(timeout)
        while (System.currentTimeMillis() < deadline) {
            if (cleanupCount.get() >= target) return true
            Thread.sleep(10)
        }
        return cleanupCount.get() >= target
    }

    fun downlinkPollerForCurrentGeneration(): ((ByteArray) -> Boolean)? = synchronized(connectionLock) {
        val generation = currentGeneration
        if (generation == NO_GENERATION) null else { destination -> downlinkQueue.pollInto(generation, destination) }
    }

    fun pollDownlinkInto(destination: ByteArray): Boolean {
        val generation = currentGeneration
        return generation != NO_GENERATION && downlinkQueue.pollInto(generation, destination)
    }
    fun clearDownlink() = downlinkQueue.clear()
    fun downlinkQueueDepth(): Int = downlinkQueue.depth
    fun appliedMutationCount(): Int = appliedMutations.get()
    fun inboundSequenceGapCount(): Long = inboundSequenceGaps.get()
    fun inboundLostFrameCount(): Long = inboundLostFrames.get()

    companion object {
        const val BIND_ADDRESS: String = "0.0.0.0"
        const val BIND_PORT: Int = 27183

        private const val DOWNLINK_QUEUE_CAPACITY: Int = 64
        private const val OUTBOUND_QUEUE_CAPACITY: Int = 128
        private const val IDEMPOTENCY_CACHE_CAPACITY: Int = 256
        private const val READ_CHUNK: Int = 8192
        private const val NO_SEQUENCE: Long = -1L
        private const val NO_GENERATION: Long = -1L
        private const val U32_MASK: Long = 0xFFFF_FFFFL
        private const val U32_FORWARD_LIMIT: Long = 0x7FFF_FFFFL
        private const val AUTH_MAGIC_BYTES: Int = 4
        private const val AUTH_NONCE_BYTES: Int = 32
        private const val AUTH_PROOF_BYTES: Int = 32
        private const val AUTH_SECRET_BYTES: Int = 32
        private const val AUTH_CLIENT_RECORD_BYTES: Int =
            AUTH_MAGIC_BYTES + AUTH_NONCE_BYTES + AUTH_PROOF_BYTES
        private val AUTH_MAGIC_SERVER_HELLO = "G2A1".toByteArray(StandardCharsets.US_ASCII)
        private val AUTH_MAGIC_CLIENT_PROOF = "G2C1".toByteArray(StandardCharsets.US_ASCII)
        private val AUTH_MAGIC_SERVER_PROOF = "G2S1".toByteArray(StandardCharsets.US_ASCII)
        private val AUTH_CLIENT_DOMAIN =
            "agentcall-controller-client-v1\u0000".toByteArray(StandardCharsets.US_ASCII)
        private val AUTH_SERVER_DOMAIN =
            "agentcall-controller-server-v1\u0000".toByteArray(StandardCharsets.US_ASCII)
        private val AUTH_SESSION_DOMAIN =
            "agentcall-controller-session-v1\u0000".toByteArray(StandardCharsets.US_ASCII)
    }
}

interface NetworkGatewayListener {
    fun onListenerStarted(port: Int) {}
    fun onDesktopConnected() {}
    fun onDesktopConnected(generation: Long) = onDesktopConnected()
    fun onDesktopDisconnected(reason: String) {}
    fun onDesktopDisconnected(generation: Long, reason: String) = onDesktopDisconnected(reason)
    fun onError(reason: String) {}
    fun onAuthenticationFailed(reason: String) {}

    companion object {
        val NONE = object : NetworkGatewayListener {}
    }
}
