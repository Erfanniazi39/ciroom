package app.ciroom.media

import android.content.Intent
import android.content.pm.ActivityInfo
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.webkit.GeolocationPermissions
import android.webkit.JavascriptInterface
import android.webkit.JsPromptResult
import android.webkit.JsResult
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import android.widget.FrameLayout

class MainActivity : TauriActivity() {
  // We handle Back ourselves (see onWebViewCreate), not Tauri's goBack-or-exit.
  override val handleBackNavigation = false

  override fun onCreate(savedInstanceState: Bundle?) {
    // CiRoom is dark in every phone theme: transparent bars over the dark page, always light icons.
    enableEdgeToEdge(
      statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
      navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
    )
    UpdateOverride.capture(this, intent)
    super.onCreate(savedInstanceState)
    updates.startBackground() // for the next start: the answer is kept, the Connect page reads it
  }

  override fun onNewIntent(intent: Intent) {
    UpdateOverride.capture(this, intent)
    super.onNewIntent(intent)
  }

  val updates by lazy { UpdateChecker(this) }

  // The pairing cookie is written to disk only every ~30 s: a phone that is paired and then swiped away straight
  // after would forget the pairing. Write it whenever the app leaves the screen.
  override fun onPause() {
    CookieManager.getInstance().flush()
    super.onPause()
  }

  private var customView: View? = null
  private var customViewCallback: WebChromeClient.CustomViewCallback? = null

  /** Real fullscreen for the player: the page's fullscreen element is shown over everything, bars hidden, landscape. */
  fun enterFullscreen(view: View, callback: WebChromeClient.CustomViewCallback) {
    if (customView != null) { callback.onCustomViewHidden(); return }
    customView = view
    customViewCallback = callback
    view.setBackgroundColor(Color.BLACK)
    (window.decorView as FrameLayout).addView(view, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    WindowCompat.getInsetsController(window, window.decorView).apply {
      systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
      hide(WindowInsetsCompat.Type.systemBars())
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      window.attributes = window.attributes.also { it.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES }
    }
    requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
  }

  /** Leaves fullscreen (idempotent). Also called when the page leaves fullscreen by itself. */
  fun exitFullscreen() {
    val view = customView ?: return
    customView = null
    (window.decorView as FrameLayout).removeView(view)
    WindowCompat.getInsetsController(window, window.decorView).show(WindowInsetsCompat.Type.systemBars())
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      window.attributes = window.attributes.also { it.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_DEFAULT }
    }
    requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT // portrait outside the player (as in the manifest)
    val cb = customViewCallback
    customViewCallback = null
    cb?.onCustomViewHidden()
  }

  fun isFullscreen() = customView != null

  /** Portrait or landscape while the player is fullscreen (the WebView has no screen.orientation.lock). */
  fun lockOrientation(portrait: Boolean) = runOnUiThread {
    if (customView != null) requestedOrientation =
      if (portrait) ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT else ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
  }

  /** The screen stays on while a video plays on the phone (a plain http page has no navigator.wakeLock). */
  fun keepScreenOn(on: Boolean) = runOnUiThread {
    if (on) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
  }

  override fun onWebViewCreate(webView: WebView) {
    // Tauri sets its own clients right after this call returns, so wrap them one step later. getWebViewClient() and
    // getWebChromeClient() exist from Android 8; on older phones the PC page's error stays Android's own error page
    // and the player has no fullscreen.
    var client: ConnectFallbackClient? = null
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      webView.post {
        client = ConnectFallbackClient(webView.webViewClient, webView.url ?: webView.originalUrl, this)
        webView.webViewClient = client!!
        webView.webChromeClient = FullscreenChromeClient(webView.webChromeClient!!, this)
      }
    }

    // The Connect page asks "is this phone already paired with that PC?" (the pairing cookie is HttpOnly, so the page
    // can't see it itself). Yes/no only; the cookie never leaves the app. Only private IPv4 addresses are looked up.
    webView.addJavascriptInterface(PairedCheck(this), "CiRoomNative")
    webView.addJavascriptInterface(ScreenAwake(this), "CiRoomScreen")

    // Back: inside the PC's page, the page's own history first. At the top of the PC's page, Back shows the Connect
    // screen (scan / change PC), so a phone that isn't paired, or a wrong PC, is never a dead end. On the Connect
    // screen, Back leaves the app.
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        if (isFullscreen()) { exitFullscreen(); return } // Back leaves the player's fullscreen first
        val home = client?.connectOrigin
        val onPcPage = home != null && webView.url?.startsWith("http") == true && !webView.url!!.startsWith(home)
        when {
          webView.canGoBack() -> webView.goBack()
          onPcPage -> client?.showConnect(webView, "$home/?noauto=1")
          else -> { isEnabled = false; onBackPressedDispatcher.onBackPressed(); isEnabled = true }
        }
      }
    })
  }
}

/**
 * The app opens the PC's own page in this WebView. If that page can't load (PC closed, Wi-Fi lost), Android would show
 * its grey error page with no way back. Instead, a failed load of the main page goes back to the bundled Connect
 * page with `?error=unreachable`. Everything else is handed to Tauri's own client unchanged.
 */
