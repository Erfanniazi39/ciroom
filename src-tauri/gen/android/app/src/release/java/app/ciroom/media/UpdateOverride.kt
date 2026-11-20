package app.ciroom.media

import android.content.Context
import android.content.Intent

/** Release builds always ask GitHub. (The debug build has its own copy of this file, for testing.) */
object UpdateOverride {
  fun url(@Suppress("UNUSED_PARAMETER") ctx: Context): String? = null
  fun capture(@Suppress("UNUSED_PARAMETER") ctx: Context, @Suppress("UNUSED_PARAMETER") intent: Intent?) {}
}
