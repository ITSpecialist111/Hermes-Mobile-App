package com.hermesagent.mobile

import android.annotation.SuppressLint
import android.content.ComponentName
import android.content.Intent
import android.os.Bundle
import android.provider.Settings
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.content.ContextCompat
import androidx.core.util.Consumer
import androidx.window.java.layout.WindowInfoTrackerCallbackAdapter
import androidx.window.layout.FoldingFeature
import androidx.window.layout.WindowInfoTracker
import androidx.window.layout.WindowLayoutInfo
import com.hermesagent.mobile.phone.PhoneAudit
import com.hermesagent.mobile.phone.PhoneControlService
import com.hermesagent.mobile.phone.PhoneControlSettings
import com.hermesagent.mobile.phone.PhonePolicy
import com.hermesagent.mobile.phone.ReplyDrafts
import io.crates.keyring.Keyring
import org.json.JSONArray
import org.json.JSONObject

class MainActivity : TauriActivity() {
  private var webView: WebView? = null
  private var foldTracker: WindowInfoTrackerCallbackAdapter? = null

  // Latest FoldingFeature as JSON in WebView CSS px ("null" when there is no fold).
  @Volatile private var foldJson: String = "null"

  private val layoutListener = Consumer<WindowLayoutInfo> { info -> publishFold(info) }

  override fun onCreate(savedInstanceState: Bundle?) {
    // android-native-keyring-store requires this before its first secure
    // credential operation. Tauri initializes its Rust runtime in super.
    Keyring.initializeNdkContext(applicationContext)
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  @SuppressLint("JavascriptInterface")
  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    this.webView = webView
    // Pull side of the fold bridge: survives reloads, read by src/fold-posture.ts.
    webView.addJavascriptInterface(FoldBridge(), "HermesFoldBridge")
    // Phone-control status for Settings → Phone control (src/phone-control.ts).
    webView.addJavascriptInterface(PhoneControlBridge(), "HermesPhoneControl")
  }

  override fun onStart() {
    super.onStart()
    val tracker = WindowInfoTrackerCallbackAdapter(WindowInfoTracker.getOrCreate(this))
    tracker.addWindowLayoutInfoListener(this, ContextCompat.getMainExecutor(this), layoutListener)
    foldTracker = tracker
  }

  override fun onStop() {
    foldTracker?.removeWindowLayoutInfoListener(layoutListener)
    foldTracker = null
    super.onStop()
  }

  private fun publishFold(info: WindowLayoutInfo) {
    val fold = info.displayFeatures.filterIsInstance<FoldingFeature>().firstOrNull()
    Log.d("HermesFold", "layout features=${info.displayFeatures.size} fold=$fold")
    val view = webView
    foldJson = if (fold == null) "null" else {
      val density = resources.displayMetrics.density
      val origin = IntArray(2)
      view?.getLocationInWindow(origin)
      val bounds = fold.bounds
      JSONObject()
        .put("state", if (fold.state == FoldingFeature.State.HALF_OPENED) "half_opened" else "flat")
        .put("orientation", if (fold.orientation == FoldingFeature.Orientation.VERTICAL) "vertical" else "horizontal")
        .put("separating", fold.isSeparating)
        .put("bounds", JSONObject()
          .put("x", (bounds.left - origin[0]) / density)
          .put("y", (bounds.top - origin[1]) / density)
          .put("width", bounds.width() / density)
          .put("height", bounds.height() / density))
        .toString()
    }
    // Push side: update the global and let the page re-read its posture immediately.
    view?.evaluateJavascript("window.__HERMES_FOLD__=$foldJson;window.dispatchEvent(new Event('hermes-fold'))", null)
  }

  private inner class FoldBridge {
    @JavascriptInterface
    fun state(): String = foldJson
  }

