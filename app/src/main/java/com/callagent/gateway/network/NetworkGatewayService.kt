package com.callagent.gateway.network

import android.annotation.TargetApi
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.media.AudioManager
import android.os.Build
import android.os.IBinder
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.Process
import android.util.Log
import com.callagent.gateway.DeviceSelector
import com.callagent.gateway.FileApprovedDeviceEvidenceProvider
import com.callagent.gateway.ApprovedDeviceEvidenceProvider
import com.callagent.gateway.R
import com.callagent.gateway.audio.AndroidAudioBridge
import com.callagent.gateway.audio.AudioBridgeContract
import com.callagent.gateway.audio.AudioBridgeController
import com.callagent.gateway.audio.LifecycleListener
import com.callagent.gateway.dialer.DialerCallState
import com.callagent.gateway.dialer.DialerCallStateStore
import com.callagent.gateway.dialer.CallHistoryRepository
import com.callagent.gateway.dialer.ContactRepository
import com.callagent.gateway.dialer.PhoneRecordingArtifactReceiver
import com.callagent.gateway.dialer.PhoneRecordingMediaStore
import com.callagent.gateway.dialer.PhoneRecordingStore
import com.callagent.gateway.gsm.GsmCallManager
import com.callagent.gateway.usb.*
import com.callagent.gateway.usb.UsbAudioBridgeCoordinator
import com.callagent.gateway.usb.UsbAudioBridgeControl
import com.callagent.gateway.usb.AudioBridgeStartResult
import com.callagent.gateway.usb.UsbPcmDownlinkSink
import com.callagent.gateway.usb.UsbPcmUplinkSource
import org.json.JSONObject
import java.net.InetAddress
import java.net.ServerSocket
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/**
 * Network-mode gateway service. Listens on a configurable TCP port (default 27183)
 * for PC clients over Tailscale/LAN/internet, instead of the ADB-forwarded loopback
 * used by [com.callagent.gateway.usb.UsbGatewayService].
 *
 * The protocol engine, auth, command execution, audio bridge, and telephony handling
 * are identical to the USB service — only the transport binding differs.
 */
@TargetApi(33)
class NetworkGatewayService : Service() {
    private val started = AtomicBoolean(false)
    private val lifecycleGeneration = AtomicLong(0L)
    private var server: NetworkGatewayServer? = null
    private var bootstrapServer: ControllerBootstrapServer? = null
    private var stagedRecovery: StagedRecoveryLifecycle? = null
    private var enrollmentStore: ControllerEnrollmentStore? = null
    private var audioBridge: AndroidAudioBridge? = null
    private var audioCoordinator: UsbAudioBridgeCoordinator? = null
    private var outgoingRecordingWatchdog: OutgoingRecordingWatchdog? = null
    private var phoneDataExecutor = Executors.newSingleThreadExecutor()
    private var wakeLock: PowerManager.WakeLock? = null
    private val qualificationHandler = Handler(Looper.getMainLooper())
    private val qualificationRecheck = object : Runnable {
        override fun run() {
            if (!started.get()) return
            audioCoordinator?.revalidateDeviceQualification()
            qualificationHandler.postDelayed(this, QUALIFICATION_RECHECK_MS)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> stopGateway()
            else -> startGateway()
        }
        return START_NOT_STICKY
    }

