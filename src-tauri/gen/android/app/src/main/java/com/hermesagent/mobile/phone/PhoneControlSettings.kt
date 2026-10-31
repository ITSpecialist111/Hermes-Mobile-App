package com.hermesagent.mobile.phone

import android.content.Context
import java.net.Inet4Address
import java.net.InetAddress
import java.net.NetworkInterface
import java.security.MessageDigest
import java.security.SecureRandom

/** Bearer token and LAN address for the phone-control MCP endpoint. */
object PhoneControlSettings {
  const val PORT = 8765
  private const val PREFS = "hermes-phone-control"
  private const val TOKEN = "token"
  private const val ASK_FIRST = "ask_first"

  /** Ask the user on the phone before risky taps (send, post, pay, delete…). On unless they turn it off. */
  fun askFirst(context: Context): Boolean =
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(ASK_FIRST, true)

  fun setAskFirst(context: Context, value: Boolean) {
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(ASK_FIRST, value).apply()
  }

  fun token(context: Context): String {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    prefs.getString(TOKEN, null)?.let { return it }
    return rotateToken(context)
  }

  /** A new token revokes every Hermes host configured with the old one. */
  fun rotateToken(context: Context): String {
    val bytes = ByteArray(32).also { SecureRandom().nextBytes(it) }
    val token = bytes.joinToString("") { "%02x".format(it) }
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(TOKEN, token).apply()
    return token
  }

  fun tokenMatches(context: Context, presented: String?): Boolean {
    if (presented.isNullOrEmpty()) return false
    return MessageDigest.isEqual(presented.toByteArray(), token(context).toByteArray())
  }

  /** The phone's private IPv4 on Wi-Fi (or any private interface), for the MCP URL. */
  fun lanAddress(): String? {
    val candidates = runCatching { NetworkInterface.getNetworkInterfaces().toList() }.getOrDefault(emptyList())
      .filter { runCatching { it.isUp && !it.isLoopback }.getOrDefault(false) }
      .sortedBy { if (it.name.startsWith("wlan")) 0 else 1 }
    for (iface in candidates) {
      for (address in iface.inetAddresses.toList()) {
        if (address is Inet4Address && isPrivate(address)) return address.hostAddress
      }
    }
    return null
  }

  /** LAN (RFC 1918), Tailscale (100.64.0.0/10) or loopback peers only. */
  fun isPrivate(address: InetAddress): Boolean {
    if (address.isLoopbackAddress || address.isSiteLocalAddress) return true
    val bytes = address.address
    if (bytes.size == 4) {
      val first = bytes[0].toInt() and 0xff
      val second = bytes[1].toInt() and 0xff
      if (first == 100 && second in 64..127) return true
    }
    // IPv4-mapped IPv6 peers arrive as ::ffff:a.b.c.d on dual-stack sockets.
    if (bytes.size == 16 && bytes.take(10).all { it.toInt() == 0 } && bytes[10].toInt() == -1 && bytes[11].toInt() == -1) {
      return isPrivate(InetAddress.getByAddress(bytes.copyOfRange(12, 16)))
    }
    return false
  }
}
