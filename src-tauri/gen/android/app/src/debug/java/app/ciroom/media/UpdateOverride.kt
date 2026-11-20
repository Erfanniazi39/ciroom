package app.ciroom.media

import android.content.Context
import android.content.Intent

/**
 * DEBUG BUILDS ONLY (this folder is not part of release builds). Lets a test point the update check at a JSON file on
 * the PC: `adb shell am start -n app.ciroom.media/.MainActivity --es update_url http://<pc>:1430/fake-release.json`.
 * `--es update_url ""` goes back to GitHub.
 */
object UpdateOverride {
  fun url(ctx: Context): String? = ctx.getSharedPreferences("update-debug", Context.MODE_PRIVATE).getString("url", null)?.takeIf { it.isNotEmpty() }

  fun capture(ctx: Context, intent: Intent?) {
    val u = intent?.getStringExtra("update_url") ?: return
    ctx.getSharedPreferences("update-debug", Context.MODE_PRIVATE).edit().putString("url", u).apply()
  }
}