private class ConnectFallbackClient(private val inner: WebViewClient, firstUrl: String?, private val activity: MainActivity) : WebViewClient() {
  /** Scheme + host of the bundled Connect page (the first page the window loads). */
  var connectOrigin: String? = firstUrl?.takeIf { it.startsWith("http") }?.let { origin(Uri.parse(it)) }
    private set

  private fun origin(u: Uri) = "${u.scheme}://${u.authority}"

  private var clearHistoryOnConnect = false

  /**
   * Shows the Connect page and, once it has loaded, forgets the PC pages behind it. Otherwise connecting again would
   * leave the old PC page under the new one, and Back at the top of the PC's page would need two presses.
   */
  fun showConnect(view: WebView, url: String) {
    clearHistoryOnConnect = true
    view.loadUrl(url)
  }

  override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
    if (connectOrigin == null) connectOrigin = origin(Uri.parse(url))
    // A new page: no fullscreen or keep-awake left over from the previous one.
    activity.exitFullscreen()
    activity.keepScreenOn(false)
    inner.onPageStarted(view, url, favicon)
  }

  override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
    val home = connectOrigin
    if (request.isForMainFrame && home != null && origin(request.url) != home) {
      view.stopLoading()
      showConnect(view, "$home/?error=unreachable")
      return
    }
    inner.onReceivedError(view, request, error)
  }

  override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
    inner.shouldInterceptRequest(view, request)

  override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
    inner.shouldOverrideUrlLoading(view, request)

  override fun onPageFinished(view: WebView, url: String) {
    val home = connectOrigin
    if (clearHistoryOnConnect && home != null && url.startsWith(home)) {
      clearHistoryOnConnect = false
      view.clearHistory()
    }
    inner.onPageFinished(view, url)
  }
}

class PairedCheck(private val activity: MainActivity) {
  /** The Connect page's "Download" button: opens a CiRoom release file in the phone's browser. Nothing else is ever opened. */
  @JavascriptInterface
  fun openUrl(url: String): Boolean {
    val uri = Uri.parse(url)
    if (!url.startsWith("https://github.com/Erfanniazi39/ciroom/releases/download/") || uri.host != "github.com") return false
    activity.runOnUiThread {
      try {
        activity.startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      } catch (_: Exception) {
        // no browser to open it with
      }
    }
    return true
  }

  /** The newest release for this phone as JSON (see UpdateChecker.info). Read-only. */
  @JavascriptInterface
  fun updateInfo(): String = activity.updates.info()

  /** The "Check for updates" link: starts a check now; the page then reads updateInfo() a few times. */
  @JavascriptInterface
  fun checkForUpdate() = activity.updates.checkNow()

  @JavascriptInterface
  fun isPaired(host: String, port: Int): Boolean {
    if (!Regex("""^(10(\.\d{1,3}){3}|192\.168(\.\d{1,3}){2}|172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2})$""").matches(host) || port !in 1..65535) return false
    val cookies = CookieManager.getInstance().getCookie("http://$host:$port/") ?: return false
    return cookies.split(";").any { it.trim().startsWith("ciroom_remote=") }
  }
}

/** The page calls keepOn(true) while a video plays (and false when it stops), and lockPortrait(true/false) in fullscreen. Nothing else. */
class ScreenAwake(private val activity: MainActivity) {
  @JavascriptInterface
  fun keepOn(on: Boolean) = activity.keepScreenOn(on)

  @JavascriptInterface
  fun lockPortrait(portrait: Boolean) = activity.lockOrientation(portrait)
}

/**
 * wry's own client refuses every fullscreen request (it calls onCustomViewHidden at once), so the player's fullscreen
 * button did nothing. This one shows the page's fullscreen view itself and hands every other call to wry's client.
 */
private class FullscreenChromeClient(private val inner: WebChromeClient, private val activity: MainActivity) : WebChromeClient() {
  override fun onShowCustomView(view: View, callback: CustomViewCallback) = activity.enterFullscreen(view, callback)
  override fun onHideCustomView() = activity.exitFullscreen()

  override fun onPermissionRequest(request: PermissionRequest) = inner.onPermissionRequest(request)
  override fun getDefaultVideoPoster(): Bitmap? = inner.defaultVideoPoster
  override fun onJsAlert(view: WebView, url: String, message: String, result: JsResult): Boolean = inner.onJsAlert(view, url, message, result)
  override fun onJsConfirm(view: WebView, url: String, message: String, result: JsResult): Boolean = inner.onJsConfirm(view, url, message, result)
  override fun onJsPrompt(view: WebView, url: String, message: String, defaultValue: String, result: JsPromptResult): Boolean =
    inner.onJsPrompt(view, url, message, defaultValue, result)
  override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) =
    inner.onGeolocationPermissionsShowPrompt(origin, callback)
  override fun onShowFileChooser(webView: WebView, filePathCallback: ValueCallback<Array<Uri?>?>, fileChooserParams: FileChooserParams): Boolean =
    inner.onShowFileChooser(webView, filePathCallback, fileChooserParams)
  override fun onConsoleMessage(consoleMessage: ConsoleMessage): Boolean = inner.onConsoleMessage(consoleMessage)
  override fun onReceivedTitle(view: WebView, title: String) = inner.onReceivedTitle(view, title)
}
