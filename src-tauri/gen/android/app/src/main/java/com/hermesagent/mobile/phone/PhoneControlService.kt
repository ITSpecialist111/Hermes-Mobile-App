package com.hermesagent.mobile.phone

import android.accessibilityservice.AccessibilityService
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.view.accessibility.AccessibilityEvent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.hermesagent.mobile.R
import java.text.DateFormat
import java.util.Date

/**
 * Lets the user's Hermes Bots operate this phone. Enabled only by the user in Android's
 * Accessibility settings; while enabled it serves the phone tools to Hermes over the LAN and keeps
 * an ongoing notification that names the last action and offers Stop.
 */
class PhoneControlService : AccessibilityService() {

  private var server: PhoneMcpServer? = null
  private val stopReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) { disableSelf() }
  }

  override fun onServiceConnected() {
    super.onServiceConnected()
    instance = this
    ContextCompat.registerReceiver(this, stopReceiver, IntentFilter(ACTION_STOP), ContextCompat.RECEIVER_NOT_EXPORTED)
    server = PhoneMcpServer(this, PhoneControlSettings.PORT, PhoneTools(this)).also { it.start() }
    notify("Ready for Hermes Bots")
  }

  override fun onAccessibilityEvent(event: AccessibilityEvent?) {}
  override fun onInterrupt() {}

  override fun onUnbind(intent: Intent?): Boolean {
    shutdown()
    return super.onUnbind(intent)
  }

  override fun onDestroy() {
    shutdown()
    super.onDestroy()
  }

  private fun shutdown() {
    server?.stop()
    server = null
    if (instance === this) instance = null
    runCatching { unregisterReceiver(stopReceiver) }
    NotificationManagerCompat.from(this).cancel(NOTIFICATION_ID)
  }

  /** Every action the agent takes is named in the notification, so control is never silent. */
  fun noteAction(summary: String) {
    notify("${DateFormat.getTimeInstance(DateFormat.SHORT).format(Date())} · $summary")
  }

  private fun notify(text: String) {
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      manager.createNotificationChannel(NotificationChannel(CHANNEL, "Phone control", NotificationManager.IMPORTANCE_LOW).apply {
        description = "Shown while Hermes Bots can operate this phone"
        setShowBadge(false)
      })
    }
    val stop = PendingIntent.getBroadcast(this, 1, Intent(ACTION_STOP).setPackage(packageName), PendingIntent.FLAG_IMMUTABLE)
    val open = packageManager.getLaunchIntentForPackage(packageName)?.let { PendingIntent.getActivity(this, 2, it, PendingIntent.FLAG_IMMUTABLE) }
    val notification = NotificationCompat.Builder(this, CHANNEL)
      .setSmallIcon(R.drawable.ic_phone_control)
      .setContentTitle(if (PhoneControlSettings.askFirst(this)) "Hermes can control this phone · Ask first" else "Hermes can control this phone · Autopilot")
      .setContentText(text)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setSilent(true)
      .setContentIntent(open)
      .addAction(0, "Stop", stop)
      .build()
    runCatching { NotificationManagerCompat.from(this).notify(NOTIFICATION_ID, notification) }
  }

  companion object {
    @Volatile var instance: PhoneControlService? = null
      private set
    private const val CHANNEL = "hermes-phone-control"
    private const val NOTIFICATION_ID = 7341
    private const val ACTION_STOP = "com.hermesagent.mobile.PHONE_CONTROL_STOP"
  }
}
