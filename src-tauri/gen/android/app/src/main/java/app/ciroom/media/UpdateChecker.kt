package app.ciroom.media

import android.content.Context
import android.net.Uri
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicBoolean

/**
 * "Is there a newer CiRoom for this phone?" asked of GitHub's latest release, outside the WebView, so a page that
 * navigates away (the Connect screen opens the PC's page a second after start) can't kill the check. The answer is kept
 * in SharedPreferences and read by the Connect page through [info]. A release counts only if it has an asset named
 * `*_android-arm64.apk` on this repository's release downloads. Any failure keeps the old answer and says nothing.
 */
class UpdateChecker(context: Context) {
  private val ctx = context.applicationContext
  private val prefs = ctx.getSharedPreferences("update", Context.MODE_PRIVATE)
  private val running = AtomicBoolean(false)
  /** Outcome of the last attempt in this run: true = GitHub answered, false = it didn't, null = none yet. */
  @Volatile private var lastOk: Boolean? = null

  /** A background check, at most one network call per hour (GitHub allows 60 per hour per IP). */
  fun startBackground() = start(false)

  /** The "Check for updates" link: now, whatever the hour rule says (but never two at once, never twice within 10 s). */
  fun checkNow() = start(true)

  private fun start(force: Boolean) {
    val now = System.currentTimeMillis()
    val last = prefs.getLong("lastResponse", 0)
    if (!force && UpdateOverride.url(ctx) == null && now - last < HOUR) return // a test override skips the hour rule
    if (force && now - prefs.getLong("lastForced", 0) < 10_000) return
    if (!running.compareAndSet(false, true)) return
    if (force) prefs.edit().putLong("lastForced", now).apply()
    Thread {
      try {
        lastOk = fetch()
      } catch (_: Exception) {
        lastOk = false // offline, timeout, odd data
      } finally {
        running.set(false)
      }
    }.start()
  }

  /** JSON for the page: `{checking, ok?, version?, apkUrl?, checkedAt?}`. `version` is only there when it is newer than this app. */
  fun info(): String {
    val o = JSONObject()
    o.put("checking", running.get())
    lastOk?.let { o.put("ok", it) }
    val v = prefs.getString("version", null)
    val u = prefs.getString("apkUrl", null)
    if (v != null && u != null && isDownload(u) && isNewer(v, installedVersion())) {
      o.put("version", v)
      o.put("apkUrl", u)
      o.put("checkedAt", prefs.getLong("checkedAt", 0))
    } else if (v != null) {
      // the user already updated (or the answer is odd): forget it
      prefs.edit().remove("version").remove("apkUrl").remove("checkedAt").apply()
    }
    return o.toString()
  }

  /** Asks GitHub. True when it answered with a readable release (whether or not it is newer). */
  private fun fetch(): Boolean {
    val url = UpdateOverride.url(ctx) ?: API
    val c = URL(url).openConnection() as HttpURLConnection
    try {
      c.connectTimeout = 5000
      c.readTimeout = 5000
      c.setRequestProperty("Accept", "application/vnd.github+json")
      c.setRequestProperty("User-Agent", "CiRoom-Android")
      val code = c.responseCode
      prefs.edit().putLong("lastResponse", System.currentTimeMillis()).apply() // a rate-limit answer counts too
      if (code != 200) return false
      val text = c.inputStream.use { it.readBytes(1_000_000) }
      val release = JSONObject(String(text, Charsets.UTF_8))
      val version = release.optString("tag_name").removePrefix("v")
      if (!VERSION.matches(version)) return false
      val assets = release.optJSONArray("assets") ?: return true
      for (i in 0 until assets.length()) {
        val a = assets.optJSONObject(i) ?: continue
        val link = a.optString("browser_download_url")
        if (a.optString("name").endsWith("_android-arm64.apk") && isDownload(link)) {
          prefs.edit().putString("version", version).putString("apkUrl", link).putLong("checkedAt", System.currentTimeMillis()).apply()
          return true
        }
      }
      return true
    } finally {
      c.disconnect()
    }
  }

  private fun installedVersion(): String =
    try { ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName ?: "" } catch (_: Exception) { "" }

  private fun java.io.InputStream.readBytes(max: Int): ByteArray {
    val out = java.io.ByteArrayOutputStream()
    val buf = ByteArray(8192)
    while (true) {
      val n = read(buf)
      if (n < 0) break
      out.write(buf, 0, n)
      if (out.size() > max) throw java.io.IOException("too big")
    }
    return out.toByteArray()
  }

  companion object {
    private const val HOUR = 3_600_000L
    private const val API = "https://api.github.com/repos/Erfanniazi39/ciroom/releases/latest"
    private const val PREFIX = "https://github.com/Erfanniazi39/ciroom/releases/download/"
    private val VERSION = Regex("""\d{1,5}\.\d{1,5}\.\d{1,5}""")

    /** Same rule as the page's openUrl: only this repository's release downloads. */
    fun isDownload(url: String): Boolean = url.startsWith(PREFIX) && Uri.parse(url).host == "github.com"

    /** `0.2.0` newer than `0.1.5`? Anything unreadable is never newer. */
    fun isNewer(candidate: String, current: String): Boolean {
      if (!VERSION.matches(candidate) || !VERSION.matches(current)) return false
      val a = candidate.split(".").map { it.toInt() }
      val b = current.split(".").map { it.toInt() }
      for (i in 0..2) if (a[i] != b[i]) return a[i] > b[i]
      return false
    }
  }
}
