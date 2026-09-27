package com.callagent.gateway.dialer

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import com.callagent.gateway.network.NetworkGatewayActivity
import com.callagent.gateway.usb.UsbGatewayActivity

/** Single gateway entry screen. Mode selection is visible instead of a modal prompt. */
class GatewayActivity : Activity() {
    private val navy = Color.rgb(18, 30, 48)
    private val muted = Color.rgb(92, 105, 122)
    private val accent = Color.rgb(0, 130, 110)

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        setContentView(buildContent())
    }

    private fun buildContent(): View = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(dp(22), dp(30), dp(22), dp(24))
        setBackgroundColor(Color.WHITE)
        addView(TextView(this@GatewayActivity).apply {
            text = "Gateway"
            textSize = 30f
            setTextColor(navy)
            setTypeface(typeface, android.graphics.Typeface.BOLD)
        })
        addView(TextView(this@GatewayActivity).apply {
            text = "Choose how the agent connects to your phone. You can switch modes any time."
            textSize = 16f
            setTextColor(muted)
            setPadding(0, dp(8), 0, dp(24))
        })
        addModeButton(
            title = "USB · Cable",
            detail = "Local ADB connection\nBest for a phone connected to this computer",
            onClick = { startActivity(Intent(this@GatewayActivity, UsbGatewayActivity::class.java)) },
        )
        addModeButton(
            title = "Network · Wi‑Fi / Internet",
            detail = "Tailscale or private LAN connection\nConfigure phone address, port, pairing, and readiness",
            onClick = { startActivity(Intent(this@GatewayActivity, NetworkGatewayActivity::class.java)) },
        )
        addView(TextView(this@GatewayActivity).apply {
            text = "Network mode uses authenticated pairing. Keep the phone endpoint on a private Tailscale or LAN network."
            textSize = 13f
            setTextColor(muted)
            setPadding(0, dp(20), 0, 0)
        })
    }

    private fun LinearLayout.addModeButton(title: String, detail: String, onClick: () -> Unit) {
        addView(Button(this@GatewayActivity).apply {
            text = "$title\n$detail"
            textSize = 15f
            gravity = Gravity.START or Gravity.CENTER_VERTICAL
            setTextColor(navy)
            setAllCaps(false)
            minHeight = dp(92)
            setPadding(dp(18), 0, dp(18), 0)
            setOnClickListener { onClick() }
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                dp(92),
            ).apply { bottomMargin = dp(14) }
        })
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()
}
