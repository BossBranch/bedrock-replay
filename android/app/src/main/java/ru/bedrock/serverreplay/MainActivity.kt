package ru.bedrock.serverreplay

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import android.net.Uri
import android.provider.Settings
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.content.ContextCompat.startForegroundService
import androidx.core.view.ViewCompat
import java.util.Locale
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

class MainActivity : AppCompatActivity() {
    private lateinit var web: WebView
    private val handler = Handler(Looper.getMainLooper())
    private val pageOk = AtomicBoolean(false)
    private val probing = AtomicBoolean(false)
    private var attempt = 0
    private var askedOverlay = false
    private var logoDataUri: String? = null

    inner class BsrBridge {
        @JavascriptInterface
        fun enableOverlay() {
            handler.post {
                OverlayService.setDismissed(this@MainActivity, false)
                OverlayService.setStealth(this@MainActivity, false)
                ensureOverlayPermissions()
                OverlayService.start(this@MainActivity)
            }
        }

        @JavascriptInterface
        fun disableOverlay() {
            handler.post {
                OverlayService.stop(this@MainActivity)
            }
        }

        @JavascriptInterface
        fun setUiLang(lang: String) {
            handler.post {
                OverlayService.setUiLang(this@MainActivity, lang)
            }
        }

        @JavascriptInterface
        fun setProxyRunning(running: Boolean) {
            handler.post {
                try {
                    val i = Intent(this@MainActivity, HubService::class.java)
                        .setAction(HubService.ACTION_PROXY_STATE)
                        .putExtra(HubService.EXTRA_PROXY_RUNNING, running)
                    startService(i)
                } catch (_: Throwable) {}
            }
        }
    }

    private fun logoUri(): String {
        logoDataUri?.let { return it }
        val uri = try {
            // Foreground PNG only — mipmap adaptive icon decodes as a black plate + glyph.
            val bmp = BitmapFactory.decodeResource(resources, R.drawable.ic_launcher_fg)
            if (bmp != null) {
                val out = ByteArrayOutputStream()
                bmp.compress(Bitmap.CompressFormat.PNG, 92, out)
                "data:image/png;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
            } else ""
        } catch (_: Throwable) {
            ""
        }
        logoDataUri = uri
        return uri
    }

    private fun uiEn(): Boolean = Locale.getDefault().language.equals("en", ignoreCase = true)

    private fun splashHtml(): String {
        val img = logoUri().let { if (it.isNotEmpty()) """<img class="logo" src="$it" alt=""/>""" else "" }
        val msg = if (uiEn()) "Connecting to hub…" else "Подключение к хабу…"
        val hint = if (uiEn()) {
            "First launch can take up to a minute while files unpack. Please do not close the app."
        } else {
            "Первый запуск может занять до минуты — идёт распаковка. Не закрывайте приложение."
        }
        return """
            <html><head><meta charset="utf-8"/>
            <meta name="viewport" content="width=device-width, initial-scale=1"/>
            <style>
              html,body{height:100%;margin:0}
              body{
                font-family:sans-serif;background:#e8e8ea;color:#1c1c1e;
                display:flex;align-items:center;justify-content:center;
                padding:48px 28px;text-align:center;box-sizing:border-box;
              }
              .wrap{max-width:340px}
              .logo{
                width:112px;height:112px;border-radius:0;object-fit:contain;
                margin:0 auto 18px;display:block;background:transparent;
              }
              h1{margin:0 0 10px;font-size:28px;font-weight:800;letter-spacing:-0.03em;line-height:1.15}
              .by{margin:0 0 28px;font-size:15px;color:#636366;font-weight:500}
              .msg{margin:0;font-size:20px;font-weight:700;line-height:1.35;color:#1c1c1e}
              .hint{margin:18px 0 0;font-size:14px;line-height:1.45;color:#636366}
            </style></head><body>
            <div class="wrap">
              $img
              <h1>Bedrock Server Replay</h1>
              <p class="by">by BossBranch</p>
              <p class="msg">$msg</p>
              <p class="hint">$hint</p>
            </div>
            </body></html>
        """.trimIndent()
    }