  private inner class PhoneControlBridge {
    @JavascriptInterface
    fun status(): String {
      val component = ComponentName(this@MainActivity, PhoneControlService::class.java).flattenToString()
      val enabledList = Settings.Secure.getString(contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES).orEmpty()
      val address = PhoneControlSettings.lanAddress()
      return JSONObject()
        .put("enabled", enabledList.split(':').any { it.equals(component, ignoreCase = true) })
        .put("running", PhoneControlService.instance != null)
        .put("address", address ?: JSONObject.NULL)
        .put("port", PhoneControlSettings.PORT)
        .put("url", address?.let { "http://$it:${PhoneControlSettings.PORT}/mcp" } ?: JSONObject.NULL)
        .put("token", PhoneControlSettings.token(this@MainActivity))
        .put("askFirst", PhoneControlSettings.askFirst(this@MainActivity))
        .toString()
    }

    @JavascriptInterface
    fun setAskFirst(value: Boolean) {
      PhoneControlSettings.setAskFirst(this@MainActivity, value)
      PhoneControlService.instance?.noteAction(if (value) "Ask first turned on" else "Autopilot turned on")
    }

    @JavascriptInterface
    fun openAccessibilitySettings() {
      startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    @JavascriptInterface
    fun rotateToken(): String = PhoneControlSettings.rotateToken(this@MainActivity)

    /** Launchable apps with their effective rule and where it comes from (custom / default / global). */
    @JavascriptInterface
    fun policy(): String {
      val pm = packageManager
      val apps = pm.queryIntentActivities(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER), 0)
        .map { it.loadLabel(pm).toString() to it.activityInfo.packageName }
        .distinctBy { it.second }
        .filter { it.second != packageName }
        .sortedBy { it.first.lowercase() }
      val appsJson = JSONArray(apps.map { (label, pkg) ->
        JSONObject().put("package", pkg).put("label", label)
          .put("mode", PhonePolicy.effective(this@MainActivity, pkg, label).id)
          .put("source", PhonePolicy.source(this@MainActivity, pkg, label).id)
          .put("messaging", pkg in PhonePolicy.MESSAGING_PACKAGES)
      })
      val bots = JSONArray(PhonePolicy.bots(this@MainActivity).map { (name, allowed) -> JSONObject().put("name", name).put("allowed", allowed) })
      return JSONObject().put("apps", appsJson).put("bots", bots).toString()
    }

    /** mode: auto | ask | block, or "" to go back to the default. */
    @JavascriptInterface
    fun setAppRule(pkg: String, mode: String) {
      PhonePolicy.setAppRule(this@MainActivity, pkg, PhonePolicy.Mode.of(mode))
    }

    @JavascriptInterface
    fun setBotAllowed(name: String, allowed: Boolean) {
      PhonePolicy.setBotAllowed(this@MainActivity, name, allowed)
      PhoneControlService.instance?.noteAction(if (allowed) "$name may use the phone" else "$name is blocked from the phone")
    }

    @JavascriptInterface
    fun audit(limit: Int): String = PhoneAudit.list(this@MainActivity, limit.coerceIn(1, 300)).toString()

    @JavascriptInterface
    fun auditImage(id: String, which: String): String = id.toLongOrNull()?.let { PhoneAudit.imageDataUrl(this@MainActivity, it, which) }.orEmpty()

    @JavascriptInterface
    fun clearAudit() { PhoneAudit.clear(this@MainActivity) }

    @JavascriptInterface
    fun drafts(): String {
      val pm = packageManager
      val installed = PhonePolicy.MESSAGING_PACKAGES.mapNotNull { pkg ->
        runCatching { pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString() }.getOrNull()?.let { pkg to it }
      }.sortedBy { it.second.lowercase() }
      val enabled = ReplyDrafts.enabledApps(this@MainActivity)
      return ReplyDrafts.status(this@MainActivity)
        .put("available", JSONArray(installed.map { (pkg, label) -> JSONObject().put("package", pkg).put("label", label).put("enabled", pkg in enabled) }))
        .toString()
    }

    @JavascriptInterface
    fun setDraftApp(pkg: String, enabled: Boolean) { ReplyDrafts.setAppEnabled(this@MainActivity, pkg, enabled) }

    @JavascriptInterface
    fun openNotificationAccess() {
      startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
  }
}
