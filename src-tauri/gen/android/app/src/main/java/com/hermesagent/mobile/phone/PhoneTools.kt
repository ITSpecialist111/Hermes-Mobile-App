package com.hermesagent.mobile.phone

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Path
import android.graphics.Rect
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.view.Display
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * The phone's tool surface for Hermes: read the screen as numbered UI elements (plus an optional
 * screenshot) and act on it through the accessibility service — taps, typing, swipes, system
 * keys, launching apps and opening links. Actions return the refreshed element list so the agent
 * can see the result without an extra round trip.
 */
class PhoneTools(private val service: PhoneControlService) {

  private data class Element(val node: AccessibilityNodeInfo, val bounds: Rect)

  private val lock = Any()
  private val main = Handler(Looper.getMainLooper())
  @Volatile private var elements: List<Element> = emptyList()

  fun definitions(): JSONArray = JSONArray()
    .put(tool("phone_screen", "Read the phone screen: the foreground app, numbered interactive elements (text, role, position) and, by default, a screenshot. Call this first and after anything that changes the screen.",
      props("screenshot" to prop("boolean", "Include a screenshot image (default true). Set false for a faster text-only read."))))
    .put(tool("phone_tap", "Tap an element by its number from the latest phone_screen, or tap screen coordinates in pixels. Use long_press for context menus.",
      props("element" to prop("integer", "Element number from phone_screen."), "x" to prop("integer", "Screen x in pixels (if no element)."), "y" to prop("integer", "Screen y in pixels (if no element)."), "long_press" to prop("boolean", "Press and hold instead of tap."))))
    .put(tool("phone_type", "Type text into a text field: the given element, or the field that currently has focus. Replaces the field's text unless append is true. Password fields are refused.",
      props("text" to prop("string", "Text to enter."), "element" to prop("integer", "Element number of the text field (optional)."), "append" to prop("boolean", "Append to the existing text instead of replacing it."), "submit" to prop("boolean", "Press the keyboard's enter/search/send action afterwards.")), listOf("text")))
    .put(tool("phone_swipe", "Scroll or swipe. Give a direction (the content moves the other way, like a finger: 'up' scrolls down a list), optionally within an element; or give exact pixel coordinates.",
      props("direction" to propEnum("Finger direction.", "up", "down", "left", "right"), "element" to prop("integer", "Scrollable element to swipe within (optional)."), "x1" to prop("integer", "Start x"), "y1" to prop("integer", "Start y"), "x2" to prop("integer", "End x"), "y2" to prop("integer", "End y"))))
    .put(tool("phone_key", "Press a system key or open a system panel.",
      props("key" to propEnum("Which key.", "back", "home", "recents", "notifications", "quick_settings")), listOf("key")))
    .put(tool("phone_open_app", "Launch an installed app by its name (e.g. 'Chrome', 'WhatsApp') or package name.",
      props("name" to prop("string", "App name or package.")), listOf("name")))
    .put(tool("phone_list_apps", "List launchable apps installed on the phone.",
      props("filter" to prop("string", "Optional case-insensitive filter on name or package."))))
    .put(tool("phone_open_url", "Open an http(s) link in the phone's default browser or the app that handles it.",
      props("url" to prop("string", "The http or https URL.")), listOf("url")))
    .put(tool("phone_wait", "Wait for the screen to settle (page loads, animations), then return the element list.",
      props("seconds" to prop("number", "Seconds to wait, 0.5 to 10 (default 2)."))))

  fun call(name: String, args: JSONObject): JSONObject = synchronized(lock) {
    try {
      when (name) {
        "phone_screen" -> screen(args.optBoolean("screenshot", true))
        "phone_tap" -> tap(args)
        "phone_type" -> type(args)
        "phone_swipe" -> swipe(args)
        "phone_key" -> key(args.optString("key"))
        "phone_open_app" -> openApp(args.optString("name"))
        "phone_list_apps" -> text(listApps(args.optString("filter")))
        "phone_open_url" -> openUrl(args.optString("url"))
        "phone_wait" -> { Thread.sleep((args.optDouble("seconds", 2.0).coerceIn(0.5, 10.0) * 1000).toLong()); text(describe()) }
        else -> failure("Unknown tool: $name")
      }
    } catch (error: Exception) {
      failure(error.message ?: error.toString())
    }
  }

  // ── reading the screen ─────────────────────────────────────────────────────

  private fun screen(withScreenshot: Boolean): JSONObject {
    val content = JSONArray().put(JSONObject().put("type", "text").put("text", describe()))
    if (withScreenshot) {
      screenshotJpeg()?.let { content.put(JSONObject().put("type", "image").put("mimeType", "image/jpeg").put("data", it)) }
        ?: content.put(JSONObject().put("type", "text").put("text", "(Screenshot unavailable on this screen — use the element list.)"))
    }
    service.noteAction("read the screen")
    return JSONObject().put("content", content).put("isError", false)
  }