    private fun startGateway() {
        if (!started.compareAndSet(false, true)) return
        if (phoneDataExecutor.isShutdown) phoneDataExecutor = Executors.newSingleThreadExecutor()
        lifecycleGeneration.incrementAndGet()
        val requiredPermissions = listOf(
            android.Manifest.permission.READ_PHONE_STATE,
            android.Manifest.permission.CALL_PHONE,
            android.Manifest.permission.ANSWER_PHONE_CALLS,
            android.Manifest.permission.RECORD_AUDIO,
            android.Manifest.permission.READ_CONTACTS,
            android.Manifest.permission.READ_CALL_LOG,
        )
        if (!GatewayPermissionGate.mayStart(requiredPermissions.map {
                checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED
            })) {
            GatewayStateStore.update(this, GatewayUiEvent.Error("Required phone and audio permission denied"))
            started.set(false)
            stopSelf()
            return
        }
        startForegroundCompat("Waiting for desktop over network")
        val enrollmentStore = ControllerEnrollmentStore(AndroidControllerSecretStorage(this))
        this.enrollmentStore = enrollmentStore
        when (enrollmentStore.state()) {
            ControllerEnrollmentState.EMPTY -> startBootstrapGateway(enrollmentStore)
            ControllerEnrollmentState.STAGED -> startStagedRecovery(enrollmentStore)
            ControllerEnrollmentState.COMMITTED -> {
                val controllerSecret = enrollmentStore.load() ?: run { stopGateway(); return }
                try {
                    startEnrolledGateway(controllerSecret)
                } finally {
                    controllerSecret.fill(0)
                }
            }
            ControllerEnrollmentState.ASYMMETRIC_RESET_REQUIRED -> {
                notifyStatus("Controller enrollment reset required")
                stopGateway(GatewayUiEvent.Error("Controller enrollment reset required. Forget the paired desktop and try again."))
            }
        }
    }

    private fun startBootstrapGateway(enrollmentStore: ControllerEnrollmentStore) {
        val expectedGeneration = lifecycleGeneration.get()
        GatewayStateStore.update(this, GatewayUiEvent.WaitingForPairing)
        notifyStatus("Waiting for authorized desktop pairing")
        val bootstrap = ControllerBootstrapServer(
            enrollmentStore = enrollmentStore,
            expectedIdentity = { identity ->
                identity.systemFingerprint == Build.FINGERPRINT &&
                    identity.vendorFingerprint == currentVendorFingerprint() &&
                    identity.packageName == packageName &&
                    identity.versionCode == packageManager.getPackageInfo(packageName, 0).versionCode.toString()
            },
            onStaged = { staged ->
                qualificationHandler.post {
                    try {
                        if (started.get() && lifecycleGeneration.get() == expectedGeneration) {
                            startG2FinalProof(enrollmentStore, staged, expectedGeneration = expectedGeneration)
                        }
                    } finally { staged.fill(0) }
                }
            },
            onExpired = {
                qualificationHandler.post {
                    if (started.get() && lifecycleGeneration.get() == expectedGeneration) {
                        notifyStatus("Desktop pairing timed out")
                        stopGateway(GatewayUiEvent.Error("Desktop pairing timed out. Tap Connect desktop to try again."))
                    }
                }
            },
            bindHost = "0.0.0.0",
        )
        bootstrapServer = bootstrap
        try {
            bootstrap.start()
        } catch (error: Exception) {
            Log.e(TAG, "Desktop pairing listener failed", error)
            bootstrapServer = null
            stopGateway(GatewayUiEvent.Error("Desktop pairing could not start. Tap Connect desktop to retry."))
        }
    }

    private fun startStagedRecovery(enrollmentStore: ControllerEnrollmentStore) {
        val lifecycle = StagedRecoveryLifecycle(enrollmentStore)
        stagedRecovery = lifecycle
        if (lifecycle.start() != StagedRecoveryLifecycle.StartAction.RECOVER_OPERATIONAL_G2) {
            stopGateway()
            return
        }
        val staged = enrollmentStore.loadStaged() ?: run { stopGateway(); return }
        try { startG2FinalProof(enrollmentStore, staged, lifecycle) } finally { staged.fill(0) }
    }

