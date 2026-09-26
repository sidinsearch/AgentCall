package com.callagent.gateway.dialer

import android.Manifest
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Typeface
import android.media.MediaPlayer
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.SeekBar
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.callagent.gateway.R
import com.callagent.gateway.gsm.GsmCallManager
import com.callagent.gateway.network.NetworkGatewayActivity
import com.callagent.gateway.usb.GatewayStateStore
import com.callagent.gateway.usb.GatewayUiState
import com.callagent.gateway.usb.UsbGatewayActivity
import java.text.DateFormat
import java.util.Date
import java.util.concurrent.Executors
import kotlin.math.roundToInt

class DialerActivity : AppCompatActivity() {
    private lateinit var status: TextView
    private lateinit var panelList: ScrollView
    private lateinit var listContent: LinearLayout
    private lateinit var panelKeypad: ScrollView
    private lateinit var dialNumber: EditText
    private lateinit var tabs: Map<Int, Button>
    private val worker = Executors.newSingleThreadExecutor()
    private var recordingPlayer: MediaPlayer? = null
    private var recordingPlayerUri: Uri? = null
    private var recordingPlayButton: Button? = null
    private var recordingSeekBar: SeekBar? = null
    private var recordingProgress: TextView? = null
    private var pendingRecordingSave: PhoneRecordingMediaStore.PublishedEntry? = null
    private val playbackHandler = Handler(Looper.getMainLooper())
    private val playbackProgress = object : Runnable {
        override fun run() {
            val player = recordingPlayer ?: return
            try {
                recordingSeekBar?.progress = player.currentPosition
                recordingProgress?.text = "${playbackTime(player.currentPosition)} / ${playbackTime(player.duration)}"
                if (player.isPlaying) playbackHandler.postDelayed(this, 250)
            } catch (_: IllegalStateException) {
                stopRecordingPlayback()
            }
        }
    }
    private val saveRecording = registerForActivityResult(
        ActivityResultContracts.CreateDocument(PhoneRecordingMediaStore.MIME_TYPE),
    ) { destination ->
        val entry = pendingRecordingSave
        pendingRecordingSave = null
        if (destination == null || entry == null) return@registerForActivityResult
        worker.execute {
            val saved = try {
                PhoneRecordingMediaStore(this).saveCopy(entry, destination)
                true
            } catch (_: Exception) {
                false
            }
            runOnUiThread {
                Toast.makeText(
                    this,
                    if (saved) "Recording copy saved" else "Recording could not be saved",
                    Toast.LENGTH_LONG,
                ).show()
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_dialer)
        status = findViewById(R.id.tvDialerStatus)
        panelList = findViewById(R.id.panelList)
        listContent = findViewById(R.id.listContent)
        panelKeypad = findViewById(R.id.panelKeypad)
        dialNumber = findViewById(R.id.etDialNumber)
        dialNumber.showSoftInputOnFocus = false
        findViewById<Button>(R.id.btnOpenGateway).setOnClickListener {
            showGatewayModeDialog()
        }
        tabs = listOf(R.id.tabRecents, R.id.tabContacts, R.id.tabKeypad, R.id.tabRecordings)
            .associateWith { findViewById(it) }
        tabs.getValue(R.id.tabRecents).setOnClickListener { showRecents() }
        tabs.getValue(R.id.tabContacts).setOnClickListener { showContacts() }
        tabs.getValue(R.id.tabKeypad).setOnClickListener { showKeypad() }
        tabs.getValue(R.id.tabRecordings).setOnClickListener { showRecordings() }
        KEYPAD.forEach { (id, digit) ->
            findViewById<Button>(id).setOnClickListener { dialNumber.append(digit) }
        }
        findViewById<Button>(R.id.btnDialBackspace).setOnClickListener {
            val value = dialNumber.text
            if (value.isNotEmpty()) value.delete(value.length - 1, value.length)
        }
        findViewById<Button>(R.id.btnPlaceCall).setOnClickListener { placeCall() }
        requestDialerPermissions()
        prefillFromIntent(intent)
        showRecents()
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        setIntent(intent)
        prefillFromIntent(intent)
        showKeypad()
    }

    override fun onResume() {
        super.onResume()
        val gateway = GatewayStateStore.snapshot()
        status.text = when {
            DialerCallStateStore.snapshot().phase !in setOf(DialerCallState.Phase.IDLE, DialerCallState.Phase.ENDED) -> getString(R.string.dialer_status_call_in_progress)
            gateway.recording == GatewayUiState.Health.HEALTHY -> getString(R.string.dialer_status_desktop_recorder_ready)
            gateway.desktopConnected -> getString(R.string.dialer_status_desktop_connected_recording_unavailable)
            else -> getString(R.string.dialer_status_phone_available_gateway_not_ready)
        }
    }

    override fun onDestroy() {
        stopRecordingPlayback()
        worker.shutdownNow()
        super.onDestroy()
    }

    private fun showRecents() {
        selectTab(R.id.tabRecents)
        showListPanel("Loading recent calls…")
        if (!granted(Manifest.permission.READ_CALL_LOG)) {
            showMessage("Call log permission is required to show recent calls.")
            return
        }
        worker.execute {
            val entries = CallHistoryRepository(this).recent(100)
            runOnUiThread {
                listContent.removeAllViews()
                if (entries.isEmpty()) addMessage("No recent calls")
                entries.forEach { addRecentRow(it) }
            }
        }
    }

    private fun showContacts() {
        selectTab(R.id.tabContacts)
        showListPanel("Loading contacts…")
        if (!granted(Manifest.permission.READ_CONTACTS)) {
            showMessage("Contacts permission is required to show saved names.")
            return
        }
        worker.execute {
            val contacts = ContactRepository(this).list(200)
            runOnUiThread {
                listContent.removeAllViews()
                if (contacts.isEmpty()) addMessage("No contacts found")
                contacts.forEach { addContactRow(it) }
            }
        }
    }

    private fun showKeypad() {
        selectTab(R.id.tabKeypad)
        panelList.visibility = View.GONE
        panelKeypad.visibility = View.VISIBLE
        dialNumber.requestFocus()
    }

    private fun showRecordings() {
        selectTab(R.id.tabRecordings)
        showListPanel("Loading phone recordings…")
        worker.execute {
            val recordings = try { PhoneRecordingMediaStore(this).list(100) } catch (_: Exception) { emptyList() }
            runOnUiThread {
                listContent.removeAllViews()
                addRecordingsIntro()
                if (recordings.isEmpty()) addRecordingEmptyState()
                recordings.forEach(::addRecordingRow)
                scrollListToTop()
            }
        }
    }

    private fun addRecordingRow(entry: PhoneRecordingMediaStore.PublishedEntry) {
        val container = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(18), dp(16), dp(18), dp(16))
            background = ContextCompat.getDrawable(this@DialerActivity, R.drawable.card_bg)
            layoutParams = LinearLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT).apply {
                bottomMargin = dp(10)
            }
        }
        container.addView(TextView(this).apply {
            text = "Call recording"
            textSize = 18f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(ContextCompat.getColor(this@DialerActivity, R.color.text_primary))
        })
        container.addView(TextView(this).apply {
            text = "${entry.modifiedLabel} · ${recordingSize(entry.sizeBytes)}"
            textSize = 13f
            setTextColor(ContextCompat.getColor(this@DialerActivity, R.color.text_secondary))
        })
        val progress = TextView(this).apply {
            text = "Ready to play"
            textSize = 12f
            setPadding(0, dp(10), 0, 0)
            setTextColor(ContextCompat.getColor(this@DialerActivity, R.color.text_secondary))
        }
        val seek = SeekBar(this).apply {
            max = 1
            this.progress = 0
            isEnabled = false
            setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
                override fun onProgressChanged(seekBar: SeekBar?, value: Int, fromUser: Boolean) {
                    if (fromUser && recordingPlayerUri == entry.uri) {
                        try {
                            recordingPlayer?.seekTo(value)
                            recordingProgress?.text =
                                "${playbackTime(value)} / ${playbackTime(recordingPlayer?.duration ?: 0)}"
                        } catch (_: IllegalStateException) {}
                    }
                }

                override fun onStartTrackingTouch(seekBar: SeekBar?) = Unit
                override fun onStopTrackingTouch(seekBar: SeekBar?) = Unit
            })
        }
        container.addView(progress)
        container.addView(seek)
        container.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            val play = Button(this@DialerActivity).apply {
                text = "Play"
                isAllCaps = false
                background = ContextCompat.getDrawable(this@DialerActivity, R.drawable.dial_button_bg)
                layoutParams = LinearLayout.LayoutParams(0, dp(48), 1f)
                setOnClickListener { playRecording(entry, this, seek, progress) }
            }
            addView(play)
            addView(Button(this@DialerActivity).apply {
                text = "Save a copy"
                isAllCaps = false
                background = ContextCompat.getDrawable(this@DialerActivity, R.drawable.dial_button_bg)
                layoutParams = LinearLayout.LayoutParams(0, dp(48), 1f).apply { marginStart = dp(8) }
                setOnClickListener {
                    pendingRecordingSave = entry
                    saveRecording.launch(entry.displayName)
                }
            })
        })
        container.addView(Button(this@DialerActivity).apply {
                text = "Delete from phone"
                isAllCaps = false
                background = ContextCompat.getDrawable(this@DialerActivity, R.drawable.danger_outline_bg)
                setTextColor(ContextCompat.getColor(this@DialerActivity, R.color.danger))
                layoutParams = LinearLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT,
                    dp(48),
                ).apply { topMargin = dp(8) }
                setOnClickListener { confirmDeleteRecording(entry) }
        })
        listContent.addView(container)
    }

    private fun playRecording(
        entry: PhoneRecordingMediaStore.PublishedEntry,
        playButton: Button,
        seekBar: SeekBar,
        progress: TextView,
    ) {
        if (recordingPlayerUri == entry.uri) {
            val current = recordingPlayer ?: return
            try {
                if (current.isPlaying) {
                    current.pause()
                    playButton.text = "Resume"
                    playbackHandler.removeCallbacks(playbackProgress)
                } else {
                    current.start()
                    playButton.text = "Pause"
                    playbackHandler.post(playbackProgress)
                }
            } catch (_: IllegalStateException) {
                stopRecordingPlayback()
            }
            return
        }
        stopRecordingPlayback()
        try {
            recordingPlayer = PhoneRecordingMediaStore(this).player(
                entry.uri,
                onCompletion = {
                    resetRecordingPlaybackUi()
                    Toast.makeText(this, "Playback complete", Toast.LENGTH_SHORT).show()
                },
                onError = {
                    resetRecordingPlaybackUi()
                    Toast.makeText(this, "Recording could not be played", Toast.LENGTH_LONG).show()
                },
            )
            recordingPlayerUri = entry.uri
            recordingPlayButton = playButton
            recordingSeekBar = seekBar.apply {
                max = recordingPlayer?.duration?.coerceAtLeast(1) ?: 1
                isEnabled = true
            }
            recordingProgress = progress
            playButton.text = "Pause"
            playbackHandler.post(playbackProgress)
        } catch (_: Exception) {
            stopRecordingPlayback()
            Toast.makeText(this, "Recording could not be played", Toast.LENGTH_LONG).show()
        }
    }

    private fun stopRecordingPlayback() {
        playbackHandler.removeCallbacks(playbackProgress)
        try { recordingPlayer?.release() } catch (_: Exception) {}
        resetRecordingPlaybackUi()
    }

    private fun resetRecordingPlaybackUi() {
        recordingPlayButton?.text = "Play"
        recordingSeekBar?.apply {
            progress = 0
            isEnabled = false
        }
        recordingProgress?.text = "Ready to play"
        recordingPlayer = null
        recordingPlayerUri = null
        recordingPlayButton = null
        recordingSeekBar = null
        recordingProgress = null
    }

    private fun playbackTime(millis: Int): String {
        val totalSeconds = millis.coerceAtLeast(0) / 1000
        return "${totalSeconds / 60}:${(totalSeconds % 60).toString().padStart(2, '0')}"
    }

    private fun recordingSize(bytes: Long): String =
        if (bytes >= 1024 * 1024) {
            String.format("%.1f MB", bytes.toDouble() / (1024 * 1024))
        } else {
            "${(bytes.coerceAtLeast(0) + 1023) / 1024} KB"
        }

    private fun confirmDeleteRecording(entry: PhoneRecordingMediaStore.PublishedEntry) {
        AlertDialog.Builder(this)
            .setTitle("Delete phone copy?")
            .setMessage("The authoritative desktop recording will not be deleted.")
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Delete from phone") { _, _ ->
                worker.execute {
                    val deleted = try { PhoneRecordingMediaStore(this).delete(entry.uri) } catch (_: Exception) { false }
                    runOnUiThread {
                        Toast.makeText(this, if (deleted) "Phone copy deleted" else "Delete failed", Toast.LENGTH_LONG).show()
                        showRecordings()
                    }
                }
            }
            .show()
    }

    private fun showListPanel(message: String) {
        panelKeypad.visibility = View.GONE
        panelList.visibility = View.VISIBLE
        listContent.removeAllViews()
        if (message.isNotEmpty()) addMessage(message)
        scrollListToTop()
    }

    private fun selectTab(selectedId: Int) {
        tabs.forEach { (id, button) ->
            button.isSelected = id == selectedId
            button.contentDescription = if (id == selectedId) "${button.text}, selected" else button.text
        }
    }

    private fun scrollListToTop() {
        panelList.post { panelList.scrollTo(0, 0) }
    }

    private fun showMessage(message: String) {
        listContent.removeAllViews()
        addMessage(message)
    }

    private fun addMessage(message: String) {
        listContent.addView(TextView(this).apply {
            text = message
            textSize = 16f
            setTextColor(ContextCompat.getColor(this@DialerActivity, R.color.text_secondary))
            setPadding(dp(4), dp(10), dp(4), dp(10))
        })
    }

    private fun addRecordingsIntro() {
        listContent.addView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(4), dp(8), dp(4), dp(16))
            addView(TextView(this@DialerActivity).apply {
                text = "Phone recordings"
                textSize = 20f
                setTypeface(typeface, Typeface.BOLD)
                setTextColor(ContextCompat.getColor(this@DialerActivity, R.color.text_primary))
            })
            addView(TextView(this@DialerActivity).apply {
                text = "Verified copies synchronized from the desktop"
                textSize = 14f
                setTextColor(ContextCompat.getColor(this@DialerActivity, R.color.text_secondary))
            })
        })
    }

    private fun addRecordingEmptyState() {
        listContent.addView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = android.view.Gravity.CENTER_HORIZONTAL
            setPadding(dp(22), dp(28), dp(22), dp(28))
            background = ContextCompat.getDrawable(this@DialerActivity, R.drawable.card_bg)
            addView(TextView(this@DialerActivity).apply {
                text = "No recordings yet"
                textSize = 18f
                setTypeface(typeface, Typeface.BOLD)
                gravity = android.view.Gravity.CENTER
                setTextColor(ContextCompat.getColor(this@DialerActivity, R.color.text_primary))
            })
            addView(TextView(this@DialerActivity).apply {
                text = "Completed call recordings synchronized to this phone will appear here."
                textSize = 14f
                gravity = android.view.Gravity.CENTER
                setPadding(0, dp(6), 0, 0)
                setTextColor(ContextCompat.getColor(this@DialerActivity, R.color.text_secondary))
            })
        })
    }

    private fun addRecentRow(entry: CallHistoryEntry) {
        listContent.addView(row(entry.title, entry.number, "${entry.kind.name.lowercase().replaceFirstChar { it.uppercase() }} · ${DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(entry.timestampMillis))} · ${CallHistoryEntry.formatDuration(entry.durationSeconds)}") {
            dialNumber.setText(entry.number)
            showKeypad()
        })
    }

    private fun addContactRow(entry: ContactEntry) {
        listContent.addView(row(entry.name, entry.number, "Saved contact") {
            dialNumber.setText(entry.number)
            showKeypad()
        })
    }

    private fun row(title: String, number: String, detail: String, click: () -> Unit): View {
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(18), dp(16), dp(18), dp(16))
            background = ContextCompat.getDrawable(this@DialerActivity, R.drawable.card_bg)
            val params = LinearLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT)
            params.bottomMargin = dp(10)
            layoutParams = params
            isClickable = true
            isFocusable = true
            setOnClickListener { click() }
            addView(TextView(this@DialerActivity).apply { text = title; textSize = 18f; setTypeface(typeface, Typeface.BOLD); setTextColor(ContextCompat.getColor(this@DialerActivity, R.color.text_primary)) })
            addView(TextView(this@DialerActivity).apply { text = number; textSize = 15f; setTextColor(ContextCompat.getColor(this@DialerActivity, R.color.text_secondary)); setTextIsSelectable(true) })
            addView(TextView(this@DialerActivity).apply { text = detail; textSize = 13f; setTextColor(ContextCompat.getColor(this@DialerActivity, R.color.primary)) })
        }
    }

    private fun placeCall() {
        val destination = DialString.normalize(dialNumber.text.toString())
        if (destination == null) {
            dialNumber.error = "Enter a valid phone number"
            return
        }
        if (!granted(Manifest.permission.CALL_PHONE)) {
            requestDialerPermissions()
            Toast.makeText(this, "Phone permission is required", Toast.LENGTH_LONG).show()
            return
        }
        val gateway = GatewayStateStore.snapshot()
        if (gateway.recording != GatewayUiState.Health.HEALTHY) {
            Toast.makeText(this, "Connect the desktop and confirm recording health before calling", Toast.LENGTH_LONG).show()
            return
        }
        GsmCallManager.makeCall(this, destination)
    }

    private fun prefillFromIntent(intent: Intent?) {
        if (intent?.action != Intent.ACTION_DIAL) return
        val normalized = DialString.normalize(intent.data?.schemeSpecificPart.orEmpty()) ?: return
        dialNumber.setText(normalized)
    }

    private fun requestDialerPermissions() {
        val required = listOf(
            Manifest.permission.READ_PHONE_STATE,
            Manifest.permission.CALL_PHONE,
            Manifest.permission.ANSWER_PHONE_CALLS,
            Manifest.permission.READ_CONTACTS,
            Manifest.permission.READ_CALL_LOG,
            Manifest.permission.RECORD_AUDIO,
        ).filterNot(::granted)
        if (required.isNotEmpty()) ActivityCompat.requestPermissions(this, required.toTypedArray(), REQUEST_PERMISSIONS)
    }

    private fun granted(permission: String): Boolean =
        ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).roundToInt()

    private fun showGatewayModeDialog() {
      AlertDialog.Builder(this)
        .setTitle("Open gateway")
        .setMessage("Choose how the desktop will connect to this phone.")
        .setPositiveButton("USB · Cable") { _, _ ->
          startActivity(Intent(this, UsbGatewayActivity::class.java))
        }
        .setNegativeButton("Network · Wi‑Fi / Internet") { _, _ ->
          startActivity(Intent(this, NetworkGatewayActivity::class.java))
        }
        .setOnCancelListener {
          // User cancelled the dialog; nothing to clean up.
        }
        .show()
    }

    private companion object {
        const val REQUEST_PERMISSIONS = 27184
        val KEYPAD = mapOf(
            R.id.btnDial1 to "1", R.id.btnDial2 to "2", R.id.btnDial3 to "3",
            R.id.btnDial4 to "4", R.id.btnDial5 to "5", R.id.btnDial6 to "6",
            R.id.btnDial7 to "7", R.id.btnDial8 to "8", R.id.btnDial9 to "9",
            R.id.btnDialStar to "*", R.id.btnDial0 to "0", R.id.btnDialHash to "#",
        )
    }
}
