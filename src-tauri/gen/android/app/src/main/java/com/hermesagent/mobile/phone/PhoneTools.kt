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
    .put(tool("phone_open_app", "Launch an installed app by its name (e.g. 'Chrome', 'WhatsApp', 'Amazon') or package name. Prefer this over the browser: if a task involves a service that has an app on the phone, use the app.",
      props("name" to prop("string", "App name or package.")), listOf("name")))
    .put(tool("phone_list_apps", "List launchable apps installed on the phone. Check this before using the browser for a service (shopping, banking, messaging, social, travel, streaming…) so you use its app when installed.",
      props("filter" to prop("string", "Optional case-insensitive filter on name or package."))))
    .put(tool("phone_open_url", "Open an http(s) link. Use it for general web research or when no installed app covers the service; links to a service whose app is installed usually open in that app.",
      props("url" to prop("string", "The http or https URL.")), listOf("url")))
    .put(tool("phone_wait", "Wait for the screen to settle (page loads, animations), then return the element list.",
      props("seconds" to prop("number", "Seconds to wait, 0.5 to 10 (default 2)."))))
    .put(tool("phone_messages", "Recent incoming messages from messaging apps (WhatsApp, Messages…), read from their notifications: id, app, conversation, sender, text, recent history and whether a quick reply is possible. Use it to see what someone said without opening the app.",
      props("since_id" to prop("integer", "Only messages newer than this id."), "app" to prop("string", "Optional app name or package filter."), "for_drafting" to prop("boolean", "Only apps the user enabled for reply drafts."))))
    .put(tool("phone_reply", "Send a reply to an incoming message through the app's own quick-reply (no screen tapping; works with the phone locked). The phone applies the user's rules: it may ask them first.",
      props("message_id" to prop("integer", "Id from phone_messages."), "text" to prop("string", "The reply to send.")), listOf("message_id", "text")))
    .put(tool("phone_propose_reply", "Show the user a drafted reply to an incoming message as a notification with Send / Edit / Ignore. Nothing is sent unless they tap Send. Use this for reply drafts.",
      props("message_id" to prop("integer", "Id from phone_messages."), "text" to prop("string", "The drafted reply, written as the user.")), listOf("message_id", "text")))

  /** The Bot behind the current call (X-Hermes-Bot header), for rules, cards and the timeline. */
  @Volatile private var bot = "Hermes"
  /** Set by a check that stopped the action, so the timeline can say why. */
  private var outcomeOverride: String? = null
  private var lastSummary: String? = null
  private var tapPoint: Pair<Float, Float>? = null
  /** The app an action concerns when it is not the foreground one (replies go to the messaging app). */
  private var auditPkg: String? = null

  fun call(name: String, args: JSONObject, botHeader: String? = null): JSONObject = synchronized(lock) {
    bot = PhonePolicy.botName(botHeader)
    PhonePolicy.noteBot(service, bot)
    outcomeOverride = null; lastSummary = null; tapPoint = null; auditPkg = null
    val pkgBefore = foregroundPackage()
    if (!PhonePolicy.botAllowed(service, bot)) {
      val result = failure("The user has turned off phone access for $bot. Do not try again; tell them it is switched off in Hermes Mobile \u2192 Settings \u2192 Phone control.")
      PhoneAudit.record(service, bot, name, pkgBefore, appLabel(pkgBefore), "tried to use the phone ($name)", "blocked")
      return result
    }
    val acting = name in ACTING_TOOLS
    val before = if (acting && canCapture(pkgBefore)) captureBitmap() else null
    val result = try {
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
        "phone_messages" -> messages(args)
        "phone_reply" -> reply(args)
        "phone_propose_reply" -> proposeReply(args)
        else -> failure("Unknown tool: $name")
      }
    } catch (error: Exception) {
      failure(error.message ?: error.toString())
    }
    val failed = result.optBoolean("isError")
    val outcome = outcomeOverride ?: if (failed) "failed" else "done"
    // Empty message polls (the reply drafter checks every few seconds) would bury real actions.
    val quietPoll = name == "phone_messages" && outcome == "done" && lastSummary == null
    if (!quietPoll && (acting || outcome != "done" || name in AUDITED_READS)) {
      val pkgAfter = foregroundPackage() ?: pkgBefore
      val after = if (acting && outcome == "done" && canCapture(pkgAfter)) captureBitmap() else null
      val marked = before?.let { image -> tapPoint?.let { (x, y) -> PhoneAudit.markTap(image, x, y) } ?: image }
      val summary = lastSummary ?: if (failed) "$name failed: ${resultText(result).take(140)}" else name.removePrefix("phone_").replace('_', ' ')
      val pkg = auditPkg ?: pkgBefore
      runCatching { PhoneAudit.record(service, bot, name, pkg, appLabel(pkg), summary, outcome, marked, after) }
    }
    result
  }

  private fun resultText(result: JSONObject) = result.optJSONArray("content")?.optJSONObject(0)?.optString("text").orEmpty()

  // ── reading the screen ─────────────────────────────────────────────────────

  private fun screen(withScreenshot: Boolean): JSONObject {
    val pkg = foregroundPackage()
    if (PhonePolicy.effective(service, pkg, appLabel(pkg)) == PhonePolicy.Mode.BLOCK) {
      outcomeOverride = "blocked"
      lastSummary = "tried to read the screen of ${appLabel(pkg) ?: pkg}"
      return text("Foreground app: ${appLabel(pkg) ?: pkg} \u2014 blocked for Bots by the user, so its screen is hidden. " +
        "Press home (phone_key) or open another app; do not try to work in this one.")
    }
    val content = JSONArray().put(JSONObject().put("type", "text").put("text", describe()))
    if (withScreenshot) {
      screenshotJpeg()?.let { content.put(JSONObject().put("type", "image").put("mimeType", "image/jpeg").put("data", it)) }
        ?: content.put(JSONObject().put("type", "text").put("text", "(Screenshot unavailable on this screen — use the element list.)"))
    }
    service.noteAction("$bot read the screen")
    lastSummary = "read the screen"
    return JSONObject().put("content", content).put("isError", false)
  }

  private fun foregroundPackage(): String? = service.rootInActiveWindow?.packageName?.toString()?.takeIf { it != service.packageName }

  private fun appLabel(pkg: String?): String? = pkg?.let {
    runCatching { service.packageManager.getApplicationLabel(service.packageManager.getApplicationInfo(it, 0)).toString() }.getOrNull()
  }

  /** Screens of blocked apps are never captured, not even for the timeline. */
  private fun canCapture(pkg: String?) = PhonePolicy.effective(service, pkg, appLabel(pkg)) != PhonePolicy.Mode.BLOCK

  /** Acting in a blocked app is refused before anything happens; returns the refusal, or null to go ahead. */
  private fun refuseIfBlocked(what: String): JSONObject? {
    val pkg = foregroundPackage() ?: return null
    if (PhonePolicy.effective(service, pkg, appLabel(pkg)) != PhonePolicy.Mode.BLOCK) return null
    outcomeOverride = "blocked"
    lastSummary = "tried to $what in ${appLabel(pkg) ?: pkg}"
    service.noteAction("blocked $bot: $what in ${appLabel(pkg) ?: pkg}")
    return failure("${appLabel(pkg) ?: pkg} is blocked for Bots by the user. Do not act in it; press home or tell them what you need.")
  }

  /** Numbered list of the elements an agent can act on, across the visible app and keyboard windows. */
  private fun describe(): String {
    // The service only subscribes to window-state events, so in-page changes (e.g. a web page after a
    // tap) would otherwise be read from a stale node cache and look like the action did nothing.
    if (Build.VERSION.SDK_INT >= 33) service.clearCache()
    val collected = mutableListOf<Element>()
    val roots = windowRoots()
    val lines = StringBuilder()
    val metrics = service.resources.displayMetrics
    val app = service.rootInActiveWindow?.packageName ?: "unknown"
    lines.append("Foreground app: $app · screen ${metrics.widthPixels}x${metrics.heightPixels} px\n")
    lines.append(when (PhonePolicy.effective(service, app.toString(), appLabel(app.toString()))) {
      PhonePolicy.Mode.AUTO -> "Confirmation here: autopilot — the user lets you act in this app without asking.\n"
      PhonePolicy.Mode.ASK -> "Confirmation here: ask-first — the phone itself asks the user before risky taps and sends (send, post, pay, delete…); just act, and it reports if they decline.\n"
      PhonePolicy.Mode.BLOCK -> "This app is blocked for Bots: do not act in it.\n"
    })
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

  @Volatile private var lastShot: Pair<Long, Bitmap>? = null

  /** One screenshot, shared by the Bot's view and the timeline. Android rate-limits accessibility
   *  screenshots (~3/s), so a capture from the last moment is reused instead of failing. */
  private fun captureBitmap(): Bitmap? {
    if (Build.VERSION.SDK_INT < 30) return null
    lastShot?.let { (at, image) -> if (System.currentTimeMillis() - at < 400) return image }
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
    return bitmap?.also { lastShot = System.currentTimeMillis() to it }
  }

  private fun screenshotJpeg(): String? {
    val full = captureBitmap() ?: return null
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
    refuseIfBlocked("tap")?.let { return it }
    val longPress = args.optBoolean("long_press", false)
    val target = element(args)
    val verb = if (longPress) "press and hold" else "tap"
    val label: String
    if (target != null) {
      target.node.refresh()
      val clickable = clickableAncestor(target.node, longPress)
      val targetLabel = labelOf(target.node, clickable)
      tapPoint = target.bounds.exactCenterX() to target.bounds.exactCenterY()
      confirmRisky(verb, targetLabel)?.let { return it }
      target.node.refresh(); clickable?.refresh()
      val action = if (longPress) AccessibilityNodeInfo.ACTION_LONG_CLICK else AccessibilityNodeInfo.ACTION_CLICK
      // Chrome can report ACTION_CLICK on web content as handled without dispatching it, so web
      // content gets a real finger tap at the element's visible centre.
      val webPoint = if (isWebContent(target.node)) visibleCentre(target.node) else null
      val done = if (webPoint != null) { gestureTap(webPoint.first, webPoint.second, longPress); true }
        else clickable?.performAction(action) == true
      if (!done) gestureTap(target.bounds.centerX().toFloat(), target.bounds.centerY().toFloat(), longPress)
      label = "${if (longPress) "held" else "tapped"} \u201c${targetLabel.shown.ifEmpty { "element ${args.getInt("element")}" }.take(60)}\u201d"
    } else {
      if (!args.has("x") || !args.has("y")) throw IllegalArgumentException("Give an element number or x and y.")
      val x = args.getInt("x"); val y = args.getInt("y")
      tapPoint = x.toFloat() to y.toFloat()
      // A coordinate tap is judged by the element under the point, so it cannot bypass Ask first.
      if (elements.isEmpty()) describe()
      val hit = elements.filter { it.bounds.contains(x, y) }.minByOrNull { it.bounds.width().toLong() * it.bounds.height() }
      val hitLabel = hit?.let { labelOf(it.node, clickableAncestor(it.node, longPress)) }
      if (hitLabel != null) confirmRisky(verb, hitLabel)?.let { return it }
      gestureTap(x.toFloat(), y.toFloat(), longPress)
      label = "${if (longPress) "held" else "tapped"} ${hitLabel?.shown?.takeIf { it.isNotEmpty() }?.let { "\u201c${it.take(60)}\u201d" } ?: "($x,$y)"}"
    }
    return acted(label)
  }

  /** What the user sees ([shown]) and everything the risk check reads, including view ids ([all]). */
  private class Label(val shown: String, val all: String)

  /** Text, description and view id of the target, its clickable ancestor and its children. */
  private fun labelOf(node: AccessibilityNodeInfo, clickable: AccessibilityNodeInfo?): Label {
    val visible = mutableListOf<String>()
    val ids = mutableListOf<String>()
    fun add(n: AccessibilityNodeInfo?) {
      if (n == null) return
      n.text?.let { visible += it.toString() }
      n.contentDescription?.let { visible += it.toString() }
      n.viewIdResourceName?.let { ids += it.substringAfterLast('/').replace('_', ' ') }
    }
    add(node); add(clickable)
    val container = clickable ?: node
    for (i in 0 until minOf(container.childCount, 8)) add(container.getChild(i))
    fun join(list: List<String>) = list.map { it.trim() }.filter { it.isNotEmpty() }.distinct().joinToString(" · ")
    val shown = join(visible).ifEmpty { join(ids) }.take(120)
    return Label(shown, join(visible + ids))
  }

  /** Where the app's rule says ask, a risky action waits for Allow on the phone; returns a failure result if denied. */
  private fun confirmRisky(verb: String, label: Label, detail: String = ""): JSONObject? {
    val pkg = foregroundPackage()
    if (PhonePolicy.effective(service, pkg, appLabel(pkg)) != PhonePolicy.Mode.ASK || !PhoneConfirmation.isRisky(label.all)) return null
    val app = foregroundAppName()
    val what = label.shown.ifEmpty { "an unlabelled control" }
    service.noteAction("waiting for you to allow $bot: $verb \u201c$what\u201d")
    val allowed = PhoneConfirmation.ask(service, "$bot wants to $verb \u201c${what.take(60)}\u201d${if (app != null) " in $app" else ""}", detail.ifBlank { pendingText() })
    if (allowed) return null
    service.noteAction("you declined $bot: $verb \u201c$what\u201d")
    outcomeOverride = "declined"
    lastSummary = "$verb \u201c${what.take(60)}\u201d \u2014 you declined"
    return failure("The user declined this on the phone (or did not answer within 60 seconds): $verb \u201c$what\u201d. Do not retry it; tell them what you were about to do and ask how to proceed.")
  }

  /** The message being composed, if any, so the confirmation shows what would be sent. */
  private fun pendingText(): String {
    val focused = service.rootInActiveWindow?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
    val text = focused?.takeIf { it.isEditable && !it.isPassword }?.text?.toString()?.trim().orEmpty()
    return if (text.isEmpty()) "" else "Text: \u201c${text.take(200)}\u201d"
  }

  private fun foregroundAppName(): String? {
    val pkg = service.rootInActiveWindow?.packageName?.toString() ?: return null
    return runCatching { service.packageManager.getApplicationLabel(service.packageManager.getApplicationInfo(pkg, 0)).toString() }.getOrNull()
  }

  private fun isWebContent(node: AccessibilityNodeInfo): Boolean {
    var current: AccessibilityNodeInfo? = node
    var hops = 0
    while (current != null && hops < 40) {
      if (current.className?.toString() == "android.webkit.WebView") return true
      current = current.parent
      hops++
    }
    return false
  }

  /** Centre of the part of the node that is on screen, or null if none of it is visible. */
  private fun visibleCentre(node: AccessibilityNodeInfo): Pair<Float, Float>? {
    val bounds = Rect().also { node.getBoundsInScreen(it) }
    val metrics = service.resources.displayMetrics
    if (!bounds.intersect(0, 0, metrics.widthPixels, metrics.heightPixels) || bounds.isEmpty) return null
    return bounds.exactCenterX() to bounds.exactCenterY()
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
    refuseIfBlocked("type")?.let { return it }
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
      // Enter can send a message or place an order, so submitting is gated like a risky tap.
      confirmRisky("submit", Label("typed text", "submit typed text"), "Text: \u201c${text.take(200)}\u201d")?.let { return it }
      Thread.sleep(250)
      submitted = if (Build.VERSION.SDK_INT >= 30 && node.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.id)) " and submitted" else " (submit not supported here — tap the send/search button)"
    }
    return acted("typed \u201c${text.take(60)}${if (text.length > 60) "\u2026" else ""}\u201d$submitted")
  }

  private fun swipe(args: JSONObject): JSONObject {
    refuseIfBlocked("swipe")?.let { return it }
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
    return if (apps.isEmpty()) "No launchable apps match \"$filter\"." else apps.joinToString("\n") { (label, pkg) ->
      when (PhonePolicy.effective(service, pkg, label)) {
        PhonePolicy.Mode.BLOCK -> "$label ($pkg) \u2014 blocked for Bots"
        PhonePolicy.Mode.ASK -> "$label ($pkg) \u2014 asks before sending"
        PhonePolicy.Mode.AUTO -> "$label ($pkg)"
      }
    }
  }

  private fun openApp(name: String): JSONObject {
    if (name.isBlank()) throw IllegalArgumentException("Give an app name or package.")
    val apps = launchables()
    val match = apps.firstOrNull { it.second.equals(name, true) }
      ?: apps.firstOrNull { it.first.equals(name, true) }
      ?: apps.firstOrNull { it.first.contains(name, true) }
      ?: throw IllegalArgumentException("No installed app matches \"$name\". Use phone_list_apps.")
    if (PhonePolicy.effective(service, match.second, match.first) == PhonePolicy.Mode.BLOCK) {
      outcomeOverride = "blocked"
      lastSummary = "tried to open ${match.first}"
      service.noteAction("blocked $bot: open ${match.first}")
      return failure("${match.first} is blocked for Bots by the user. Do not open it; tell them what you need instead.")
    }
    val intent = service.packageManager.getLaunchIntentForPackage(match.second)
      ?: throw IllegalStateException("${match.first} cannot be launched.")
    service.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED))
    Thread.sleep(1200)
    return acted("opened ${match.first}")
  }

  private fun openUrl(url: String): JSONObject {
    val uri = Uri.parse(url.trim())
    if (uri.scheme != "http" && uri.scheme != "https") throw IllegalArgumentException("Only http and https links can be opened.")
    val intent = Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    // A link can open straight into an app (a bank's domain into its app), so the target app's rule applies.
    val target = service.packageManager.resolveActivity(intent, PackageManager.MATCH_DEFAULT_ONLY)?.activityInfo?.packageName
    if (target != null && target != "android" && PhonePolicy.effective(service, target, appLabel(target)) == PhonePolicy.Mode.BLOCK) {
      outcomeOverride = "blocked"
      lastSummary = "tried to open ${uri.host} in ${appLabel(target) ?: target}"
      return failure("That link opens ${appLabel(target) ?: target}, which is blocked for Bots by the user.")
    }
    service.startActivity(intent)
    Thread.sleep(1500)
    return acted("opened ${uri.host}")
  }

  // ── messages and replies ───────────────────────────────────────────────────

  private fun messages(args: JSONObject): JSONObject {
    if (!PhoneMessages.accessGranted(service)) {
      return failure("Message reading is off: the user has not given Hermes Mobile notification access (Settings \u2192 Phone control \u2192 Reply drafts).")
    }
    val filter = args.optString("app").trim()
    val pkgs = if (args.optBoolean("for_drafting", false)) ReplyDrafts.enabledApps(service) else null
    val found = PhoneMessages.list(args.optLong("since_id", 0), pkgs)
      .filter { filter.isEmpty() || it.appLabel.contains(filter, true) || it.pkg.contains(filter, true) }
      .filter { PhonePolicy.effective(service, it.pkg, it.appLabel) != PhonePolicy.Mode.BLOCK }
    if (found.isNotEmpty()) lastSummary = "read ${found.size} new message${if (found.size == 1) "" else "s"}${found.map { it.sender }.distinct().take(3).joinToString(prefix = " from ", separator = ", ")}"
    return text(JSONObject().put("messages", JSONArray(found.takeLast(30).map { it.json() })).toString())
  }

  private fun message(args: JSONObject): PhoneMessages.Incoming =
    (PhoneMessages.get(args.optLong("message_id", -1)) ?: throw IllegalArgumentException("No message with that id on the phone; call phone_messages again."))
      .also { auditPkg = it.pkg }

  private fun reply(args: JSONObject): JSONObject {
    val message = message(args)
    val replyText = args.optString("text").trim()
    if (replyText.isEmpty()) throw IllegalArgumentException("Give the reply text.")
    when (PhonePolicy.effective(service, message.pkg, message.appLabel)) {
      PhonePolicy.Mode.BLOCK -> {
        outcomeOverride = "blocked"; lastSummary = "tried to reply to ${message.sender} in ${message.appLabel}"
        return failure("${message.appLabel} is blocked for Bots by the user.")
      }
      PhonePolicy.Mode.ASK -> {
        val allowed = PhoneConfirmation.ask(service, "$bot wants to reply to ${message.sender} in ${message.appLabel}", "Text: \u201c${replyText.take(200)}\u201d")
        if (!allowed) {
          outcomeOverride = "declined"; lastSummary = "reply to ${message.sender}: \u201c${replyText.take(80)}\u201d \u2014 you declined"
          return failure("The user declined sending this reply to ${message.sender}. Do not retry; ask them how to proceed.")
        }
      }
      PhonePolicy.Mode.AUTO -> Unit
    }
    PhoneMessages.reply(service, message.id, replyText)?.let { return failure(it) }
    lastSummary = "replied to ${message.sender} in ${message.appLabel}: \u201c${replyText.take(80)}\u201d"
    service.noteAction("$bot replied to ${message.sender}")
    return text("Sent to ${message.sender} in ${message.appLabel}.")
  }

  private fun proposeReply(args: JSONObject): JSONObject {
    val message = message(args)
    val replyText = args.optString("text").trim()
    if (replyText.isEmpty()) throw IllegalArgumentException("Give the drafted reply.")
    if (PhonePolicy.effective(service, message.pkg, message.appLabel) == PhonePolicy.Mode.BLOCK) {
      outcomeOverride = "blocked"
      return failure("${message.appLabel} is blocked for Bots by the user.")
    }
    ReplyDrafts.propose(service, message, replyText, bot)
    lastSummary = "drafted a reply to ${message.sender} in ${message.appLabel}: \u201c${replyText.take(80)}\u201d"
    return text("Draft shown to the user with Send / Edit / Ignore. Nothing is sent unless they tap Send.")
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
    lastSummary = summary
    service.noteAction("$bot $summary")
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
    /** Actions that change something; they get before/after screenshots in the timeline. */
    /** Non-acting calls that still belong in the timeline. */
    private val AUDITED_READS = setOf("phone_screen", "phone_messages", "phone_reply", "phone_propose_reply")
    private val ACTING_TOOLS = setOf("phone_tap", "phone_type", "phone_swipe", "phone_key", "phone_open_app", "phone_open_url")
    const val INSTRUCTIONS = "Tools to operate the user's Android phone (a Galaxy Z Fold7). Start with phone_screen, act by element number, " +
      "and read the refreshed element list each action returns. Coordinates are screen pixels. App first: when a task involves a " +
      "service (messaging, shopping, banking, social, travel, maps, streaming…), check phone_list_apps and use the installed app; use the " +
      "browser for general web research or when no app covers it. Never type passwords and stop if a screen asks for credentials. " +
      "phone_screen states the rule for the current app: ask-first means the phone asks the user before risky taps and sends, so just act; " +
      "blocked apps are off limits. For messages use phone_messages (read) and phone_reply / phone_propose_reply (no screen tapping needed)."
  }
}
