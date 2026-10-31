package com.hermesagent.mobile.phone

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * The phone-control timeline: every Bot action with who did it, in which app, what happened, and
 * small before/after screenshots. Stored only in this app's private storage, capped by count and
 * age. Screens of blocked apps are never captured.
 */
object PhoneAudit {
  private const val MAX_ENTRIES = 300
  private const val MAX_AGE_MS = 14L * 24 * 3600 * 1000
  private const val THUMB_EDGE = 540
  private val lock = Any()

  data class Entry(
    val id: Long,
    val at: Long,
    val bot: String,
    val tool: String,
    val app: String?,
    val appLabel: String?,
    val summary: String,
    val outcome: String,
    val before: Boolean,
    val after: Boolean,
    val count: Int = 1,
  ) {
    fun json(): JSONObject = JSONObject().put("id", id).put("at", at).put("bot", bot).put("tool", tool)
      .put("app", app ?: JSONObject.NULL).put("appLabel", appLabel ?: JSONObject.NULL).put("summary", summary)
      .put("outcome", outcome).put("before", before).put("after", after).put("count", count)

    companion object {
      fun from(json: JSONObject) = Entry(
        json.getLong("id"), json.getLong("at"), json.optString("bot", "Hermes"), json.optString("tool"),
        json.optString("app").ifEmpty { null }.takeIf { !json.isNull("app") },
        json.optString("appLabel").ifEmpty { null }.takeIf { !json.isNull("appLabel") },
        json.optString("summary"), json.optString("outcome", "done"), json.optBoolean("before"), json.optBoolean("after"),
        json.optInt("count", 1),
      )
    }
  }

  private fun dir(context: Context) = File(context.filesDir, "phone-audit").apply { mkdirs() }
  private fun logFile(context: Context) = File(dir(context), "log.jsonl")
  private fun image(context: Context, id: Long, which: String) = File(dir(context), "$id-$which.jpg")

  private fun readAll(context: Context): MutableList<Entry> {
    val file = logFile(context)
    if (!file.exists()) return mutableListOf()
    return file.readLines().mapNotNull { line -> runCatching { Entry.from(JSONObject(line)) }.getOrNull() }.toMutableList()
  }

  private fun writeAll(context: Context, entries: List<Entry>) {
    val file = logFile(context)
    val tmp = File(file.parentFile, "log.jsonl.tmp")
    tmp.writeText(entries.joinToString("\n") { it.json().toString() } + if (entries.isEmpty()) "" else "\n")
    tmp.renameTo(file)
  }

  /**
   * Record one action. Repeated screen reads by the same Bot in the same app within a minute are
   * folded into one row, so the timeline shows actions rather than every look.
   */
  fun record(
    context: Context, bot: String, tool: String, app: String?, appLabel: String?, summary: String, outcome: String,
    before: Bitmap? = null, after: Bitmap? = null,
  ) = synchronized(lock) {
    val now = System.currentTimeMillis()
    val entries = readAll(context)
    val last = entries.lastOrNull()
    if (tool == "phone_screen" && before == null && after == null && last != null && last.tool == tool && last.bot == bot &&
      last.app == app && last.outcome == outcome && now - last.at < 60_000) {
      entries[entries.lastIndex] = last.copy(at = now, count = last.count + 1)
      writeAll(context, entries)
      return@synchronized
    }
    val id = max(now, (last?.id ?: 0) + 1)
    before?.let { save(it, image(context, id, "before")) }
    after?.let { save(it, image(context, id, "after")) }
    entries += Entry(id, now, bot, tool, app, appLabel, summary, outcome, before != null, after != null)
    val keep = entries.filter { now - it.at < MAX_AGE_MS }.takeLast(MAX_ENTRIES)
    (entries - keep.toSet()).forEach { dropped -> image(context, dropped.id, "before").delete(); image(context, dropped.id, "after").delete() }
    writeAll(context, keep)
  }

  /** Newest first. */
  fun list(context: Context, limit: Int = 200): JSONArray = synchronized(lock) {
    JSONArray(readAll(context).takeLast(limit).reversed().map { it.json() })
  }

  /** A thumbnail as a data URL, or null if none was captured. */
  fun imageDataUrl(context: Context, id: Long, which: String): String? {
    if (which != "before" && which != "after") return null
    val file = image(context, id, which)
    if (!file.exists()) return null
    return "data:image/jpeg;base64," + Base64.encodeToString(file.readBytes(), Base64.NO_WRAP)
  }

  fun clear(context: Context) = synchronized(lock) { dir(context).listFiles()?.forEach { it.delete() } }

  private fun save(bitmap: Bitmap, file: File) {
    val scale = THUMB_EDGE.toFloat() / max(bitmap.width, bitmap.height)
    val thumb = if (scale < 1f) Bitmap.createScaledBitmap(bitmap, (bitmap.width * scale).roundToInt(), (bitmap.height * scale).roundToInt(), true) else bitmap
    file.outputStream().use { thumb.compress(Bitmap.CompressFormat.JPEG, 62, it) }
  }

  /** Marks where a tap landed on the before image, so the timeline shows what was pressed. */
  fun markTap(source: Bitmap, x: Float, y: Float): Bitmap {
    val copy = source.copy(Bitmap.Config.ARGB_8888, true)
    val canvas = Canvas(copy)
    val radius = copy.width / 22f
    canvas.drawCircle(x, y, radius, Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.argb(70, 240, 164, 58); style = Paint.Style.FILL })
    canvas.drawCircle(x, y, radius, Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(240, 164, 58); style = Paint.Style.STROKE; strokeWidth = radius / 4 })
    return copy
  }
}
