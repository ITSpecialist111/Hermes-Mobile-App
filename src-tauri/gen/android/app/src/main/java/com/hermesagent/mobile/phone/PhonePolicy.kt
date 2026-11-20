package com.hermesagent.mobile.phone

import android.content.Context
import org.json.JSONObject

/**
 * Who may do what on this phone. Enforced here, on the device, so no Bot prompt can talk its way
 * past it:
 *
 *  - Per app: AUTO (act without asking), ASK (Allow/Deny card before risky taps and sends) or
 *    BLOCK (Bots cannot open it, read its screen or act in it). Banking, wallets, password managers
 *    and authenticators are blocked unless the user says otherwise; messaging and email always ask.
 *    Everything else follows the global Ask first switch.
 *  - Per Bot: allowed or not. Bots identify themselves with the X-Hermes-Bot header that each
 *    profile's MCP config sets.
 */
object PhonePolicy {
  enum class Mode(val id: String) { AUTO("auto"), ASK("ask"), BLOCK("block");
    companion object { fun of(id: String?) = values().firstOrNull { it.id == id } }
  }

  /** Where an app's effective mode comes from, for the settings screen. */
  enum class Source(val id: String) { CUSTOM("custom"), DEFAULT("default"), GLOBAL("global") }

  private const val PREFS = "hermes-phone-policy"
  private const val APPS = "apps"
  private const val BOTS = "bots"
  private const val SEEN_BOTS = "seen_bots"

  private val SENSITIVE_PACKAGES = setOf(
    // Banks and payments (UK first, then common international ones).
    "uk.co.hsbc.hsbcukmobilebanking", "com.barclays.android.barclaysmobilebanking", "uk.co.santander.santanderUK",
    "com.grppl.android.shell.CMBlloydsTSB73", "com.grppl.android.shell.halifax", "com.grppl.android.shell.BOS",
    "com.rbs.mobile.android.natwest", "com.rbs.mobile.android.rbs", "com.nationwide.mobile.android.nationwide",
    "co.uk.getmondo", "com.starlingbank.android", "com.revolut.revolut", "com.tsb.mobilebank", "uk.co.firstdirect.mobilebanking",
    "com.virginmoney.uk.mobile.android", "com.paypal.android.p2pmobile", "com.coinbase.android", "com.chase.sig.android",
    "com.wise.android", "com.transferwise.android", "com.google.android.apps.walletnfcrel", "com.samsung.android.spay",
    "com.samsung.android.samsungpay.gear", "com.amex.uk.amexmobile", "com.creditcard.mbna",
    // Password managers and authenticators.
    "com.x8bit.bitwarden", "com.lastpass.lpandroid", "com.onepassword.android", "com.agilebits.onepassword",
    "com.dashlane", "keepass2android.keepass2android", "com.google.android.apps.authenticator2", "com.azure.authenticator",
    "com.authy.authy", "com.samsung.android.samsungpass",
  )
  private val SENSITIVE_WORDS = Regex("\\b(bank|banking|wallet|pay|authenticator|password|vault)\\b", RegexOption.IGNORE_CASE)

  val MESSAGING_PACKAGES = setOf(
    "com.whatsapp", "com.whatsapp.w4b", "com.google.android.apps.messaging", "com.samsung.android.messaging",
    "org.telegram.messenger", "org.thoughtcrime.securesms", "com.facebook.orca", "com.instagram.android",
    "com.google.android.gm", "com.microsoft.office.outlook", "com.Slack", "com.microsoft.teams", "com.discord",
    "com.facebook.katana", "com.twitter.android", "com.linkedin.android", "com.snapchat.android",
  )

  /** The built-in starting point for an app, before any choice the user made. */
  fun defaultMode(pkg: String, label: String? = null): Mode? = when {
    pkg in SENSITIVE_PACKAGES -> Mode.BLOCK
    label != null && SENSITIVE_WORDS.containsMatchIn(label) && pkg !in MESSAGING_PACKAGES -> Mode.BLOCK
    pkg in MESSAGING_PACKAGES -> Mode.ASK
    else -> null
  }

  private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
  private fun readMap(context: Context, key: String): JSONObject =
    runCatching { JSONObject(prefs(context).getString(key, "{}") ?: "{}") }.getOrDefault(JSONObject())

  fun appRules(context: Context): Map<String, Mode> {
    val json = readMap(context, APPS)
    return json.keys().asSequence().mapNotNull { pkg -> Mode.of(json.optString(pkg))?.let { pkg to it } }.toMap()
  }

  /** null clears the user's choice, returning the app to its default. */
  fun setAppRule(context: Context, pkg: String, mode: Mode?) {
    val json = readMap(context, APPS)
    if (mode == null) json.remove(pkg) else json.put(pkg, mode.id)
    prefs(context).edit().putString(APPS, json.toString()).apply()
  }

  fun effective(context: Context, pkg: String?, label: String? = null): Mode {
    if (pkg.isNullOrEmpty()) return globalMode(context)
    appRules(context)[pkg]?.let { return it }
    return defaultMode(pkg, label) ?: globalMode(context)
  }

  fun source(context: Context, pkg: String, label: String? = null): Source = when {
    appRules(context).containsKey(pkg) -> Source.CUSTOM
    defaultMode(pkg, label) != null -> Source.DEFAULT
    else -> Source.GLOBAL
  }

  private fun globalMode(context: Context) = if (PhoneControlSettings.askFirst(context)) Mode.ASK else Mode.AUTO

  /** Bot names arrive from config; keep them tidy so they cannot inject text into prompts or cards. */
  fun botName(raw: String?): String {
    val cleaned = raw.orEmpty().filter { it.isLetterOrDigit() || it == '-' || it == '_' || it == ' ' }.trim().take(32)
    return if (cleaned.isEmpty()) "Hermes" else cleaned.replaceFirstChar { it.uppercase() }
  }

  fun botAllowed(context: Context, bot: String): Boolean = readMap(context, BOTS).optBoolean(bot.lowercase(), true)

  fun setBotAllowed(context: Context, bot: String, allowed: Boolean) {
    val json = readMap(context, BOTS).put(bot.lowercase(), allowed)
    prefs(context).edit().putString(BOTS, json.toString()).apply()
  }

  /** Bots that have used the phone, so the settings screen can list them even before a rule exists. */
  fun noteBot(context: Context, bot: String) {
    val seen = readMap(context, SEEN_BOTS)
    if (seen.has(bot.lowercase())) return
    prefs(context).edit().putString(SEEN_BOTS, seen.put(bot.lowercase(), bot).toString()).apply()
  }

  fun bots(context: Context): List<Pair<String, Boolean>> {
    val seen = readMap(context, SEEN_BOTS)
    val rules = readMap(context, BOTS)
    val names = (seen.keys().asSequence() + rules.keys().asSequence()).toSortedSet()
    return names.map { key -> (seen.optString(key).ifEmpty { botName(key) }) to rules.optBoolean(key, true) }
  }
}