    private fun startG2FinalProof(
        enrollmentStore: ControllerEnrollmentStore,
        staged: ByteArray,
        recovery: StagedRecoveryLifecycle? = null,
        expectedGeneration: Long = lifecycleGeneration.get(),
    ) {
        if (!started.get() || lifecycleGeneration.get() != expectedGeneration) return
        bootstrapServer?.stop()
        bootstrapServer = null
        val lifecycle = recovery ?: StagedRecoveryLifecycle(enrollmentStore).also {
            stagedRecovery = it
            check(it.start() == StagedRecoveryLifecycle.StartAction.RECOVER_OPERATIONAL_G2)
        }
        val proofSecret = staged.copyOf()
        val pairingCommitted = AtomicBoolean(false)
        val onG2Authenticated = object : NetworkGatewayListener {
            override fun onListenerStarted(port: Int) {
                GatewayStateStore.update(this@NetworkGatewayService, GatewayUiEvent.ListenerStarted(port))
                notifyStatus("Verifying paired desktop")
            }
            override fun onDesktopConnected(generation: Long) {
                if (!started.get() || lifecycleGeneration.get() != expectedGeneration) return
                server?.stop()
                server = null
                if (!pairingCommitted.get()) {
                    proofSecret.fill(0)
                    stopGateway(GatewayUiEvent.Error("Secure desktop pairing could not be saved. Tap Connect desktop to retry."))
                    return
                }
                qualificationHandler.post {
                    try {
                        if (started.get() && lifecycleGeneration.get() == expectedGeneration) {
                            startEnrolledGateway(proofSecret)
                        }
                    } finally { proofSecret.fill(0) }
                }
            }
            override fun onDesktopDisconnected(generation: Long, reason: String) = Unit
            override fun onAuthenticationFailed(reason: String) {
                lifecycle.fail()
                proofSecret.fill(0)
                Log.w(TAG, "Controller authentication failed: $reason")
                stopGateway(GatewayUiEvent.Error("Secure desktop authentication failed. Tap Connect desktop to retry."))
            }
            override fun onError(reason: String) {
                lifecycle.fail()
                proofSecret.fill(0)
                Log.w(TAG, "Controller pairing server failed: $reason")
                stopGateway(GatewayUiEvent.Error("Secure desktop authentication failed. Tap Connect desktop to retry."))
            }
        }
        server = NetworkGatewayServer(
            serverSocketFactory = ServerSocketFactory { host, port -> ServerSocket(port, 1, InetAddress.getByName(host)) },
            listener = onG2Authenticated,
            enrollmentSecret = staged.copyOf(),
            authenticationSuccessGate = {
                lifecycle.onOperationalG2AuthenticatedAndCommit(proofSecret).also { committed ->
                    if (committed) {
                        stagedRecovery = null
                        pairingCommitted.set(true)
                    }
                }
            },
        ).also { it.start() }
    }

