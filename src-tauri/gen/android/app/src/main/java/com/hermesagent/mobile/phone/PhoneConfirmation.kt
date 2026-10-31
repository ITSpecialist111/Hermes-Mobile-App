package com.hermesagent.mobile.phone

import android.accessibilityservice.AccessibilityService
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.view.accessibility.AccessibilityWindowInfo
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * "Ask first": an on-screen Allow/Deny card shown before a Bot performs a risky action.
 *
 * The card is an accessibility overlay owned by this app, so it never appears in the element
 * list the Bot reads, and the caller holds the tool lock while waiting, so the Bot cannot tap
 * anything (including the card) until the user answers. No answer within the timeout is a Deny.
 */
object PhoneConfirmation {
  private val RISKY = Regex(
    "\\b(send|post|publish|share|tweet|retweet|repost|reply all|forward|pay|payment|buy|purchase|order|checkout|check out|" +
      "confirm|delete|remove|uninstall|erase|clear all|transfer|submit|subscribe|unsubscribe|book|call|dial|install|" +
      "sign out|log out|logout|block|report|accept|archive|discard)\\b",
    RegexOption.IGNORE_CASE,
  )

  fun isRisky(label: String): Boolean = RISKY.containsMatchIn(label)

  fun ask(service: AccessibilityService, title: String, detail: String, timeoutMs: Long = 60_000): Boolean {
    val main = Handler(Looper.getMainLooper())
    val windowManager = service.getSystemService(WindowManager::class.java)
    val answered = CountDownLatch(1)
    val allowed = AtomicBoolean(false)
    var card: View? = null
    main.post {
      card = build(service, title, detail,
        onAllow = { allowed.set(true); answered.countDown() },
        onDeny = { answered.countDown() })
      val params = WindowManager.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.WRAP_CONTENT,
        WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
        // Not focusable: the app underneath keeps window focus, otherwise it may ignore the click we perform after Allow.
        WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
        PixelFormat.TRANSLUCENT,
      ).apply { gravity = Gravity.BOTTOM }
      runCatching { windowManager.addView(card, params) }.onFailure {
        Log.w(TAG, "Could not show the confirmation card", it)
        answered.countDown()
      }
    }
    answered.await(timeoutMs, TimeUnit.MILLISECONDS)
    val removed = CountDownLatch(1)
    main.post {
      card?.let { runCatching { windowManager.removeViewImmediate(it) } }
      removed.countDown()
    }
    removed.await(2, TimeUnit.SECONDS)
    if (allowed.get()) {
      // The action that follows is a real touch, so wait until the card has left the window list.
      val deadline = System.currentTimeMillis() + 1500
      while (System.currentTimeMillis() < deadline &&
        service.windows.any { it.type == AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY && it.root?.packageName == service.packageName }) {
        Thread.sleep(50)
      }
      Thread.sleep(SETTLE_MS)
    }
    return allowed.get()
  }

  private const val TAG = "PhoneConfirmation"
  private const val SETTLE_MS = 300L

  private fun build(service: AccessibilityService, title: String, detail: String, onAllow: () -> Unit, onDeny: () -> Unit): View {
    fun dp(value: Int) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value.toFloat(), service.resources.displayMetrics).toInt()
    val card = LinearLayout(service).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(dp(20), dp(18), dp(20), dp(14))
      background = GradientDrawable().apply { setColor(Color.parseColor("#F2181A20")); cornerRadius = dp(22).toFloat(); setStroke(dp(1), Color.parseColor("#F0A43A")) }
    }
    card.addView(TextView(service).apply {
      text = title; setTextColor(Color.WHITE); setTypeface(typeface, Typeface.BOLD); setTextSize(TypedValue.COMPLEX_UNIT_SP, 17f)
    })
    if (detail.isNotBlank()) card.addView(TextView(service).apply {
      text = detail; setTextColor(Color.parseColor("#D0D3DC")); setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f); setPadding(0, dp(6), 0, 0)
    })
    card.addView(TextView(service).apply {
      text = "Turn off \u201cAsk first\u201d in Hermes Mobile \u2192 Settings \u2192 Phone control for autopilot."
      setTextColor(Color.parseColor("#8A8FA0")); setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f); setPadding(0, dp(8), 0, 0)
    })
    val row = LinearLayout(service).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.END; setPadding(0, dp(12), 0, 0) }
    var settled = false
    row.addView(Button(service).apply { text = "Deny"; setOnClickListener { if (!settled) { settled = true; onDeny() } } })
    row.addView(Button(service).apply { text = "Allow"; setOnClickListener { if (!settled) { settled = true; onAllow() } } })
    card.addView(row)
    return LinearLayout(service).apply {
      setPadding(dp(14), 0, dp(14), dp(28))
      addView(card, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    }
  }
}
