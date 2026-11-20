package app.ciroom.media

import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  // We handle Back ourselves (see onWebViewCreate), not Tauri's goBack-or-exit.
  override val handleBackNavigation = false

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onWebViewCreate(webView: WebView) {
    // Tauri sets its own client right after this call returns, so wrap it one step later. getWebViewClient() exists
    // from Android 8; on older phones the PC page's error stays Android's own error page.
    var client: ConnectFallbackClient? = null
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      webView.post {
        client = ConnectFallbackClient(webView.webViewClient, webView.url ?: webView.originalUrl)
        webView.webViewClient = client!!
      }
    }

    // The Connect page asks "is this phone already paired with that PC?" (the pairing cookie is HttpOnly, so the page
    // can't see it itself). Yes/no only; the cookie never leaves the app. Only private IPv4 addresses are looked up.
    webView.addJavascriptInterface(PairedCheck(), "CiRoomNative")

    // Back: inside the PC's page, the page's own history first. At the top of the PC's page, Back shows the Connect
    // screen (scan / change PC), so a phone that isn't paired, or a wrong PC, is never a dead end. On the Connect
    // screen, Back leaves the app.
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        val home = client?.connectOrigin
        val onPcPage = home != null && webView.url?.startsWith("http") == true && !webView.url!!.startsWith(home)
        when {
          webView.canGoBack() -> webView.goBack()
          onPcPage -> webView.loadUrl("$home/?noauto=1")
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
private class ConnectFallbackClient(private val inner: WebViewClient, firstUrl: String?) : WebViewClient() {
  /** Scheme + host of the bundled Connect page (the first page the window loads). */
  var connectOrigin: String? = firstUrl?.takeIf { it.startsWith("http") }?.let { origin(Uri.parse(it)) }
    private set

  private fun origin(u: Uri) = "${u.scheme}://${u.authority}"

  override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
    if (connectOrigin == null) connectOrigin = origin(Uri.parse(url))
    inner.onPageStarted(view, url, favicon)
  }

  override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
    val home = connectOrigin
    if (request.isForMainFrame && home != null && origin(request.url) != home) {
      view.stopLoading()
      view.loadUrl("$home/?error=unreachable")
      return
    }
    inner.onReceivedError(view, request, error)
  }

  override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
    inner.shouldInterceptRequest(view, request)

  override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
    inner.shouldOverrideUrlLoading(view, request)

  override fun onPageFinished(view: WebView, url: String) = inner.onPageFinished(view, url)
}

class PairedCheck {
  @JavascriptInterface
  fun isPaired(host: String, port: Int): Boolean {
    if (!Regex("""^(10(\.\d{1,3}){3}|192\.168(\.\d{1,3}){2}|172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2})$""").matches(host) || port !in 1..65535) return false
    val cookies = CookieManager.getInstance().getCookie("http://$host:$port/") ?: return false
    return cookies.split(";").any { it.trim().startsWith("ciroom_remote=") }
  }
}