    private fun startEnrolledGateway(controllerSecret: ByteArray) {
        val evidenceProvider = FileApprovedDeviceEvidenceProvider(
            filesDir.toPath().resolve(FileApprovedDeviceEvidenceProvider.FILE_NAME),
            Process.myUid(),
        )
        GsmCallManager.setApprovedDeviceEvidenceProvider(evidenceProvider)
        qualifyDevice(evidenceProvider)
        GatewayStateStore.update(this, GatewayUiEvent.TelecomReady)
        GatewayStateStore.update(this, GatewayUiEvent.RecordingFailed("Desktop recorder health not confirmed"))

        val bridge = AndroidAudioBridge(this)
        audioBridge = bridge
        audioCoordinator = UsbAudioBridgeCoordinator(object : UsbAudioBridgeControl {
            override fun start(): Boolean {
                val currentServer = server ?: return false
                val outcome = bridge.start(
                    facts = audioFacts(),
                    downlinkSink = UsbPcmDownlinkSink(currentServer::sendPcm),
                    uplinkSource = UsbPcmUplinkSource(currentServer.downlinkPollerForCurrentGeneration() ?: return false),
                    listener = object : LifecycleListener {
                        override fun onWorkerFailure(reason: String) {
                            GatewayStateStore.update(
                                this@NetworkGatewayService,
                                GatewayUiEvent.AudioReady(rx = false, tx = false),
                            )
                            audioCoordinator?.onBridgeFailed()?.let(::emitMediaFailure)
                            notifyStatus("Cellular audio bridge unavailable")
                        }
                    },
                )
                val active = AudioBridgeStartResult.isActive(
                    outcome,
                    coordinatorRunning = audioCoordinator?.running == true,
                )
                GatewayStateStore.update(this@NetworkGatewayService, GatewayUiEvent.AudioReady(active, active))
                return active
            }

            override fun stop() {
                bridge.stop()
                GatewayStateStore.update(
                    this@NetworkGatewayService,
                    GatewayUiEvent.AudioReady(rx = false, tx = false),
                )
            }

            override fun discardQueuedAudio() {
                server?.clearDownlink()
            }
        }, deviceQualified = { qualifyDevice(evidenceProvider) })
        qualificationHandler.removeCallbacks(qualificationRecheck)
        qualificationHandler.postDelayed(qualificationRecheck, QUALIFICATION_RECHECK_MS)

        val watchdogHandler = Handler(Looper.getMainLooper())
        outgoingRecordingWatchdog = OutgoingRecordingWatchdog(
            scheduler = OutgoingRecordingWatchdog.Scheduler { delayMs, task ->
                val runnable = Runnable(task)
                watchdogHandler.postDelayed(runnable, delayMs)
                object : OutgoingRecordingWatchdog.Scheduled {
                    override fun cancel() { watchdogHandler.removeCallbacks(runnable) }
                }
            },
            timeoutMs = OUTGOING_RECORDING_TIMEOUT_MS,
            hangup = { callId ->
                if (GsmCallManager.activeCallId == callId) GsmCallManager.hangupCall()
            },
            pendingExpired = {
                GsmCallManager.cancelPendingGatewayDial()
                notifyStatus("Outgoing call failed before recording correlation")
            },
        )

        val executor = CorrelatedTelecomExecutor(
            telecom = AndroidTelecomPort(this),
            activeCallId = ActiveCallId { GsmCallManager.activeCallId },
            snapshot = {
                val state = GatewayStateStore.snapshot()
                GatewayRuntimeSnapshot(
                    listenerRunning = state.connection != GatewayUiState.Connection.STOPPED,
                    desktopConnected = state.desktopConnected,
                    activeCallId = state.call.id,
                    recordingHealthy = state.recording == GatewayUiState.Health.HEALTHY,
                )
            },
            recordingHealthChanged = { healthy ->
                GatewayStateStore.update(
                    this,
                    if (healthy) GatewayUiEvent.RecordingHealthy
                    else GatewayUiEvent.RecordingFailed("Desktop recorder unavailable"),
                )
                audioCoordinator?.onRecordingHealthy(healthy)
            },
            recordingSessionChanged = { callId, active ->
                outgoingRecordingWatchdog?.onRecordingSession(callId, active)
                audioCoordinator?.onRecordingSession(callId, active)
            },
            gatewayDialStarting = { outgoingRecordingWatchdog?.onGatewayDialStarting() == true },
            gatewayDialRejected = { outgoingRecordingWatchdog?.onGatewayDialRejected() },
            provisionDeviceEvidence = { command ->
                val installed = ApprovedDeviceEvidenceProvisioner(
                    target = filesDir.toPath().resolve(FileApprovedDeviceEvidenceProvider.FILE_NAME),
                    expectedUid = android.os.Process.myUid(),
                    expectedSystemFingerprint = Build.FINGERPRINT,
                    expectedVendorFingerprint = currentVendorFingerprint(),
                ).provision(command)
                installed && qualifyDevice(evidenceProvider)
            },
            phoneDataSync = PhoneDataSyncPort { command ->
                if (phoneDataExecutor.isShutdown) return@PhoneDataSyncPort false
                val generation = server?.authenticatedGeneration() ?: return@PhoneDataSyncPort false
                phoneDataExecutor.execute {
                    try {
                        val pages = when (command) {
                            is GatewayCommand.SyncContacts -> PhoneDataSnapshotEncoder.contacts(
                                command.requestId,
                                ContactRepository(this).list(500).map { PhoneContactRow(it.id, it.name, it.number) },
                            )
                            is GatewayCommand.SyncCallLog -> PhoneDataSnapshotEncoder.callLog(
                                command.requestId,
                                CallHistoryRepository(this).recent(200).map {
                                    PhoneCallLogRow(
                                        id = it.id,
                                        number = it.number,
                                        name = it.cachedName,
                                        kind = it.kind.name.lowercase(),
                                        timestampMillis = it.timestampMillis,
                                        durationSeconds = it.durationSeconds,
                                    )
                                },
                            )
                            else -> return@execute
                        }
                        pages.forEach { page ->
                            if (server?.sendEventForAuthenticatedGeneration(generation, page.toByteArray(Charsets.UTF_8)) != true) return@execute
                        }
                    } catch (error: Exception) {
                        Log.e(TAG, "Phone data synchronization failed", error)
                    }
                }
                true
            },
        )
        val lifecycleOwner = ConnectionGenerationOwner()
        val listener = object : NetworkGatewayListener {
            override fun onListenerStarted(port: Int) {
                GatewayStateStore.update(this@NetworkGatewayService, GatewayUiEvent.ListenerStarted(port))
                notifyStatus("Waiting for desktop over network")
            }

            override fun onDesktopConnected(generation: Long) {
                if (!lifecycleOwner.connected(generation)) return
                GatewayStateStore.update(this@NetworkGatewayService, GatewayUiEvent.DesktopConnected)
                audioCoordinator?.onDesktopConnected(true)
                server?.sendEvent(
                    JSONObject()
                        .put("event", "capabilities")
                        .put("values", org.json.JSONArray(CorrelatedTelecomExecutor.CAPABILITIES.toList().sorted()))
                        .toString()
                        .toByteArray(Charsets.UTF_8),
                )
                notifyStatus("Desktop connected over network")
            }

            override fun onDesktopDisconnected(generation: Long, reason: String) {
                if (!lifecycleOwner.disconnected(generation)) return
                outgoingRecordingWatchdog?.onGatewayDisconnected()
                audioCoordinator?.onDesktopConnected(false)
                GatewayStateStore.update(this@NetworkGatewayService, GatewayUiEvent.RecordingFailed("Desktop recorder disconnected"))
                GatewayStateStore.update(this@NetworkGatewayService, GatewayUiEvent.DesktopDisconnected(reason))
                notifyStatus("Waiting for desktop over network")
            }

            override fun onError(reason: String) {
                GatewayStateStore.update(this@NetworkGatewayService, GatewayUiEvent.Error(reason))
                notifyStatus("Network gateway unavailable")
            }
        }

        try {
            val mediaStore = PhoneRecordingMediaStore(this)
            val artifactReceiver = PhoneRecordingArtifactReceiver(
                store = PhoneRecordingStore(filesDir.resolve("recording-staging")),
                publish = { entry -> mediaStore.publish(entry) },
                isCallIdle = {
                    DialerCallStateStore.snapshot().phase in setOf(
                        DialerCallState.Phase.IDLE,
                        DialerCallState.Phase.ENDING,
                        DialerCallState.Phase.ENDED,
                    )
                },
                emitReceipt = { receipt -> server?.sendEvent(receipt.toByteArray(Charsets.UTF_8)) },
                reportFailure = { message, error -> Log.e(TAG, message, error) },
            )
            val newServer = NetworkGatewayServer(
                serverSocketFactory = ServerSocketFactory { host, port ->
                    ServerSocket(port, 1, InetAddress.getByName(host))
                },
                commandExecutor = executor,
                listener = listener,
                recordingArtifactReceiver = artifactReceiver,
                enrollmentSecret = controllerSecret.copyOf(),
            )
            server = newServer
            newServer.start()
            installCallListener()
            acquireWakeLock()
        } catch (error: Exception) {
            Log.e(TAG, "Operational network listener failed", error)
            notifyStatus("Network gateway unavailable")
            stopGateway(GatewayUiEvent.Error("The network gateway could not start. Tap Connect desktop to retry."))
        }
    }