  /** Numbered list of the elements an agent can act on, across the visible app and keyboard windows. */
  private fun describe(): String {
    val collected = mutableListOf<Element>()
    val roots = windowRoots()
    val lines = StringBuilder()
    val metrics = service.resources.displayMetrics
    val app = service.rootInActiveWindow?.packageName ?: "unknown"
    lines.append("Foreground app: $app · screen ${metrics.widthPixels}x${metrics.heightPixels} px\n")
    for ((label, root) in roots) {
      lines.append("— $label —\n")
      walk(root, collected, lines)
    }
    if (collected.isEmpty()) lines.append("(no interactive elements visible)\n")
    elements = collected
    return lines.toString().trimEnd()
  }

  private fun windowRoots(): List<Pair<String, AccessibilityNodeInfo>> {
    val result = mutableListOf<Pair<String, AccessibilityNodeInfo>>()
    val windows = runCatching { service.windows }.getOrDefault(emptyList())
    for (window in windows.sortedByDescending { it.layer }) {
      val root = window.root ?: continue
      val label = when (window.type) {
        AccessibilityWindowInfo.TYPE_APPLICATION -> "app ${root.packageName}"
        AccessibilityWindowInfo.TYPE_INPUT_METHOD -> "keyboard"
        AccessibilityWindowInfo.TYPE_SYSTEM -> "system ${root.packageName}"
        else -> continue
      }
      // The Hermes app's own window is not something the agent should drive.
      if (root.packageName == service.packageName) continue
      result += label to root
    }
    if (result.isEmpty()) service.rootInActiveWindow?.takeIf { it.packageName != service.packageName }?.let { result += "app ${it.packageName}" to it }
    return result
  }

  private fun walk(node: AccessibilityNodeInfo, out: MutableList<Element>, lines: StringBuilder, depth: Int = 0) {
    if (out.size >= MAX_ELEMENTS || depth > 60) return
    if (!node.isVisibleToUser) return
    val text = node.text?.toString()?.trim().orEmpty()
    val desc = node.contentDescription?.toString()?.trim().orEmpty()
    val hint = if (Build.VERSION.SDK_INT >= 26) node.hintText?.toString()?.trim().orEmpty() else ""
    val actionable = node.isClickable || node.isLongClickable || node.isEditable || node.isScrollable || node.isCheckable
    if (actionable || text.isNotEmpty() || desc.isNotEmpty()) {
      val bounds = Rect().also { node.getBoundsInScreen(it) }
      if (bounds.width() > 0 && bounds.height() > 0) {
        val index = out.size
        out += Element(node, bounds)
        val role = node.className?.toString()?.substringAfterLast('.') ?: "View"
        val label = listOf(text, desc, if (text.isEmpty() && desc.isEmpty()) hint else "").filter { it.isNotEmpty() }.joinToString(" | ").replace('\n', ' ').take(90)
        val flags = buildList {
          if (node.isClickable) add("tap")
          if (node.isLongClickable) add("hold")
          if (node.isEditable) add(if (node.isPassword) "password-field" else "text-field")
          if (node.isScrollable) add("scroll")
          if (node.isCheckable) add(if (node.isChecked) "checked" else "unchecked")
          if (node.isFocused) add("focused")
          if (!node.isEnabled) add("disabled")
        }.joinToString(",")
        lines.append("[$index] $role \"$label\" @(${bounds.centerX()},${bounds.centerY()})${if (flags.isNotEmpty()) " $flags" else ""}\n")
      }
    }
    for (i in 0 until node.childCount) node.getChild(i)?.let { walk(it, out, lines, depth + 1) }
  }

  private fun screenshotJpeg(): String? {
    if (Build.VERSION.SDK_INT < 30) return null
    val latch = CountDownLatch(1)
    var bitmap: Bitmap? = null
    service.takeScreenshot(Display.DEFAULT_DISPLAY, service.mainExecutor, object : AccessibilityService.TakeScreenshotCallback {
      override fun onSuccess(result: AccessibilityService.ScreenshotResult) {
        val buffer = result.hardwareBuffer
        bitmap = Bitmap.wrapHardwareBuffer(buffer, result.colorSpace)?.copy(Bitmap.Config.ARGB_8888, false)
        buffer.close()
        latch.countDown()
      }
      override fun onFailure(errorCode: Int) { latch.countDown() }
    })
    latch.await(5, TimeUnit.SECONDS)
    val full = bitmap ?: return null
    // Keep the image small enough for a vision model: longest side ~1000 px.
    val scale = 1000f / max(full.width, full.height)
    val scaled = if (scale < 1f) Bitmap.createScaledBitmap(full, (full.width * scale).roundToInt(), (full.height * scale).roundToInt(), true) else full
    val stream = ByteArrayOutputStream()
    scaled.compress(Bitmap.CompressFormat.JPEG, 60, stream)
    return Base64.encodeToString(stream.toByteArray(), Base64.NO_WRAP)
  }

