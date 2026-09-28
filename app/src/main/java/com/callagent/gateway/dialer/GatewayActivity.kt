package com.callagent.gateway.dialer

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import com.callagent.gateway.network.NetworkGatewayActivity
import com.callagent.gateway.usb.UsbGatewayActivity

/** Branded gateway entry screen with the same card and colour language as the dialer. */
class GatewayActivity : Activity() {
    private val background = Color.rgb(249, 250, 251)
    private val surface = Color.WHITE
    private val primary = Color.rgb(15, 118, 110)
    private val primaryDark = Color.rgb(19, 78, 74)
    private val primarySoft = Color.rgb(227, 245, 242)
    private val text = Color.rgb(17, 24, 39)
    private val label = Color.rgb(55, 65, 81)
    private val muted = Color.rgb(107, 114, 128)
    private val border = Color.rgb(229, 231, 235)

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        window.statusBarColor = surface
        setContentView(buildContent())
    }

    private fun buildContent(): View = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setBackgroundColor(background)
        setPadding(dp(20), dp(16), dp(20), dp(24))

        addView(LinearLayout(this@GatewayActivity).apply {
            gravity = Gravity.CENTER_VERTICAL
            addView(TextView(this@GatewayActivity).apply {
                text = "‹"
                textSize = 34f
                setTextColor(primaryDark)
                gravity = Gravity.CENTER
                setOnClickListener { finish() }
                layoutParams = LinearLayout.LayoutParams(dp(42), dp(50))
            })
            addView(TextView(this@GatewayActivity).apply {
                text = "Gateway"
                textSize = 22f
                setTypeface(typeface, Typeface.BOLD)
                setTextColor(text)
                layoutParams = LinearLayout.LayoutParams(0, dp(50), 1f)
            })
            addView(TextView(this@GatewayActivity).apply {
                text = "CONNECTION"
                textSize = 11f
                letterSpacing = 0.08f
                setTypeface(typeface, Typeface.BOLD)
                setTextColor(primary)
                gravity = Gravity.CENTER_VERTICAL
            })
        })

        addView(TextView(this@GatewayActivity).apply {
            text = "Choose a connection mode"
            textSize = 28f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(primaryDark)
            setPadding(dp(2), dp(18), 0, dp(4))
        })
        addView(TextView(this@GatewayActivity).apply {
            text = "Connect AgentCall to your phone over a cable or a secure private network."
            textSize = 15f
            setTextColor(muted)
            setPadding(dp(2), 0, 0, dp(22))
        })

        addModeCard(
            icon = "⌁",
            eyebrow = "FASTEST SETUP",
            title = "USB connection",
            detail = "Use a cable and Android debugging for a reliable local connection.",
            action = "Use USB",
            onClick = { startActivity(Intent(this@GatewayActivity, UsbGatewayActivity::class.java)) },
        )
        addModeCard(
            icon = "◉",
            eyebrow = "WIRELESS",
            title = "Network connection",
            detail = "Use Tailscale or a private LAN with authenticated pairing.",
            action = "Use network",
            onClick = { startActivity(Intent(this@GatewayActivity, NetworkGatewayActivity::class.java)) },
        )

        addView(TextView(this@GatewayActivity).apply {
            text = "SECURE BY DEFAULT\nNetwork mode keeps the phone endpoint private and requires pairing before any call action."
            textSize = 12f
            setLineSpacing(2f, 1f)
            setTextColor(muted)
            setPadding(dp(4), dp(20), dp(4), 0)
        })
    }

    private fun LinearLayout.addModeCard(
        icon: String,
        eyebrow: String,
        title: String,
        detail: String,
        action: String,
        onClick: () -> Unit,
    ) {
        val card = LinearLayout(this@GatewayActivity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(18), dp(16), dp(18), dp(16))
            background = rounded(surface, dp(14), border)
            isClickable = true
            setOnClickListener { onClick() }
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply { bottomMargin = dp(12) }
        }
        card.addView(LinearLayout(this@GatewayActivity).apply {
            gravity = Gravity.CENTER_VERTICAL
            val badge = TextView(this@GatewayActivity).apply {
                text = icon
                textSize = 24f
                gravity = Gravity.CENTER
                setTextColor(primaryDark)
                background = rounded(primarySoft, dp(12), Color.TRANSPARENT)
                layoutParams = LinearLayout.LayoutParams(dp(48), dp(48))
            }
            addView(badge)
            addView(LinearLayout(this@GatewayActivity).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(14), 0, 0, 0)
                addView(TextView(this@GatewayActivity).apply {
                    text = eyebrow
                    textSize = 10f
                    letterSpacing = 0.08f
                    setTypeface(typeface, Typeface.BOLD)
                    setTextColor(primary)
                })
                addView(TextView(this@GatewayActivity).apply {
                    text = title
                    textSize = 19f
                    setTypeface(typeface, Typeface.BOLD)
                    setTextColor(text)
                    setPadding(0, dp(2), 0, 0)
                })
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
            })
        })
        card.addView(TextView(this@GatewayActivity).apply {
            text = detail
            textSize = 14f
            setTextColor(label)
            setLineSpacing(2f, 1f)
            setPadding(dp(2), dp(14), dp(2), dp(14))
        })
        card.addView(TextView(this@GatewayActivity).apply {
            text = "$action   →"
            textSize = 14f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(primaryDark)
            gravity = Gravity.CENTER_VERTICAL
            background = rounded(primarySoft, dp(10), Color.TRANSPARENT)
            setPadding(dp(14), 0, dp(14), 0)
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(44))
        })
        addView(card)
    }

    private fun rounded(fill: Int, radius: Int, stroke: Int): GradientDrawable =
        GradientDrawable().apply {
            setColor(fill)
            cornerRadius = radius.toFloat()
            if (stroke != Color.TRANSPARENT) setStroke(dp(1), stroke)
        }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()
}