    private fun installCallListener() {
        GsmCallManager.listener = object : GsmCallManager.Listener {
            override fun onIncomingGsmCall(call: android.telecom.Call, number: String) {
                val id = GsmCallManager.activeCallId ?: return
                emitCallEvent("incoming", id, RedactingLog.redactPhone(number), number)
                GatewayStateStore.update(
                    this@NetworkGatewayService,
                    GatewayUiEvent.IncomingCall(id, RedactingLog.redactPhone(number)),
                )
            }

            override fun onGsmCallActive(call: android.telecom.Call) {
                val id = GsmCallManager.activeCallId ?: return
                val outgoing = GsmCallManager.isGatewayOutgoingCall(call)
                if (outgoing) outgoingRecordingWatchdog?.onOutgoingCall(id)
                emitCallEvent("active", id, direction = if (outgoing) "outgoing" else null)
                GatewayStateStore.update(this@NetworkGatewayService, GatewayUiEvent.CallChanged(id, GatewayUiState.CallPhase.ACTIVE))
                GsmCallManager.prepareActiveAudioRoute()
                audioCoordinator?.onCall(id, active = true)
            }

            override fun onGsmCallStateChanged(call: android.telecom.Call, state: Int) {
                val id = GsmCallManager.activeCallId ?: return
                val phase = when (state) {
                    android.telecom.Call.STATE_RINGING -> GatewayUiState.CallPhase.RINGING
                    android.telecom.Call.STATE_DIALING, android.telecom.Call.STATE_CONNECTING -> GatewayUiState.CallPhase.DIALING
                    android.telecom.Call.STATE_ACTIVE -> GatewayUiState.CallPhase.ACTIVE
                    android.telecom.Call.STATE_DISCONNECTING -> GatewayUiState.CallPhase.ENDING
                    android.telecom.Call.STATE_DISCONNECTED -> GatewayUiState.CallPhase.ENDED
                    else -> return
                }
                val outgoing = GsmCallManager.isGatewayOutgoingCall(call)
                if (outgoing && (phase == GatewayUiState.CallPhase.DIALING || phase == GatewayUiState.CallPhase.ACTIVE)) {
                    outgoingRecordingWatchdog?.onOutgoingCall(id)
                }
                emitCallEvent(phase.name.lowercase(), id, direction = if (outgoing) "outgoing" else null)
                GatewayStateStore.update(this@NetworkGatewayService, GatewayUiEvent.CallChanged(id, phase))
                if (phase == GatewayUiState.CallPhase.ACTIVE) GsmCallManager.prepareActiveAudioRoute()
                audioCoordinator?.onCall(id, active = phase == GatewayUiState.CallPhase.ACTIVE)
            }

            override fun onGsmCallEnded(call: android.telecom.Call) {
                val id = GsmCallManager.activeCallId ?: GatewayStateStore.snapshot().call.id ?: "ended"
                outgoingRecordingWatchdog?.onCallEnded(id)
                audioCoordinator?.onCall(id, active = false)
                emitCallEvent("ended", id)
                GatewayStateStore.update(this@NetworkGatewayService, GatewayUiEvent.CallChanged(id, GatewayUiState.CallPhase.ENDED))
            }
        }
    }

