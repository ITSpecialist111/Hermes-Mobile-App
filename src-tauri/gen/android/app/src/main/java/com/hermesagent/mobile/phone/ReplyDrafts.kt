package com.hermesagent.mobile.phone

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.RemoteInput
import com.hermesagent.mobile.R
import org.json.JSONObject

/**
 * Reply drafts: a Bot on the Hermes host reads new messages (phone_messages), drafts an answer in
 * the user's voice and proposes it (phone_propose_reply). The phone shows the draft as a
 * notification — on the cover screen too — with Send, Edit and Ignore. Nothing is sent unless the
 * user taps Send or sends an edited reply. Off until the user enables it for specific apps.
 */
object ReplyDrafts {
  private const val PREFS = "hermes-reply-drafts"
  private const val CHANNEL = "hermes-reply-drafts"
  const val ACTION_SEND = "com.hermesagent.mobile.DRAFT_SEND"
  const val ACTION_EDIT = "com.hermesagent.mobile.DRAFT_EDIT"
  const val ACTION_IGNORE = "com.hermesagent.mobile.DRAFT_IGNORE"
  const val EXTRA_ID = "message_id"
  const val EDIT_KEY = "draft_edit"

  private data class Draft(val messageId: Long, val text: String, val bot: String)
  private val drafts = mutableMapOf<Long, Draft>()

  /** Apps whose new messages are offered to the host for drafting. Empty = drafting is off. */
  fun enabledApps(context: Context): Set<String> =
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getStringSet("apps", emptySet()).orEmpty()

  fun setAppEnabled(context: Context, pkg: String, enabled: Boolean) {
    val next = enabledApps(context).toMutableSet().apply { if (enabled) add(pkg) else remove(pkg) }
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putStringSet("apps", next).apply()
  }

  @Volatile var lastIncomingAt = 0L
    private set

  fun onIncoming(context: Context, message: PhoneMessages.Incoming) {
    lastIncomingAt = message.at
  }

  private fun notificationId(messageId: Long) = (9000 + (messageId % 100_000)).toInt()

  fun propose(context: Context, message: PhoneMessages.Incoming, text: String, bot: String) {
    synchronized(drafts) { drafts[message.id] = Draft(message.id, text, bot) }
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      manager.createNotificationChannel(NotificationChannel(CHANNEL, "Reply drafts", NotificationManager.IMPORTANCE_HIGH).apply {
        description = "Replies your Bots drafted. Nothing is sent until you tap Send."
      })
    }
    fun broadcast(action: String, code: Int, mutable: Boolean = false) = PendingIntent.getBroadcast(
      context, notificationId(message.id) * 4 + code,
      Intent(context, DraftActionReceiver::class.java).setAction(action).putExtra(EXTRA_ID, message.id),
      PendingIntent.FLAG_UPDATE_CURRENT or (if (mutable) PendingIntent.FLAG_MUTABLE else PendingIntent.FLAG_IMMUTABLE),
    )
    val editInput = RemoteInput.Builder(EDIT_KEY).setLabel("Edit and send").build()
    val edit = NotificationCompat.Action.Builder(0, "Edit", broadcast(ACTION_EDIT, 1, mutable = true))
      .addRemoteInput(editInput).setAllowGeneratedReplies(false).build()
    val where = if (message.isGroup) " in ${message.conversation}" else ""
    val notification = NotificationCompat.Builder(context, CHANNEL)
      .setSmallIcon(R.drawable.ic_phone_control)
      .setContentTitle("$bot drafted a reply to ${message.sender}$where")
      .setContentText(text)
      .setStyle(NotificationCompat.BigTextStyle().bigText("${message.sender}: ${message.text.take(160)}\n\nReply: $text"))
      .setSubText(message.appLabel)
      .setCategory(NotificationCompat.CATEGORY_MESSAGE)
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setAutoCancel(false)
      .setOnlyAlertOnce(true)
      .addAction(0, "Send", broadcast(ACTION_SEND, 0))
      .addAction(edit)
      .addAction(0, "Ignore", broadcast(ACTION_IGNORE, 2))
      .build()
    runCatching { NotificationManagerCompat.from(context).notify(notificationId(message.id), notification) }
  }

  internal fun handle(context: Context, intent: Intent) {
    val id = intent.getLongExtra(EXTRA_ID, -1)
    val draft = synchronized(drafts) { drafts[id] }
    val message = PhoneMessages.get(id)
    val manager = NotificationManagerCompat.from(context)
    if (intent.action == ACTION_IGNORE || draft == null || message == null) {
      synchronized(drafts) { drafts.remove(id) }
      manager.cancel(notificationId(id))
      if (intent.action == ACTION_IGNORE && message != null && draft != null) {
        PhoneAudit.record(context, draft.bot, "reply_draft", message.pkg, message.appLabel, "you ignored the drafted reply to ${message.sender}", "declined")
      }
      return
    }
    val text = if (intent.action == ACTION_EDIT) RemoteInput.getResultsFromIntent(intent)?.getCharSequence(EDIT_KEY)?.toString()?.trim().orEmpty() else draft.text
    if (text.isEmpty()) return
    val error = PhoneMessages.reply(context, id, text)
    val edited = intent.action == ACTION_EDIT && text != draft.text
    PhoneAudit.record(context, draft.bot, "reply_draft", message.pkg, message.appLabel,
      if (error == null) "sent ${if (edited) "your edited" else "the drafted"} reply to ${message.sender}: \u201c${text.take(120)}\u201d" else "could not send the reply to ${message.sender}: $error",
      if (error == null) "done" else "failed")
    synchronized(drafts) { drafts.remove(id) }
    val result = NotificationCompat.Builder(context, CHANNEL)
      .setSmallIcon(R.drawable.ic_phone_control)
      .setContentTitle(if (error == null) "Sent to ${message.sender}" else "Not sent")
      .setContentText(error ?: text)
      .setSubText(message.appLabel)
      .setSilent(true)
      .build()
    runCatching { manager.notify(notificationId(id), result) }
    if (error == null) Handler(Looper.getMainLooper()).postDelayed({ manager.cancel(notificationId(id)) }, 4000)
  }

  fun status(context: Context): JSONObject = JSONObject()
    .put("access", PhoneMessages.accessGranted(context))
    .put("apps", org.json.JSONArray(enabledApps(context).toList()))
    .put("lastIncomingAt", lastIncomingAt)
}

class DraftActionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val pending = goAsync()
    Thread { try { ReplyDrafts.handle(context.applicationContext, intent) } finally { pending.finish() } }.start()
  }
}
