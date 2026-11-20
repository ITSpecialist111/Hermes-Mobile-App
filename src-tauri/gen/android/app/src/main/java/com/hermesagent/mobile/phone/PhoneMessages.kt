package com.hermesagent.mobile.phone

import android.app.Notification
import android.app.PendingIntent
import android.app.RemoteInput
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.provider.Settings
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import androidx.core.app.NotificationCompat
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicLong

/**
 * Incoming messages, read from messaging apps' notifications (only once the user grants
 * Notification access). Each keeps the conversation's recent lines and the app's own inline-reply
 * action, so a reply can be sent the way the user would from the notification shade — no screen
 * tapping, and it works with the phone locked. Held in memory only; nothing is written to disk.
 */
object PhoneMessages {
  data class Line(val sender: String, val text: String, val at: Long, val fromMe: Boolean)

  class Incoming(
    val id: Long,
    val at: Long,
    val pkg: String,
    val appLabel: String,
    val conversation: String,
    val sender: String,
    val text: String,
    val isGroup: Boolean,
    val history: List<Line>,
    val notificationKey: String,
    val reply: Notification.Action?,
  ) {
    fun json(): JSONObject = JSONObject().put("id", id).put("at", at).put("app", appLabel).put("package", pkg)
      .put("conversation", conversation).put("sender", sender).put("text", text).put("group", isGroup)
      .put("can_reply", reply != null)
      .put("history", JSONArray(history.takeLast(8).map { JSONObject().put("from", if (it.fromMe) "me" else it.sender).put("text", it.text) }))
  }

  private const val MAX_KEPT = 120
  private val nextId = AtomicLong(System.currentTimeMillis() / 1000 * 1000)
  private val messages = ArrayDeque<Incoming>()
  private val seen = LinkedHashSet<String>()

  fun list(sinceId: Long = 0, pkgs: Set<String>? = null): List<Incoming> = synchronized(this) {
    messages.filter { it.id > sinceId && (pkgs == null || it.pkg in pkgs) }
  }

  fun get(id: Long): Incoming? = synchronized(this) { messages.firstOrNull { it.id == id } }

  /** The latest reply action for a conversation (apps refresh it with every notification update). */
  private fun latestFor(message: Incoming): Incoming = synchronized(this) {
    messages.lastOrNull { it.notificationKey == message.notificationKey && it.reply != null } ?: message
  }

  internal fun add(message: Incoming, fingerprint: String): Boolean = synchronized(this) {
    if (!seen.add(fingerprint)) return false
    while (seen.size > 600) seen.remove(seen.first())
    messages.addLast(message)
    while (messages.size > MAX_KEPT) messages.removeFirst()
    true
  }

  fun newId() = nextId.incrementAndGet()

  /** Sends [text] through the app's own reply action. Returns null on success, or why it failed. */
  fun reply(context: Context, id: Long, text: String): String? {
    val message = get(id) ?: return "That message is no longer available on the phone."
    val action = latestFor(message).reply ?: return "${message.appLabel} does not offer a quick reply for this message."
    val inputs = action.remoteInputs?.filter { it.allowFreeFormInput } ?: return "No reply field on this notification."
    if (inputs.isEmpty()) return "No reply field on this notification."
    val intent = Intent().addFlags(Intent.FLAG_RECEIVER_FOREGROUND)
    val results = Bundle().apply { inputs.forEach { putCharSequence(it.resultKey, text) } }
    RemoteInput.addResultsToIntent(inputs.toTypedArray(), intent, results)
    return try {
      action.actionIntent.send(context, 0, intent)
      null
    } catch (_: PendingIntent.CanceledException) {
      "The conversation's notification was dismissed, so the quick reply expired. Open the app to reply."
    }
  }

  fun accessGranted(context: Context): Boolean {
    val component = ComponentName(context, PhoneNotificationListener::class.java).flattenToString()
    return Settings.Secure.getString(context.contentResolver, "enabled_notification_listeners").orEmpty()
      .split(':').any { it.equals(component, ignoreCase = true) }
  }
}

/** Reads messaging notifications into [PhoneMessages] and hands new ones to Reply drafts. */
class PhoneNotificationListener : NotificationListenerService() {

  /** Messages that arrived before the listener was bound (or while the app was updating) still count. */
  override fun onListenerConnected() {
    super.onListenerConnected()
    runCatching { activeNotifications?.forEach { onNotificationPosted(it) } }
      .onFailure { android.util.Log.w(TAG, "could not read active notifications", it) }
  }

  override fun onNotificationPosted(sbn: StatusBarNotification) {
    runCatching { capture(sbn) }.onFailure { android.util.Log.w(TAG, "could not read a notification from ${sbn.packageName}", it) }
  }

  private fun capture(sbn: StatusBarNotification) {
    if (sbn.packageName == packageName) return
    val notification = sbn.notification ?: return
    if (notification.flags and Notification.FLAG_GROUP_SUMMARY != 0) return
    if (sbn.packageName !in PhonePolicy.MESSAGING_PACKAGES && NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(notification) == null) return
    if (PhonePolicy.effective(this, sbn.packageName) == PhonePolicy.Mode.BLOCK) return

    val appLabel = runCatching { packageManager.getApplicationLabel(packageManager.getApplicationInfo(sbn.packageName, 0)).toString() }.getOrDefault(sbn.packageName)
    val reply = notification.actions?.firstOrNull { action ->
      action.remoteInputs?.any { it.allowFreeFormInput } == true &&
        (action.semanticAction == Notification.Action.SEMANTIC_ACTION_REPLY || action.title?.toString()?.contains("reply", ignoreCase = true) == true)
    } ?: notification.actions?.firstOrNull { action -> action.remoteInputs?.any { it.allowFreeFormInput } == true }

    val style = NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(notification)
    val extras = notification.extras
    val lines = style?.messages?.mapNotNull { message ->
      val text = message.text?.toString()?.trim().orEmpty()
      if (text.isEmpty()) null else {
        val person = message.person
        Line(person?.name?.toString() ?: style.user.name?.toString() ?: "Me", text, message.timestamp, fromMe = person == null)
      }
    }.orEmpty()
    val latest = lines.lastOrNull { !it.fromMe }
    val sender = latest?.sender ?: extras.getCharSequence(Notification.EXTRA_TITLE)?.toString() ?: return
    val text = latest?.text ?: extras.getCharSequence(Notification.EXTRA_TEXT)?.toString()?.trim() ?: return
    if (text.isEmpty()) return
    val conversation = style?.conversationTitle?.toString() ?: extras.getCharSequence(Notification.EXTRA_CONVERSATION_TITLE)?.toString() ?: sender
    val isGroup = style?.isGroupConversation ?: false
    val at = latest?.at ?: sbn.postTime
    val history = lines.ifEmpty { listOf(Line(sender, text, at, false)) }
    val message = PhoneMessages.Incoming(PhoneMessages.newId(), at, sbn.packageName, appLabel, conversation, sender, text, isGroup, history, sbn.key, reply)
    val added = PhoneMessages.add(message, "${sbn.packageName}|$conversation|$sender|$at|${text.hashCode()}")
    android.util.Log.d(TAG, "${sbn.packageName}: message from $sender (reply=${reply != null}, new=$added)")
    if (added) ReplyDrafts.onIncoming(this, message)
  }

  private fun Line(sender: String, text: String, at: Long, fromMe: Boolean) = PhoneMessages.Line(sender, text, at, fromMe)

  private companion object { const val TAG = "PhoneMessages" }
}