    private fun emitCallEvent(
        event: String,
        callId: String,
        displayNumber: String? = null,
        callerNumber: String? = null,
        direction: String? = null,
    ) {
        val value = JSONObject()
            .put("event", event)
            .put("callId", callId)
        if (displayNumber != null) value.put("displayNumber", displayNumber)
        if (callerNumber != null) value.put("callerNumber", callerNumber)
        if (direction != null) value.put("direction", direction)
        server?.sendEvent(value.toString().toByteArray(Charsets.UTF_8))
    }

    private fun emitMediaFailure(failure: AudioBridgeFailure) {
        server?.sendEvent(AudioBridgeFailureEvent.encode(failure))
    }

    private fun audioFacts(): AudioBridgeController.Facts {
        val audioManager = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        fun granted(required: Set<String>): Set<String> = required.filterTo(mutableSetOf()) {
            checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED
        }
        return AudioBridgeController.Facts(
            activeCall = audioManager.mode == AudioManager.MODE_IN_CALL,
            grantedDownlinkPermissions = granted(AudioBridgeContract.DOWNLINK_REQUIRED_PERMISSIONS),
            grantedUplinkPermissions = granted(AudioBridgeContract.UPLINK_REQUIRED_PERMISSIONS),
        )
    }

    private fun qualifyDevice(evidenceProvider: ApprovedDeviceEvidenceProvider): Boolean {
        val vendorFingerprint = currentVendorFingerprint()
        val selection = DeviceSelector.select(
            DeviceSelector.Identity(
                hardware = Build.HARDWARE,
                board = Build.BOARD,
                model = Build.MODEL,
                device = Build.DEVICE,
                apiLevel = Build.VERSION.SDK_INT,
                fingerprint = Build.FINGERPRINT,
                vendorFingerprint = vendorFingerprint,
            ),
            evidenceProvider.read(),
        )
        val deviceQualified = selection.profileId == DeviceSelector.ProfileId.ATOLL_GRAM
        val qualification = if (deviceQualified) "qualified" else "unsupported"
        GatewayStateStore.update(this, GatewayUiEvent.DeviceQualified(Build.MODEL, Build.DEVICE, qualification))
        return deviceQualified
    }