  // ── acting on it ───────────────────────────────────────────────────────────

  private fun element(args: JSONObject): Element? {
    if (!args.has("element") || args.isNull("element")) return null
    val index = args.getInt("element")
    return elements.getOrNull(index) ?: throw IllegalArgumentException("Element $index is not on the latest screen; call phone_screen again.")
  }

  private fun tap(args: JSONObject): JSONObject {
    val longPress = args.optBoolean("long_press", false)
    val target = element(args)
    val label: String
    if (target != null) {
      target.node.refresh()
      val action = if (longPress) AccessibilityNodeInfo.ACTION_LONG_CLICK else AccessibilityNodeInfo.ACTION_CLICK
      val clickable = clickableAncestor(target.node, longPress)
      val done = clickable?.performAction(action) == true
      if (!done) gestureTap(target.bounds.centerX().toFloat(), target.bounds.centerY().toFloat(), longPress)
      label = "${if (longPress) "held" else "tapped"} element ${args.getInt("element")}"
    } else {
      if (!args.has("x") || !args.has("y")) throw IllegalArgumentException("Give an element number or x and y.")
      gestureTap(args.getInt("x").toFloat(), args.getInt("y").toFloat(), longPress)
      label = "${if (longPress) "held" else "tapped"} (${args.getInt("x")},${args.getInt("y")})"
    }
    return acted(label)
  }

  private fun clickableAncestor(node: AccessibilityNodeInfo, longPress: Boolean): AccessibilityNodeInfo? {
    var current: AccessibilityNodeInfo? = node
    var hops = 0
    while (current != null && hops < 6) {
      if (if (longPress) current.isLongClickable else current.isClickable) return current
      current = current.parent
      hops++
    }
    return null
  }

