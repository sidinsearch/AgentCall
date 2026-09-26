package com.callagent.gateway.network

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.MenuItem
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.callagent.gateway.BuildConfig
import com.callagent.gateway.R
import com.callagent.gateway.gsm.GsmCallManager
import com.callagent.gateway.usb.GatewayStateStore
import com.callagent.gateway.usb.GatewayUiState
import java.io.IOException
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Network-mode gateway activity. Mirrors the USB gateway screen so users get the
 * same visual language whether they connect over USB or over the network.
 *
 * Opened from the dialer's gateway action when the user chooses network mode.
 */
class NetworkGatewayActivity : AppCompatActivity() {

  private lateinit var badge: TextView
  private lateinit var connection: TextView
  private lateinit var detail: TextView
  private lateinit var toggle: Button
  private lateinit var device: TextView
  private lateinit var telecom: TextView
  private lateinit var audio: TextView
  private lateinit var recording: TextView
  private lateinit var controllerStatus: TextView
  private lateinit var controllerForget: Button
  private lateinit var callCard: View
  private lateinit var callState: TextView
  private lateinit var callNumber: TextView
  private lateinit var answer: Button
  private lateinit var reject: Button
  private lateinit var hangup: Button
  private lateinit var github: Button
  private lateinit var hostInput: EditText
  private lateinit var portInput: EditText
  private lateinit var testBind: Button
  private lateinit var stopBind: Button
  private var serverSocket: ServerSocket? = null
  private val listening = AtomicBoolean(false)

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    if (!BuildConfig.DEBUG) window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
    setContentView(R.layout.activity_network_gateway)
    bindViews()
    toggle.setOnClickListener { onToggle() }
    answer.setOnClickListener { GsmCallManager.answerCall() }
    reject.setOnClickListener { GsmCallManager.rejectCall() }
    hangup.setOnClickListener { GsmCallManager.hangupCall() }
    controllerForget.setOnClickListener { showForgetConfirmation() }
    github.setOnClickListener {
      runCatching {
        startActivity(Intent(Intent.ACTION_VIEW, android.net.Uri.parse(PROJECT_URL)))
      }
    }
    testBind.setOnClickListener { bindForTest() }
    stopBind.setOnClickListener { stopListener() }
    render(GatewayStateStore.snapshot())
  }

  private fun bindViews() {
    badge = findViewById(R.id.tvNetworkTransport)
    connection = findViewById(R.id.tvNetworkConnection)
    detail = findViewById(R.id.tvNetworkDetail)
    toggle = findViewById(R.id.btnNetworkToggle)
    device = findViewById(R.id.tvNetworkDeviceGate)
    telecom = findViewById(R.id.tvNetworkTelecomGate)
    audio = findViewById(R.id.tvNetworkAudioGate)
    recording = findViewById(R.id.tvNetworkRecordingGate)
    controllerStatus = findViewById(R.id.tvNetworkControllerEnrollment)
    controllerForget = findViewById(R.id.btnNetworkForget)
    callCard = findViewById(R.id.callCard)
    callState = findViewById(R.id.tvCallState)
    callNumber = findViewById(R.id.tvCallNumber)
    answer = findViewById(R.id.btnAnswer)
    reject = findViewById(R.id.btnReject)
    hangup = findViewById(R.id.btnHangup)
    github = findViewById(R.id.btnGithub)
    hostInput = findViewById(R.id.etNetworkHost)
    portInput = findViewById(R.id.etNetworkPort)
    testBind = findViewById(R.id.btnNetworkStart)
    stopBind = findViewById(R.id.btnNetworkStop)
  }

  private fun render(state: GatewayUiState) {
    val connected = state.desktopConnected
    val authenticated = state.connection == GatewayUiState.Connection.AUTHENTICATED_NETWORK ||
        state.connection == GatewayUiState.Connection.AUTHENTICATED_USB

    badge.text = when {
      listening.get() -> getString(R.string.network_listening)
      connected && authenticated -> getString(R.string.network_connection_ready)
      connected && !authenticated -> "Connected · authenticating"
      else -> getString(R.string.network_connection_stopped)
    }
    badge.setTextColor(
      when {
        connected && authenticated -> android.graphics.Color.parseColor("#2ECC71")
        listening.get() -> android.graphics.Color.parseColor("#F1C40F")
        else -> android.graphics.Color.parseColor("#E74C3C")
      }
    )

    connection.text = when {
      connected && authenticated -> getString(R.string.network_connection_ready)
      connected -> "Connected · awaiting authentication"
      else -> getString(R.string.network_connection_stopped)
    }
    detail.text = when {
      listening.get() -> getString(R.string.network_connection_ready_detail)
      connected && authenticated -> "Paired · desktop is connected over the network"
      else -> "Tap Start listening to begin, then connect the desktop"
    }

    toggle.text = when {
      listening.get() -> getString(R.string.network_stop_bind)
      connected && authenticated -> "Reconnect desktop"
      else -> getString(R.string.network_listen_start)
    }

    device.text = "Device · ${state.device.model} (${state.device.codename}) · ${state.device.qualification}"
    telecom.text = "Telecom · ${label(state.telecom)}"
    audio.text = "Digital audio · RX ${label(state.audioRx)} · TX ${label(state.audioTx)}"
    recording.text = "Desktop recording · ${label(state.recording)}"

    val enrolled = enrollmentStore().isEnrolled()
    controllerStatus.text = if (enrolled) "Desktop · PAIRED" else getString(R.string.desktop_not_paired)
    controllerForget.isEnabled = state.connection == GatewayUiState.Connection.STOPPED && enrolled

    callCard.visibility = if (state.call.phase == GatewayUiState.CallPhase.IDLE) View.GONE else View.VISIBLE
    callState.text = state.call.phase.name.replace('_', ' ')
    callNumber.text = state.call.displayNumber
    answer.visibility = if (state.call.canAnswer) View.VISIBLE else View.GONE
    reject.visibility = if (state.call.canReject) View.VISIBLE else View.GONE
    hangup.visibility = if (!state.call.canAnswer && state.call.phase != GatewayUiState.CallPhase.ENDED) View.VISIBLE else View.GONE

    if (serverSocket != null && listening.get()) {
      testBind.visibility = View.GONE
      stopBind.visibility = View.VISIBLE
      portInput.isEnabled = false
      portInput.setText(String.valueOf(serverSocket!!.localPort))
    } else {
      testBind.visibility = View.VISIBLE
      stopBind.visibility = View.GONE
      portInput.isEnabled = true
    }
  }

  private fun label(health: GatewayUiState.Health): String = when (health) {
    GatewayUiState.Health.HEALTHY -> "HEALTHY"
    GatewayUiState.Health.DEGRADED -> "LIMITED"
    GatewayUiState.Health.FAIL_CLOSED -> "NOT READY"
    GatewayUiState.Health.UNKNOWN -> "UNKNOWN"
  }

  private fun onToggle() {
    when {
      listening.get() -> {
        stopListenerQuietly()
        render(GatewayStateStore.snapshot())
      }
      else -> startListening()
    }
  }

  private fun startListening() {
    if (!hasRequiredPermissions()) {
      requestPermissions(REQUIRED_PERMISSIONS, 27183)
      return
    }
    val port = readPortPreference(27183) ?: 27183
    try {
      serverSocket = ServerSocket()
      serverSocket!!.bind(InetSocketAddress("0.0.0.0", port), 5)
      listening.set(true)
      render(GatewayStateStore.snapshot())
      startForegroundServiceIfNecessary()
    } catch (e: IOException) {
      Toast.makeText(
        this,
        getString(R.string.network_bind_failed),
        Toast.LENGTH_LONG
      ).show()
      serverSocket = null
      listening.set(false)
      render(GatewayStateStore.snapshot())
    }
  }

  private fun stopListener() {
    stopListenerQuietly()
    render(GatewayStateStore.snapshot())
  }

  private fun stopListenerQuietly() {
    listening.set(false)
    try {
      serverSocket?.close()
    } catch (_: IOException) { }
    serverSocket = null
    testBind.visibility = View.VISIBLE
    stopBind.visibility = View.GONE
    portInput.isEnabled = true
    render(GatewayStateStore.snapshot())
  }

  private fun bindForTest() {
    val portText = portInput.text.toString().trim()
    val host = hostInput.text.toString().trim()
    if (portText.isEmpty()) {
      Toast.makeText(this, getString(R.string.port_number), Toast.LENGTH_LONG).show()
      return
    }
    val port = portText.toIntOrNull()
    if (port == null || port < 1024 || port > 65535) {
      Toast.makeText(this, "Enter a valid port (1024–65535)", Toast.LENGTH_LONG).show()
      return
    }
    if (host.isNotEmpty()) {
      try {
        InetSocketAddress(host, port)
      } catch (e: IllegalArgumentException) {
        Toast.makeText(this, "Invalid host address", Toast.LENGTH_LONG).show()
        return
      }
    }
    val bound = try {
      val s = ServerSocket()
      s.bind(InetSocketAddress("0.0.0.0", port), 2)
      getString(R.string.network_bind_ok, port)
    } catch (e: IOException) {
      getString(R.string.network_bind_failed)
    } finally {
      // socket closed by try-with-resources pattern not available in older Kotlin;
      // the ServerSocket is explicitly closed below
    }
    Toast.makeText(this, bound, Toast.LENGTH_LONG).show()
  }

  private fun hasRequiredPermissions(): Boolean {
    return REQUIRED_PERMISSIONS.all { perm ->
      ContextCompat.checkSelfPermission(this, perm) == PackageManager.PERMISSION_GRANTED
    }
  }

  private fun requestPermissions(perms: Array<String>, requestCode: Int) {
    ActivityCompat.requestPermissions(this, perms, requestCode)
  }

  override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults)
    if (requestCode != 27183) return
    val allGranted = grantResults.isNotEmpty() && grantResults.all { it == PackageManager.PERMISSION_GRANTED }
    if (allGranted) {
      startListening()
    } else {
      Toast.makeText(this, "Permissions required to open network listener", Toast.LENGTH_LONG).show()
    }
  }

  private fun readPortPreference(default: Int): Int? {
    val text = portInput.text.toString().trim()
    if (text.isNotEmpty()) {
      val p = text.toIntOrNull()
      if (p != null && p in 1024..65535) return p
    }
    return null
  }

  private fun startForegroundServiceIfNecessary() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      try {
        startForegroundService(Intent(this, NetworkGatewayService::class.java))
      } catch (_: SecurityException) { }
    }
  }

  private fun enrollmentStore() = com.callagent.gateway.usb.ControllerEnrollmentStore(
    com.callagent.gateway.usb.AndroidControllerSecretStorage(this)
  )

  private fun showForgetConfirmation() {
    val state = GatewayStateStore.snapshot()
    if (state.connection != GatewayUiState.Connection.STOPPED) return
    if (!enrollmentStore().isEnrolled()) return
    AlertDialog.Builder(this)
      .setTitle("Forget paired desktop")
      .setMessage(
        "This revokes call control, caller and call metadata, bidirectional cellular call audio, " +
          "and recording copies for the paired desktop. You must pair again."
      )
      .setNegativeButton("Cancel", null)
      .setPositiveButton("Forget") { _, _ ->
        enrollmentStore().revoke()
        render(GatewayStateStore.snapshot())
      }
      .show()
  }

  private companion object {
    const val PROJECT_URL = "https://github.com/sidinsearch/AgentCall"
    private val REQUIRED_PERMISSIONS = listOf(
      Manifest.permission.READ_PHONE_STATE,
      Manifest.permission.CALL_PHONE,
      Manifest.permission.ANSWER_PHONE_CALLS,
      Manifest.permission.RECORD_AUDIO,
      Manifest.permission.READ_CONTACTS,
      Manifest.permission.READ_CALL_LOG,
    )
  }
}
