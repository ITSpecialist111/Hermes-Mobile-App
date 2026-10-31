package com.hermesagent.mobile.phone

import android.content.Context
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.UUID
import java.util.concurrent.Executors
import kotlin.concurrent.thread

/**
 * A minimal MCP server (Streamable HTTP, JSON responses) on the phone's LAN address.
 *
 * Hermes connects with `Authorization: Bearer <token>`. Only private-network peers are accepted;
 * GET/HEAD/DELETE answer 405, which the MCP client treats as "no SSE stream offered".
 */
class PhoneMcpServer(private val context: Context, private val port: Int, private val tools: PhoneTools) {
  private val pool = Executors.newFixedThreadPool(4)
  @Volatile private var socket: ServerSocket? = null
  @Volatile private var running = false

  fun start() {
    running = true
    thread(name = "hermes-phone-mcp", isDaemon = true) {
      try {
        ServerSocket().use { server ->
          server.reuseAddress = true
          server.bind(InetSocketAddress(port))
          socket = server
          Log.i(TAG, "listening on :$port")
          while (running) {
            val client = try { server.accept() } catch (_: IOException) { break }
            pool.execute { runCatching { handle(client) }.onFailure { Log.w(TAG, "request failed", it) } }
          }
        }
      } catch (error: IOException) {
        Log.e(TAG, "server stopped", error)
      }
    }
  }

  fun stop() {
    running = false
    runCatching { socket?.close() }
    pool.shutdownNow()
  }

  private fun handle(client: Socket) { client.use { connection ->
    connection.soTimeout = 30_000
    val output = connection.getOutputStream()
    if (!PhoneControlSettings.isPrivate(connection.inetAddress)) {
      write(output, 403, null, null); return
    }
    val input = BufferedInputStream(connection.getInputStream())
    val requestLine = readLine(input) ?: return
    val parts = requestLine.split(" ")
    if (parts.size < 2) { write(output, 400, null, null); return }
    val method = parts[0]
    val path = parts[1].substringBefore('?')
    val headers = mutableMapOf<String, String>()
    while (true) {
      val line = readLine(input) ?: return
      if (line.isEmpty()) break
      val colon = line.indexOf(':')
      if (colon > 0) headers[line.substring(0, colon).trim().lowercase()] = line.substring(colon + 1).trim()
    }
    if (path != "/mcp") { write(output, 404, null, null); return }
    val bearer = headers["authorization"]?.removePrefix("Bearer ")?.trim()
    if (!PhoneControlSettings.tokenMatches(context, bearer)) {
      write(output, 401, "application/json", """{"error":"unauthorized"}""", mapOf("WWW-Authenticate" to "Bearer")); return
    }
    if (method != "POST") { write(output, 405, null, null, mapOf("Allow" to "POST")); return }
    val length = headers["content-length"]?.toIntOrNull() ?: 0
    if (length <= 0 || length > MAX_BODY) { write(output, 413, null, null); return }
    val body = readBody(input, length)

    val trimmed = body.trim()
    val replies = JSONArray()
    var sessionHeader: String? = null
    val messages = if (trimmed.startsWith("[")) JSONArray(trimmed) else JSONArray().put(JSONObject(trimmed))
    for (i in 0 until messages.length()) {
      val message = messages.getJSONObject(i)
      if (!message.has("id") || message.isNull("id")) continue // notification: no reply
      if (message.optString("method") == "initialize") sessionHeader = UUID.randomUUID().toString()
      replies.put(dispatch(message))
    }
    if (replies.length() == 0) { write(output, 202, null, null); return }
    val payload = if (trimmed.startsWith("[")) replies.toString() else replies.getJSONObject(0).toString()
    write(output, 200, "application/json", payload, sessionHeader?.let { mapOf("Mcp-Session-Id" to it) } ?: emptyMap())
  } }

  private fun dispatch(message: JSONObject): JSONObject {
    val id = message.get("id")
    val params = message.optJSONObject("params") ?: JSONObject()
    return try {
      val result = when (message.optString("method")) {
        "initialize" -> JSONObject()
          .put("protocolVersion", params.optString("protocolVersion", "2025-06-18"))
          .put("capabilities", JSONObject().put("tools", JSONObject().put("listChanged", false)))
          .put("serverInfo", JSONObject().put("name", "hermes-phone").put("version", "1.0.0"))
          .put("instructions", PhoneTools.INSTRUCTIONS)
        "ping" -> JSONObject()
        "tools/list" -> JSONObject().put("tools", tools.definitions())
        "tools/call" -> tools.call(params.optString("name"), params.optJSONObject("arguments") ?: JSONObject())
        else -> return error(id, -32601, "Method not found: ${message.optString("method")}")
      }
      JSONObject().put("jsonrpc", "2.0").put("id", id).put("result", result)
    } catch (failure: Exception) {
      Log.w(TAG, "dispatch failed", failure)
      error(id, -32603, failure.message ?: "Internal error")
    }
  }

  private fun error(id: Any, code: Int, text: String) =
    JSONObject().put("jsonrpc", "2.0").put("id", id).put("error", JSONObject().put("code", code).put("message", text))

  private fun readLine(input: InputStream): String? {
    val buffer = ByteArrayOutputStream()
    while (true) {
      val byte = input.read()
      if (byte == -1) return if (buffer.size() == 0) null else buffer.toString(Charsets.ISO_8859_1.name())
      if (byte == '\n'.code) break
      if (byte != '\r'.code) buffer.write(byte)
      if (buffer.size() > 16_384) throw IOException("header line too long")
    }
    return buffer.toString(Charsets.ISO_8859_1.name())
  }

  private fun readBody(input: InputStream, length: Int): String {
    val bytes = ByteArray(length)
    var read = 0
    while (read < length) {
      val count = input.read(bytes, read, length - read)
      if (count == -1) break
      read += count
    }
    return String(bytes, 0, read, Charsets.UTF_8)
  }

  private fun write(output: java.io.OutputStream, status: Int, contentType: String?, body: String?, extra: Map<String, String> = emptyMap()) {
    val bytes = body?.toByteArray(Charsets.UTF_8) ?: ByteArray(0)
    val reason = when (status) { 200 -> "OK"; 202 -> "Accepted"; 400 -> "Bad Request"; 401 -> "Unauthorized"; 403 -> "Forbidden"; 404 -> "Not Found"; 405 -> "Method Not Allowed"; 413 -> "Payload Too Large"; else -> "Error" }
    val head = StringBuilder("HTTP/1.1 $status $reason\r\n")
    if (contentType != null) head.append("Content-Type: $contentType\r\n")
    head.append("Content-Length: ${bytes.size}\r\nConnection: close\r\nCache-Control: no-store\r\n")
    for ((key, value) in extra) head.append("$key: $value\r\n")
    head.append("\r\n")
    output.write(head.toString().toByteArray(Charsets.ISO_8859_1))
    output.write(bytes)
    output.flush()
  }

  companion object {
    private const val TAG = "HermesPhoneMcp"
    private const val MAX_BODY = 1_048_576
  }
}