  private fun type(args: JSONObject): JSONObject {
    val text = args.getString("text")
    val node = element(args)?.node?.also { it.refresh() }
      ?: service.rootInActiveWindow?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
      ?: throw IllegalArgumentException("No text field has focus; tap one first or pass its element number.")
    if (node.isPassword) throw IllegalArgumentException("Typing into password fields is not allowed. Ask the user to enter it.")
    if (!node.isEditable) throw IllegalArgumentException("That element is not a text field.")
    if (!node.isFocused) node.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
    val existing = if (args.optBoolean("append", false)) node.text?.toString().orEmpty() else ""
    val ok = node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, Bundle().apply {
      putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, existing + text)
    })
    if (!ok) throw IllegalStateException("The field did not accept the text.")
    var submitted = ""
    if (args.optBoolean("submit", false)) {
      Thread.sleep(250)
      submitted = if (Build.VERSION.SDK_INT >= 30 && node.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.id)) " and submitted" else " (submit not supported here — tap the send/search button)"
    }
    return acted("typed ${text.length} characters$submitted")
  }

  private fun swipe(args: JSONObject): JSONObject {
    val metrics = service.resources.displayMetrics
    val area = element(args)?.bounds ?: Rect(0, 0, metrics.widthPixels, metrics.heightPixels)
    val (x1, y1, x2, y2) = if (args.has("x1") && args.has("y1") && args.has("x2") && args.has("y2")) {
      listOf(args.getInt("x1"), args.getInt("y1"), args.getInt("x2"), args.getInt("y2")).map { it.toFloat() }
    } else {
      val cx = area.exactCenterX(); val cy = area.exactCenterY()
      val dx = area.width() * 0.35f; val dy = area.height() * 0.35f
      when (args.optString("direction", "up")) {
        "up" -> listOf(cx, cy + dy, cx, cy - dy)
        "down" -> listOf(cx, cy - dy, cx, cy + dy)
        "left" -> listOf(cx + dx, cy, cx - dx, cy)
        "right" -> listOf(cx - dx, cy, cx + dx, cy)
        else -> throw IllegalArgumentException("direction must be up, down, left or right")
      }
    }
    gesture(Path().apply { moveTo(x1, y1); lineTo(x2, y2) }, 350)
    return acted("swiped ${args.optString("direction", "custom")}")
  }

  private fun key(key: String): JSONObject {
    val action = when (key) {
      "back" -> AccessibilityService.GLOBAL_ACTION_BACK
      "home" -> AccessibilityService.GLOBAL_ACTION_HOME
      "recents" -> AccessibilityService.GLOBAL_ACTION_RECENTS
      "notifications" -> AccessibilityService.GLOBAL_ACTION_NOTIFICATIONS
      "quick_settings" -> AccessibilityService.GLOBAL_ACTION_QUICK_SETTINGS
      else -> throw IllegalArgumentException("key must be back, home, recents, notifications or quick_settings")
    }
    if (!service.performGlobalAction(action)) throw IllegalStateException("The phone refused the $key key.")
    return acted("pressed $key")
  }

  private fun launchables() = service.packageManager.queryIntentActivities(
    Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER), PackageManager.MATCH_ALL
  ).map { it.loadLabel(service.packageManager).toString() to it.activityInfo.packageName }.distinctBy { it.second }

  private fun listApps(filter: String): String {
    val apps = launchables().filter { filter.isEmpty() || it.first.contains(filter, true) || it.second.contains(filter, true) }.sortedBy { it.first.lowercase() }
    return if (apps.isEmpty()) "No launchable apps match \"$filter\"." else apps.joinToString("\n") { "${it.first} (${it.second})" }
  }

  private fun openApp(name: String): JSONObject {
    if (name.isBlank()) throw IllegalArgumentException("Give an app name or package.")
    val apps = launchables()
    val match = apps.firstOrNull { it.second.equals(name, true) }
      ?: apps.firstOrNull { it.first.equals(name, true) }
      ?: apps.firstOrNull { it.first.contains(name, true) }
      ?: throw IllegalArgumentException("No installed app matches \"$name\". Use phone_list_apps.")
    val intent = service.packageManager.getLaunchIntentForPackage(match.second)
      ?: throw IllegalStateException("${match.first} cannot be launched.")
    service.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED))
    Thread.sleep(1200)
    return acted("opened ${match.first}")
  }

  private fun openUrl(url: String): JSONObject {
    val uri = Uri.parse(url.trim())
    if (uri.scheme != "http" && uri.scheme != "https") throw IllegalArgumentException("Only http and https links can be opened.")
    service.startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    Thread.sleep(1500)
    return acted("opened ${uri.host}")
  }

  private fun gestureTap(x: Float, y: Float, longPress: Boolean) =
    gesture(Path().apply { moveTo(x, y) }, if (longPress) 700 else 60)

  private fun gesture(path: Path, durationMs: Long) {
    val latch = CountDownLatch(1)
    var completed = false
    val description = GestureDescription.Builder().addStroke(GestureDescription.StrokeDescription(path, 0, durationMs)).build()
    main.post {
      val accepted = service.dispatchGesture(description, object : AccessibilityService.GestureResultCallback() {
        override fun onCompleted(gestureDescription: GestureDescription?) { completed = true; latch.countDown() }
        override fun onCancelled(gestureDescription: GestureDescription?) { latch.countDown() }
      }, null)
      if (!accepted) latch.countDown()
    }
    latch.await(durationMs + 3000, TimeUnit.MILLISECONDS)
    if (!completed) throw IllegalStateException("The gesture was cancelled by the system.")
  }

  /** Every action reports what changed: a short settle, then the refreshed element list. */
  private fun acted(summary: String): JSONObject {
    service.noteAction(summary)
    Thread.sleep(700)
    return text("Done: $summary.\n\n${describe()}")
  }

  // ── JSON helpers ───────────────────────────────────────────────────────────

  private fun text(value: String) = JSONObject()
    .put("content", JSONArray().put(JSONObject().put("type", "text").put("text", value)))
    .put("isError", false)

  private fun failure(message: String) = JSONObject()
    .put("content", JSONArray().put(JSONObject().put("type", "text").put("text", message)))
    .put("isError", true)

  private fun tool(name: String, description: String, properties: JSONObject, required: List<String> = emptyList()) = JSONObject()
    .put("name", name).put("description", description)
    .put("inputSchema", JSONObject().put("type", "object").put("properties", properties).put("required", JSONArray(required)))

  private fun props(vararg entries: Pair<String, JSONObject>) = JSONObject().apply { entries.forEach { put(it.first, it.second) } }
  private fun prop(type: String, description: String) = JSONObject().put("type", type).put("description", description)
  private fun propEnum(description: String, vararg values: String) = prop("string", description).put("enum", JSONArray(values.toList()))

  companion object {
    private const val MAX_ELEMENTS = 160
    const val INSTRUCTIONS = "Tools to operate the user's Android phone (a Galaxy Z Fold7). Start with phone_screen, act by element number, " +
      "and read the refreshed element list each action returns. Coordinates are screen pixels. Never type passwords, never send " +
      "messages, payments or posts without the user's explicit confirmation in chat, and stop if a screen asks for credentials."
  }
}