    private fun failHtml(): String {
        val img = logoUri().let { if (it.isNotEmpty()) """<img class="logo" src="$it" alt=""/>""" else "" }
        val msg = if (uiEn()) {
            "Hub did not respond. Fully close the app and open it again."
        } else {
            "Хаб не ответил. Полностью закройте приложение и откройте снова."
        }
        return """
            <html><head><meta charset="utf-8"/>
            <meta name="viewport" content="width=device-width, initial-scale=1"/>
            <style>
              html,body{height:100%;margin:0}
              body{
                font-family:sans-serif;background:#e8e8ea;color:#1c1c1e;
                display:flex;align-items:center;justify-content:center;
                padding:48px 28px;text-align:center;box-sizing:border-box;
              }
              .wrap{max-width:340px}
              .logo{width:96px;height:96px;border-radius:0;object-fit:contain;margin:0 auto 16px;display:block;background:transparent}
              h1{margin:0 0 18px;font-size:26px;font-weight:800}
              p{margin:0;font-size:17px;line-height:1.45;color:#3a3a3c}
            </style></head><body>
            <div class="wrap">
              $img
              <h1>Bedrock Server Replay</h1>
              <p>$msg</p>
            </div>
            </body></html>
        """.trimIndent()
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, true)
        web = WebView(this)
        setContentView(web)
        ViewCompat.setOnApplyWindowInsetsListener(web) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }

        requestNotifPermission()
        try {
            startHubService()
        } catch (t: Throwable) {
            Toast.makeText(this, "Service: ${t.message}", Toast.LENGTH_LONG).show()
            t.printStackTrace()
        }

        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            cacheMode = WebSettings.LOAD_NO_CACHE
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            useWideViewPort = true
            loadWithOverviewMode = true
        }
        web.addJavascriptInterface(BsrBridge(), "BsrBridge")
        web.isVerticalScrollBarEnabled = true
        web.overScrollMode = android.view.View.OVER_SCROLL_IF_CONTENT_SCROLLS
        web.webChromeClient = WebChromeClient()
        web.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, url: String?) {
                if (isHubUiUrl(url)) {
                    pageOk.set(true)
                    OverlayService.start(this@MainActivity)
                }
            }

            override fun onReceivedError(
                view: WebView,
                request: WebResourceRequest,
                error: WebResourceError
            ) {
                if (!request.isForMainFrame) return
                pageOk.set(false)
                handler.post {
                    if (!isFinishing) showSplash()
                }
                scheduleProbe(400)
            }

            @Deprecated("Deprecated in Java")
            override fun onReceivedError(
                view: WebView?,
                errorCode: Int,
                description: String?,
                failingUrl: String?
            ) {
                if (!isHubUiUrl(failingUrl)) return
                pageOk.set(false)
                handler.post {
                    if (!isFinishing) showSplash()
                }
                scheduleProbe(400)
            }
        }

        showSplash()
        scheduleProbe(800)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (web.canGoBack()) web.goBack()
                else {
                    Toast.makeText(this@MainActivity, R.string.hint_bg, Toast.LENGTH_SHORT).show()
                    moveTaskToBack(true)
                }
            }
        })
    }

    override fun onResume() {
        super.onResume()
        // Activity may be destroyed while HubService keeps Node alive.
        if (pageOk.get() && isHubUiUrl(web.url)) return
        if (pageOk.get()) return
        attempt = 0
        scheduleProbe(150)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    private fun isHubUiUrl(url: String?): Boolean {
        if (url.isNullOrBlank()) return false
        return url.startsWith("http://127.0.0.1:18766") ||
            url.startsWith("http://localhost:18766")
    }

    private fun showSplash() {
        web.loadDataWithBaseURL(null, splashHtml(), "text/html", "utf-8", null)
    }

    private fun showFail() {
        web.loadDataWithBaseURL(null, failHtml(), "text/html", "utf-8", null)
    }

    private fun scheduleProbe(delayMs: Long) {
        handler.postDelayed({ probeAndLoad() }, delayMs)
    }

    /**
     * Probe HTTP API off the WebView. Keep trying until the hub UI actually paints
     * (pageOk) — a single loadUrl was not enough when returning to a destroyed Activity.
     */
    private fun probeAndLoad() {
        if (pageOk.get() || isFinishing) return
        if (!probing.compareAndSet(false, true)) return

        thread(name = "bsr-ui-probe", isDaemon = true) {
            try {
                while (!pageOk.get() && !isFinishing) {
                    attempt++
                    if (attempt > MAX_ATTEMPTS) {
                        handler.post {
                            if (!isFinishing && !pageOk.get()) showFail()
                        }
                        return@thread
                    }
                    if (isHubReady()) {
                        handler.post {
                            if (isFinishing || pageOk.get()) return@post
                            Log.i(TAG, "hub ready after $attempt probes — loading UI")
                            web.loadUrl(UI_URL)
                        }
                        // Keep looping until onPageFinished sets pageOk (or timeout)
                        Thread.sleep(900L)
                        continue
                    }
                    Thread.sleep(if (attempt < 10) 400L else 700L)
                }
            } catch (t: Throwable) {
                Log.w(TAG, "probe loop: ${t.message}")
            } finally {
                probing.set(false)
            }
        }
    }

    private fun isHubReady(): Boolean {
        var conn: HttpURLConnection? = null
        return try {
            conn = (URL(STATUS_URL).openConnection() as HttpURLConnection).apply {
                connectTimeout = 700
                readTimeout = 700
                requestMethod = "GET"
                useCaches = false
            }
            val code = conn.responseCode
            code in 200..399
        } catch (_: Throwable) {
            false
        } finally {
            try { conn?.disconnect() } catch (_: Throwable) {}
        }
    }

    private fun startHubService() {
        val i = Intent(this, HubService::class.java)
        startForegroundService(this, i)
    }

    private fun requestNotifPermission() {
        if (Build.VERSION.SDK_INT < 33) return
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
            == PackageManager.PERMISSION_GRANTED
        ) return
        ActivityCompat.requestPermissions(
            this,
            arrayOf(Manifest.permission.POST_NOTIFICATIONS),
            1001
        )
    }

    private fun ensureOverlayPermissions() {
        if (askedOverlay) return
        askedOverlay = true
        if (!Settings.canDrawOverlays(this)) {
            Toast.makeText(
                this,
                "Разреши «поверх других окон» для оверлея в Minecraft",
                Toast.LENGTH_LONG
            ).show()
            try {
                startActivity(
                    Intent(
                        Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                        Uri.parse("package:$packageName")
                    )
                )
            } catch (_: Throwable) {}
            return
        }
        if (!MinecraftForeground.hasUsageAccess(this)) {
            Toast.makeText(
                this,
                "Включи доступ к Usage — оверлей только поверх Minecraft",
                Toast.LENGTH_LONG
            ).show()
            try {
                startActivity(MinecraftForeground.usageAccessIntent())
            } catch (_: Throwable) {}
        }
    }

    companion object {
        private const val TAG = "ServerReplayUI"
        private const val UI_URL = "http://127.0.0.1:18766/"
        private const val STATUS_URL = "http://127.0.0.1:18766/api/status"
        /** ~90s: first install copies a large nodejs-project */
        private const val MAX_ATTEMPTS = 120
    }
}