    private fun currentVendorFingerprint(): String =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            Build.getFingerprintedPartitions()
                .firstOrNull { it.name == "vendor" }
                ?.fingerprint
                .orEmpty()
        } else {
            ""
        }

    private fun stopGateway(finalEvent: GatewayUiEvent = GatewayUiEvent.Stopped) {
        if (!started.compareAndSet(true, false)) {
            stopSelf()
            return
        }
        lifecycleGeneration.incrementAndGet()
        audioCoordinator?.stop()
        audioCoordinator = null
        outgoingRecordingWatchdog?.onGatewayDisconnected()
        outgoingRecordingWatchdog = null
        phoneDataExecutor.shutdownNow()
        qualificationHandler.removeCallbacksAndMessages(null)
        audioBridge = null
        server?.stop()
        server = null
        bootstrapServer?.stop()
        bootstrapServer = null
        stagedRecovery?.stop()
        stagedRecovery = null
        enrollmentStore = null
        GsmCallManager.listener = null
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
        GatewayStateStore.update(this, finalEvent)
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun acquireWakeLock() {
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "agentcall:network-gateway").apply {
            acquire(12 * 60 * 60 * 1000L)
        }
    }

    private fun createChannel() {
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "AgentCall network gateway", NotificationManager.IMPORTANCE_LOW)
        )
    }

    private fun notification(text: String): Notification {
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, UsbGatewayActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("AgentCall")
            .setContentText(text)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentIntent(open)
            .setOngoing(true)
            .setCategory(Notification.CATEGORY_SERVICE)
            .build()
    }

    private fun startForegroundCompat(text: String) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification(text), ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL)
        } else startForeground(NOTIFICATION_ID, notification(text))
    }

    private fun notifyStatus(text: String) {
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification(text))
    }

    override fun onDestroy() {
        stopGateway()
        super.onDestroy()
    }

    companion object {
        private const val TAG = "agentcall-network-gateway"
        private const val OUTGOING_RECORDING_TIMEOUT_MS = 15_000L
        private const val QUALIFICATION_RECHECK_MS = 60L * 60L * 1000L
        const val ACTION_START = "com.callagent.gateway.NETWORK_START"
        const val ACTION_STOP = "com.callagent.gateway.NETWORK_STOP"
        private const val CHANNEL_ID = "agentcall_network_gateway"
        private const val NOTIFICATION_ID = 27184

        fun start(context: Context) = context.startForegroundService(
            Intent(context, NetworkGatewayService::class.java).setAction(ACTION_START)
        )

        fun stop(context: Context) = context.startService(
            Intent(context, NetworkGatewayService::class.java).setAction(ACTION_STOP)
        )
    }
}
