package ru.bedrock.serverreplay

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.Rect
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import kotlin.math.abs
import kotlin.math.min

/**
 * Floating Minecraft-only control bubble (LIVE record / PLAY replay).
 * Idle bubble = app icon; LIVE/PLAY keep text glyphs. Panel sits below bubble.
 */
class OverlayService : Service() {
    companion object {
        private const val TAG = "BedrockOverlay"
        private const val PREFS = "bsr_overlay"
        private const val KEY_DISMISSED = "dismissed"
        private const val KEY_STEALTH = "stealth"
        private const val KEY_X = "x"
        private const val KEY_Y = "y"
        private const val KEY_LANG = "ui_lang"
        private const val API = "http://127.0.0.1:18766"
        const val ACTION_REFRESH = "ru.bedrock.serverreplay.OVERLAY_REFRESH"

        fun prefs(ctx: Context): SharedPreferences =
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

        fun isDismissed(ctx: Context): Boolean =
            prefs(ctx).getBoolean(KEY_DISMISSED, false)

        fun setDismissed(ctx: Context, v: Boolean) {
            prefs(ctx).edit().putBoolean(KEY_DISMISSED, v).apply()
        }

        fun isStealth(ctx: Context): Boolean =
            prefs(ctx).getBoolean(KEY_STEALTH, false)

        fun setStealth(ctx: Context, v: Boolean) {
            prefs(ctx).edit().putBoolean(KEY_STEALTH, v).apply()
        }

        fun getUiLang(ctx: Context): String {
            val v = prefs(ctx).getString(KEY_LANG, null)
            return if (v == "en") "en" else "ru"
        }

        fun setUiLang(ctx: Context, lang: String) {
            val v = if (lang == "en") "en" else "ru"
            prefs(ctx).edit().putString(KEY_LANG, v).apply()
            try {
                ctx.startService(
                    Intent(ctx, OverlayService::class.java).setAction(ACTION_REFRESH)
                )
            } catch (_: Throwable) {}
        }

        fun start(ctx: Context) {
            if (isDismissed(ctx)) return
            if (!android.provider.Settings.canDrawOverlays(ctx)) return
            ctx.startService(Intent(ctx, OverlayService::class.java))
        }

        fun stop(ctx: Context) {
            ctx.stopService(Intent(ctx, OverlayService::class.java))
        }
    }

    private lateinit var wm: WindowManager
    private lateinit var bubble: FrameLayout
    private lateinit var bubbleIcon: ImageView
    private lateinit var bubbleLabel: TextView
    private lateinit var panel: LinearLayout
    private lateinit var bubbleParams: WindowManager.LayoutParams
    private lateinit var panelParams: WindowManager.LayoutParams

    private val handler = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()
    private var expanded = false
    private var stealth = false
    private var lastMode = "idle"
    private var lastRecording = false
    private var lastChromeKey = ""
    private var lastHandshakeBusy = false
    private var lastHubLobby = false
    private var lastPlayJson: JSONObject? = null
    private var lastReplays: JSONArray = JSONArray()
    private var recordingFileHint: String? = null
    private var recordingElapsedMs = 0L
    private var timerView: TextView? = null
    private var lastStructureKey: String = ""
    /** Two-step play: first tap selects, second confirms. */
    private var pendingReplayName: String? = null
    private var pendingReplayLabel: String? = null
    private var playHint: String? = null
    private var lastLang = "ru"
    private var activeReplayBase: String? = null

    private fun uiEn(): Boolean = getUiLang(this) == "en"

    private fun t(key: String): String {
        val en = uiEn()
        return when (key) {
            "hide" -> if (en) "hide" else "скрыть"
            "recording" -> if (en) "Recording" else "Запись"
            "stop" -> if (en) "Stop" else "Стоп"
            "startRec" -> if (en) "Start recording" else "Старт записи"
            "replay" -> if (en) "Replay" else "Реплей"
            "replayPaused" -> if (en) "Replay · paused" else "Реплей · пауза"
            "toSpawn" -> if (en) "To spawn" else "К спавну"
            "restart" -> if (en) "Restart" else "Рестарт"
            "menu" -> if (en) "Menu" else "Меню"
            "nowPlaying" -> if (en) "Now:" else "Сейчас:"
            "replays" -> if (en) "Replays" else "Реплеи"
            "empty" -> if (en) "Empty" else "Пока пусто"
            "play" -> if (en) "▶ Play" else "▶ Запуск"
            "cancel" -> if (en) "Cancel" else "Отмена"
            "joinPlay" -> if (en) "Join 127.0.0.1:19133" else "Зайди на 127.0.0.1:19133"
            "sec" -> if (en) "s" else "с"
            "saved" -> if (en) "Recording saved" else "Запись сохранена"
            "already" -> if (en) "Already recording" else "Уже пишем"
            "started" -> if (en) "Recording started" else "Запись началась"
            "needLive" -> if (en) "Join LIVE first" else "Сначала зайди на LIVE"
            "inPlay" -> if (en) "In replay — .live then retry" else "Сейчас реплей — .live и снова"
            "notRec" -> if (en) "Not recording" else "Сейчас не пишем"
            "errPrefix" -> if (en) "Error: " else "Ошибка: "
            "noHub" -> if (en) "No hub response" else "Нет ответа от хаба"
            "failed" -> if (en) "Failed" else "Не удалось"
            else -> key
        }
    }

    private val tick = object : Runnable {
        override fun run() {
            refreshVisibilityAndState()
            // Slow down while Minecraft is handshaking (Node sets handshakeBusy)
            val delay = if (lastHandshakeBusy) 2000L else 1000L
            handler.postDelayed(this, delay)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        stealth = isStealth(this)
        wm = getSystemService(WINDOW_SERVICE) as WindowManager
        buildViews()
        addBubble()
        applyStealthVisual()
        handler.post(tick)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (isDismissed(this)) {
            stopSelf()
            return START_NOT_STICKY
        }
        if (intent?.action == ACTION_REFRESH) {
            lastLang = getUiLang(this)
            lastStructureKey = ""
            if (expanded) {
                rebuildPanelContent()
                positionPanelBesideBubble()
            }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        handler.removeCallbacks(tick)
        try { wm.removeView(bubble) } catch (_: Throwable) {}
        try { if (panel.parent != null) wm.removeView(panel) } catch (_: Throwable) {}
        MinecraftForeground.clearSticky()
        io.shutdownNow()
        super.onDestroy()
    }

    private fun dp(v: Float): Int =
        TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, resources.displayMetrics).toInt()

    private fun overlayType(): Int =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        else
            @Suppress("DEPRECATION")
            WindowManager.LayoutParams.TYPE_PHONE

    private fun baseFlags(): Int =
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
            WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN

    private fun roundBg(color: Int, radiusDp: Float, alpha: Int = 210): GradientDrawable {
        return GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            cornerRadius = dp(radiusDp).toFloat()
            setColor(Color.argb(alpha, Color.red(color), Color.green(color), Color.blue(color)))
        }
    }

    private fun outlineBg(fill: Int, stroke: Int, radiusDp: Float): GradientDrawable {
        return GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            cornerRadius = dp(radiusDp).toFloat()
            setColor(fill)
            setStroke(dp(1.2f), stroke)
        }
    }

    private fun fmtClock(ms: Long): String {
        val total = (ms / 1000).coerceAtLeast(0)
        val m = total / 60
        val s = total % 60
        return if (m > 0) "%d:%02d".format(m, s) else "${s}${t("sec")}"
    }

    private fun roundAppIconBitmap(): Bitmap? {
        return try {
            val src = BitmapFactory.decodeResource(resources, R.drawable.ic_launcher_fg) ?: return null
            // Adaptive-icon FG has dark padding; use the inner safe zone only.
            val side = min(src.width, src.height)
            val inset = (side * 0.20f).toInt().coerceAtLeast(1)
            val inner = (side - inset * 2).coerceAtLeast(8)
            val cropped = Bitmap.createBitmap(src, inset, inset, inner, inner)
            val outSize = dp(88f).coerceAtLeast(88)
            val scaled = Bitmap.createScaledBitmap(cropped, outSize, outSize, true)
            val out = Bitmap.createBitmap(outSize, outSize, Bitmap.Config.ARGB_8888)
            val canvas = Canvas(out)
            val paint = Paint(Paint.ANTI_ALIAS_FLAG)
            canvas.drawCircle(outSize / 2f, outSize / 2f, outSize / 2f, paint)
            paint.xfermode = PorterDuffXfermode(PorterDuff.Mode.SRC_IN)
            canvas.drawBitmap(scaled, Rect(0, 0, outSize, outSize), Rect(0, 0, outSize, outSize), paint)
            if (cropped !== src) cropped.recycle()
            if (scaled !== cropped) scaled.recycle()
            src.recycle()
            out
        } catch (_: Throwable) {
            null
        }
    }

    private fun buildViews() {
        bubbleIcon = ImageView(this).apply {
            val round = roundAppIconBitmap()
            if (round != null) setImageBitmap(round)
            else setImageResource(R.drawable.ic_launcher_fg)
            scaleType = ImageView.ScaleType.CENTER_CROP
            setBackgroundColor(Color.TRANSPARENT)
            layoutParams = FrameLayout.LayoutParams(dp(44f), dp(44f), Gravity.CENTER)
            alpha = 0.72f
            clipToOutline = true
            outlineProvider = object : android.view.ViewOutlineProvider() {
                override fun getOutline(view: View, outline: android.graphics.Outline) {
                    outline.setOval(0, 0, view.width, view.height)
                }
            }
        }
        bubbleLabel = TextView(this).apply {
            text = ""
            setTextColor(Color.WHITE)
            typeface = Typeface.create("sans-serif-medium", Typeface.BOLD)
            textSize = 12f
            gravity = Gravity.CENTER
            visibility = View.GONE
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
        }
        bubble = FrameLayout(this).apply {
            addView(bubbleIcon)
            addView(bubbleLabel)
            alpha = 0.96f
        }

        val prefs = prefs(this)
        val savedX = prefs.getInt(KEY_X, -1)
        val savedY = prefs.getInt(KEY_Y, -1)
        bubbleParams = WindowManager.LayoutParams(
            dp(44f), dp(44f),
            overlayType(),
            baseFlags(),
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = if (savedX >= 0) savedX else dp(12f)
            y = if (savedY >= 0) savedY else dp(160f)
        }

        var downX = 0f
        var downY = 0f
        var startX = 0
        var startY = 0
        var moved = false
        bubble.setOnTouchListener { _, ev ->
            when (ev.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downX = ev.rawX
                    downY = ev.rawY
                    startX = bubbleParams.x
                    startY = bubbleParams.y
                    moved = false
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = (ev.rawX - downX).toInt()
                    val dy = (ev.rawY - downY).toInt()
                    if (!moved && abs(dx) + abs(dy) > dp(6f)) {
                        moved = true
                        // While dragging: hide panel so it cannot cover the bubble / steal taps
                        if (expanded) collapsePanel(remove = true)
                    }
                    if (moved) {
                        val maxX = (resources.displayMetrics.widthPixels - bubbleParams.width).coerceAtLeast(0)
                        val maxY = (resources.displayMetrics.heightPixels - bubbleParams.height).coerceAtLeast(0)
                        bubbleParams.x = (startX + dx).coerceIn(0, maxX)
                        bubbleParams.y = (startY + dy).coerceIn(0, maxY)
                        try { wm.updateViewLayout(bubble, bubbleParams) } catch (_: Throwable) {}
                    }
                    true
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    prefs.edit().putInt(KEY_X, bubbleParams.x).putInt(KEY_Y, bubbleParams.y).apply()
                    if (!moved && ev.actionMasked == MotionEvent.ACTION_UP) {
                        if (stealth) {
                            // Invisible hit-target → restore normal bubble, then open panel
                            setStealthMode(false)
                            togglePanel()
                        } else {
                            togglePanel()
                        }
                    }
                    true
                }
                else -> false
            }
        }

        panel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = roundBg(0x1A2420, 12f, 235)
            setPadding(dp(8f), dp(8f), dp(8f), dp(8f))
            elevation = dp(6f).toFloat()
            visibility = View.GONE
        }
        panelParams = WindowManager.LayoutParams(
            dp(188f),
            WindowManager.LayoutParams.WRAP_CONTENT,
            overlayType(),
            baseFlags(),
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.TOP or Gravity.START
        }
    }

    private fun addBubble() {
        try {
            wm.addView(bubble, bubbleParams)
            bubble.visibility = View.GONE
        } catch (_: Throwable) {}
    }

    /**
     * Place panel next to the bubble without covering it.
     * Never clamp the panel back onto the bubble when the bubble is at a screen edge
     * (old clampX/clampY did that). Prefer off-screen clip over overlap.
     */
    private fun positionPanelBesideBubble() {
        val gap = dp(10f)
        val pad = dp(4f)
        val panelW = panelParams.width
        val screenW = resources.displayMetrics.widthPixels
        val screenH = resources.displayMetrics.heightPixels

        panel.measure(
            View.MeasureSpec.makeMeasureSpec(panelW, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED)
        )
        val panelH = panel.measuredHeight.coerceAtLeast(dp(60f))

        val bubbleL = bubbleParams.x
        val bubbleR = bubbleParams.x + bubbleParams.width
        val bubbleT = bubbleParams.y
        val bubbleB = bubbleParams.y + bubbleParams.height

        fun overlaps(px: Int, py: Int): Boolean {
            val pR = px + panelW
            val pB = py + panelH
            // Keep a gap: treat near-touch as overlap
            return px < bubbleR + gap && pR > bubbleL - gap &&
                py < bubbleB + gap && pB > bubbleT - gap
        }

        fun mostlyOnScreen(px: Int, py: Int): Boolean {
            val visibleW = minOf(px + panelW, screenW - pad) - maxOf(px, pad)
            val visibleH = minOf(py + panelH, screenH - pad) - maxOf(py, pad)
            return visibleW >= panelW / 2 && visibleH >= panelH / 3
        }

        // X under/over bubble: nudge to stay mostly on screen, but Y is fixed so no bubble cover.
        fun xAlongBubble(): Int {
            val prefer = bubbleL
            val minX = pad
            val maxX = (screenW - panelW - pad).coerceAtLeast(minX)
            return prefer.coerceIn(minX, maxX)
        }

        val belowY = bubbleB + gap
        val aboveY = bubbleT - panelH - gap
        val rightX = bubbleR + gap
        val leftX = bubbleL - panelW - gap

        data class Spot(val x: Int, val y: Int)
        val spots = ArrayList<Spot>(8)

        // 1) Below / above — Y never clamped into the bubble
        if (belowY + panelH <= screenH - pad) spots.add(Spot(xAlongBubble(), belowY))
        if (aboveY >= pad) spots.add(Spot(xAlongBubble(), aboveY))
        // Still offer below/above even if clipped (better than covering the circle)
        spots.add(Spot(xAlongBubble(), belowY))
        spots.add(Spot(xAlongBubble(), aboveY))

        // 2) Beside — X fixed off the bubble; Y follows bubble but must not overlap
        fun yBeside(): Int {
            val minY = pad
            val maxY = (screenH - panelH - pad).coerceAtLeast(minY)
            var y = bubbleT.coerceIn(minY, maxY)
            // If clamping Y pulled us over the bubble, park fully below or above instead
            if (overlaps(rightX, y) || overlaps(leftX, y)) {
                y = when {
                    belowY + panelH <= screenH - pad -> belowY
                    aboveY >= pad -> aboveY
                    else -> y
                }
            }
            return y
        }
        val ySide = yBeside()
        spots.add(Spot(rightX, ySide))
        spots.add(Spot(leftX, ySide))
        spots.add(Spot(rightX, bubbleT))
        spots.add(Spot(leftX, bubbleT))

        val pick = spots.firstOrNull { !overlaps(it.x, it.y) && mostlyOnScreen(it.x, it.y) }
            ?: spots.firstOrNull { !overlaps(it.x, it.y) }
            ?: Spot(xAlongBubble(), belowY)

        panelParams.x = pick.x
        panelParams.y = pick.y

        // Absolute last resort: shove completely below or above (may clip off-screen)
        if (overlaps(panelParams.x, panelParams.y)) {
            panelParams.x = xAlongBubble()
            panelParams.y = if (bubbleB + gap + panelH <= screenH) bubbleB + gap
            else bubbleT - panelH - gap
        }

        try {
            if (panel.parent != null) wm.updateViewLayout(panel, panelParams)
        } catch (_: Throwable) {}
    }

    private fun collapsePanel(remove: Boolean) {
        expanded = false
        panel.visibility = View.GONE
        if (remove) {
            try { if (panel.parent != null) wm.removeView(panel) } catch (_: Throwable) {}
        }
    }

    /** Panel is added after the bubble → it steals taps if rects overlap. Keep bubble on top. */
    private fun bringBubbleToFront() {
        try {
            if (bubble.parent != null) {
                wm.removeView(bubble)
                wm.addView(bubble, bubbleParams)
            }
        } catch (_: Throwable) {}
    }

    private fun togglePanel() {
        if (expanded) {
            collapsePanel(remove = true)
            return
        }
        expanded = true
        rebuildPanelContent()
        positionPanelBesideBubble()
        try {
            if (panel.parent == null) wm.addView(panel, panelParams)
            else wm.updateViewLayout(panel, panelParams)
            panel.visibility = View.VISIBLE
            bringBubbleToFront()
            panel.post {
                positionPanelBesideBubble()
                bringBubbleToFront()
            }
        } catch (_: Throwable) {
            expanded = false
        }
    }

    private fun makeBtn(
        label: String,
        fill: Int = 0x2F9E5F,
        outlined: Boolean = false,
        onClick: () -> Unit
    ): TextView {
        return TextView(this).apply {
            text = label
            setTextColor(if (outlined) Color.parseColor("#C5D0CA") else Color.WHITE)
            textSize = 11f
            typeface = Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
            background = if (outlined) {
                outlineBg(Color.argb(28, 255, 255, 255), Color.parseColor("#6A7A72"), 8f)
            } else {
                roundBg(fill, 8f, 255)
            }
            setPadding(dp(6f), dp(6f), dp(6f), dp(6f))
            val lp = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
            lp.topMargin = dp(4f)
            layoutParams = lp
            setOnClickListener { onClick() }
        }
    }

    private fun makeRow(vararg labels: Pair<String, () -> Unit>): LinearLayout {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).also { it.topMargin = dp(4f) }
        }
        labels.forEachIndexed { i, (text, click) ->
            val b = makeBtn(text, onClick = click)
            val lp = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
            if (i > 0) lp.marginStart = dp(4f)
            lp.topMargin = 0
            b.layoutParams = lp
            row.addView(b)
        }
        return row
    }

    private fun title(text: String): TextView =
        TextView(this).apply {
            this.text = text
            setTextColor(Color.WHITE)
            textSize = 12f
            typeface = Typeface.DEFAULT_BOLD
        }

    private fun sub(text: String): TextView =
        TextView(this).apply {
            this.text = text
            setTextColor(Color.parseColor("#B8C4BE"))
            textSize = 10f
            setPadding(0, dp(2f), 0, dp(1f))
            maxLines = 1
            ellipsize = android.text.TextUtils.TruncateAt.END
        }

    private fun headerRow(titleText: String): LinearLayout {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
        }
        row.addView(
            title(titleText).apply {
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
            }
        )
        row.addView(
            TextView(this).apply {
                text = t("hide")
                setTextColor(Color.parseColor("#E8EFEC"))
                textSize = 11f
                typeface = Typeface.DEFAULT_BOLD
                gravity = Gravity.CENTER
                background = outlineBg(
                    Color.argb(40, 255, 255, 255),
                    Color.parseColor("#6A7A72"),
                    8f
                )
                setPadding(dp(8f), dp(4f), dp(8f), dp(4f))
                layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT
                )
                setOnClickListener {
                    // Soft-hide: invisible but tappable hit target (not full dismiss)
                    collapsePanel(remove = true)
                    setStealthMode(true)
                }
            }
        )
        return row
    }

    private fun structureKey(): String {
        val p = lastPlayJson
        return listOf(
            lastMode,
            lastRecording.toString(),
            lastHubLobby.toString(),
            recordingFileHint.orEmpty(),
            (p?.optBoolean("paused") == true).toString(),
            p?.optString("fileName").orEmpty(),
            (p?.optDouble("speed", 1.0) ?: 1.0).toString(),
            lastReplays.length().toString(),
            pendingReplayName.orEmpty(),
            playHint.orEmpty(),
            activeReplayBase.orEmpty(),
            getUiLang(this)
        ).joinToString("|")
    }

    private fun fmtWhen(isoOrMs: String?): String {
        if (isoOrMs.isNullOrBlank()) return ""
        return try {
            val ms = when {
                isoOrMs.all { it.isDigit() } -> isoOrMs.toLong()
                else -> {
                    // ISO-8601 → epoch via simple parse of yyyy-MM-ddTHH:mm
                    val m = Regex("""(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})""").find(isoOrMs)
                    if (m != null) {
                        val (y, mo, d, h, mi) = m.destructured
                        java.util.Calendar.getInstance().apply {
                            set(y.toInt(), mo.toInt() - 1, d.toInt(), h.toInt(), mi.toInt(), 0)
                            set(java.util.Calendar.MILLISECOND, 0)
                        }.timeInMillis
                    } else return ""
                }
            }
            val cal = java.util.Calendar.getInstance().apply { timeInMillis = ms }
            "%02d.%02d %02d:%02d".format(
                cal.get(java.util.Calendar.DAY_OF_MONTH),
                cal.get(java.util.Calendar.MONTH) + 1,
                cal.get(java.util.Calendar.HOUR_OF_DAY),
                cal.get(java.util.Calendar.MINUTE)
            )
        } catch (_: Throwable) {
            ""
        }
    }

    private fun updateTimerOnly() {
        val tv = timerView ?: return
        when {
            lastMode == "live" && lastRecording -> tv.text = fmtClock(recordingElapsedMs)
            lastMode == "play" -> {
                val p = lastPlayJson
                val t = p?.optLong("t") ?: 0L
                val dur = p?.optLong("durationMs") ?: 0L
                val spd = p?.optDouble("speed", 1.0) ?: 1.0
                tv.text = "${fmtClock(t)} / ${fmtClock(dur)} · ×$spd"
            }
        }
    }

    private fun rebuildPanelContent() {
        panel.removeAllViews()
        timerView = null
        lastStructureKey = structureKey()
        when {
            lastMode == "live" && lastRecording -> {
                panel.addView(headerRow(t("recording")))
                timerView = sub(fmtClock(recordingElapsedMs)).also { panel.addView(it) }
                if (!recordingFileHint.isNullOrBlank()) {
                    panel.addView(sub(recordingFileHint!!))
                }
                panel.addView(makeBtn(t("stop"), onClick = {
                    postApi("/api/overlay/record/stop") { r ->
                        toastRecord(r, stop = true)
                    }
                }))
                addReplayPicker()
            }
            lastMode == "live" -> {
                panel.addView(headerRow("LIVE"))
                panel.addView(makeBtn(t("startRec"), onClick = {
                    postApi("/api/overlay/record/start") { r ->
                        toastRecord(r, stop = false)
                    }
                }))
                addReplayPicker()
            }
            lastMode == "play" -> {
                val p = lastPlayJson
                val paused = p?.optBoolean("paused") == true
                val file = p?.optString("fileName")?.ifBlank { "—" } ?: "—"
                val tMs = p?.optLong("t") ?: 0L
                val dur = p?.optLong("durationMs") ?: 0L
                val spd = p?.optDouble("speed", 1.0) ?: 1.0
                panel.addView(headerRow(if (paused) t("replayPaused") else t("replay")))
                timerView = sub("${fmtClock(tMs)} / ${fmtClock(dur)} · ×$spd").also { panel.addView(it) }
                panel.addView(sub(file))
                panel.addView(
                    makeBtn(if (paused) "▶" else "❚❚", onClick = {
                        postApi("/api/overlay/play/toggle")
                    })
                )
                panel.addView(
                    makeRow(
                        "0.5×" to { postApi("/api/overlay/play/speed", """{"speed":0.5}""") },
                        "1×" to { postApi("/api/overlay/play/speed", """{"speed":1}""") },
                        "2×" to { postApi("/api/overlay/play/speed", """{"speed":2}""") }
                    )
                )
                panel.addView(
                    makeRow(
                        "−10" to { postApi("/api/overlay/play/seek", """{"deltaMs":-10000}""") },
                        "+10" to { postApi("/api/overlay/play/seek", """{"deltaMs":10000}""") }
                    )
                )
                panel.addView(makeBtn(t("toSpawn"), fill = 0x5C6B64, onClick = {
                    postApi("/api/overlay/play/spawn")
                }))
                panel.addView(makeBtn(t("restart"), onClick = { postApi("/api/overlay/play/restart") }))
            }
            else -> {
                panel.addView(headerRow(t("menu")))
                val playing = activeReplayBase
                if (!playing.isNullOrBlank()) {
                    panel.addView(sub("${t("nowPlaying")} $playing"))
                }
                addReplayPicker(showSectionTitle = false)
            }
        }
    }

    private fun addReplayPicker(showSectionTitle: Boolean = true) {
        if (showSectionTitle) panel.addView(sub(t("replays")))
        if (lastReplays.length() == 0) {
            panel.addView(sub(t("empty")))
            return
        }
        val selected = pendingReplayName
        if (!selected.isNullOrBlank()) {
            panel.addView(sub(pendingReplayLabel ?: selected))
            val actions = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT
                ).also { it.topMargin = dp(4f) }
            }
            val play = makeBtn(t("play"), fill = 0x2F6F9E, onClick = {
                val name = pendingReplayName ?: return@makeBtn
                pendingReplayName = null
                pendingReplayLabel = null
                playHint = null
                postApi(
                    "/api/overlay/play/file",
                    """{"name":${JSONObject.quote(name)}}"""
                ) { json ->
                    if (json?.optBoolean("queued") == true) {
                        playHint = t("joinPlay")
                        lastStructureKey = ""
                        if (expanded) rebuildPanelContent()
                    }
                }
            })
            val cancel = makeBtn(t("cancel"), outlined = true, onClick = {
                pendingReplayName = null
                pendingReplayLabel = null
                lastStructureKey = ""
                if (expanded) rebuildPanelContent()
            })
            val lpPlay = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1.2f)
            lpPlay.topMargin = 0
            play.layoutParams = lpPlay
            val lpCancel = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
            lpCancel.topMargin = 0
            lpCancel.marginStart = dp(5f)
            cancel.layoutParams = lpCancel
            actions.addView(play)
            actions.addView(cancel)
            panel.addView(actions)
        }
        if (!playHint.isNullOrBlank()) {
            panel.addView(sub(playHint!!))
        }
        val scroll = ScrollView(this).apply {
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                dp(110f)
            ).also { it.topMargin = dp(2f) }
        }
        val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        for (i in 0 until lastReplays.length()) {
            val r = lastReplays.optJSONObject(i) ?: continue
            val base = r.optString("base").ifBlank { r.optString("name") }
            val name = r.optString("name")
            val dur = r.optLong("durationMs", -1)
            val whenStr = fmtWhen(r.optString("mtime").ifBlank { null })
            val bits = mutableListOf<String>()
            if (whenStr.isNotEmpty()) bits.add(whenStr)
            if (dur > 0) bits.add(fmtClock(dur))
            val label = if (bits.isEmpty()) base else "$base · ${bits.joinToString(" · ")}"
            val isSel = name == selected
            col.addView(
                TextView(this).apply {
                    text = if (isSel) "● $label" else label
                    setTextColor(Color.WHITE)
                    textSize = 11f
                    maxLines = 2
                    ellipsize = android.text.TextUtils.TruncateAt.END
                    setPadding(dp(6f), dp(6f), dp(6f), dp(6f))
                    background = roundBg(if (isSel) 0x2F9E5F else 0x2A3832, 7f, 255)
                    val lp = LinearLayout.LayoutParams(
                        LinearLayout.LayoutParams.MATCH_PARENT,
                        LinearLayout.LayoutParams.WRAP_CONTENT
                    )
                    lp.topMargin = if (i == 0) 0 else dp(3f)
                    layoutParams = lp
                    setOnClickListener {
                        pendingReplayName = name
                        pendingReplayLabel = base
                        playHint = null
                        lastStructureKey = ""
                        if (expanded) rebuildPanelContent()
                    }
                }
            )
        }
        scroll.addView(col)
        panel.addView(scroll)
    }

    private fun setStealthMode(on: Boolean) {
        stealth = on
        setStealth(this, on)
        applyStealthVisual()
    }

    /** Fully transparent hit target — still receives taps; drag still works. */
    private fun applyStealthVisual() {
        if (!::bubble.isInitialized) return
        if (stealth) {
            bubble.alpha = 0.02f
            bubbleIcon.alpha = 0f
            bubbleLabel.alpha = 0f
            bubble.setBackgroundColor(Color.TRANSPARENT)
        } else {
            // Force chrome re-apply on next state tick
            lastChromeKey = ""
            applyOverlayChrome(
                lastMode,
                lastRecording,
                lastHubLobby,
                lastPlayJson,
                lastReplays,
                recordingElapsedMs,
                recordingFileHint,
                activeReplayBase
            )
        }
    }

    private fun refreshVisibilityAndState() {
        val show = !isDismissed(this) &&
            MinecraftForeground.isMinecraftForeground(this)
        val want = if (show) View.VISIBLE else View.GONE
        if (bubble.visibility != want) bubble.visibility = want
        if (show) applyStealthVisual()
        if (!show && expanded) {
            collapsePanel(remove = true)
        } else if (show && expanded && panel.parent != null) {
            if (panel.visibility != View.VISIBLE) panel.visibility = View.VISIBLE
            // Do NOT bringBubbleToFront here — remove/add every poll makes the icon blink
        }
        io.execute {
            val json = getJson("$API/api/overlay/state")
            handler.post {
                if (json == null) {
                    applyOverlayChrome(
                        mode = "idle",
                        recording = false,
                        hubLobby = false,
                        playJson = null,
                        replays = JSONArray(),
                        elapsed = 0,
                        fileHint = null,
                        activeReplay = null
                    )
                    return@post
                }
                if (!json.optBoolean("overlayControls", true)) {
                    stopSelf()
                    return@post
                }
                val hubUp = json.optBoolean("hubRunning", false)
                val liveConn = json.optBoolean("liveConnected", false)
                val playConn = json.optBoolean("playConnected", false)
                var mode = if (hubUp) json.optString("mode", "idle") else "idle"
                if (!liveConn && !playConn) mode = "idle"
                val recording = hubUp && liveConn && json.optBoolean("recording", false)
                lastHandshakeBusy = json.optBoolean("handshakeBusy", false)
                val hubLobby = hubUp && liveConn && json.optBoolean("hubLobby", false)
                val playJson = if (mode == "play" && playConn) json.optJSONObject("play") else null
                val replays = json.optJSONArray("replays") ?: JSONArray()
                val elapsed = json.optLong("recordingElapsedMs", 0)
                val fileHint = json.optString("recordingFile").ifBlank { null }
                val activeReplay = json.optString("activeReplay").ifBlank { null }
                applyOverlayChrome(mode, recording, hubLobby, playJson, replays, elapsed, fileHint, activeReplay)
            }
        }
    }

    private fun applyOverlayChrome(
        mode: String,
        recording: Boolean,
        hubLobby: Boolean,
        playJson: JSONObject?,
        replays: JSONArray,
        elapsed: Long,
        fileHint: String?,
        activeReplay: String?
    ) {
        val useAppIcon = mode == "idle" && !recording
        val chromeKey = "$useAppIcon|$mode|$recording|$stealth"
        if (chromeKey != lastChromeKey) {
            lastChromeKey = chromeKey
            if (stealth) {
                bubbleIcon.visibility = View.VISIBLE
                bubbleLabel.visibility = View.GONE
                bubble.setBackgroundColor(Color.TRANSPARENT)
                bubble.alpha = 0.02f
                bubbleIcon.alpha = 0f
                bubbleLabel.alpha = 0f
            } else if (useAppIcon) {
                bubbleIcon.visibility = View.VISIBLE
                bubbleLabel.visibility = View.GONE
                bubble.setBackgroundColor(Color.TRANSPARENT)
                bubble.alpha = 0.72f
                bubbleIcon.alpha = 0.72f
            } else {
                bubbleIcon.visibility = View.GONE
                bubbleLabel.visibility = View.VISIBLE
                bubble.alpha = 0.96f
                bubbleIcon.alpha = 1f
                val color = when {
                    recording -> 0xC23B2A
                    mode == "play" -> 0x1F8A5A
                    mode == "live" -> 0x2F6F9E
                    else -> 0x5C6B64
                }
                bubble.background = roundBg(color, 22f, 200)
                bubbleLabel.text = when {
                    recording -> "●"
                    mode == "play" -> "▶"
                    mode == "live" -> "REC"
                    else -> ""
                }
            }
        }

        lastMode = mode
        lastRecording = recording
        lastHubLobby = hubLobby
        lastPlayJson = playJson
        lastReplays = replays
        recordingElapsedMs = elapsed
        recordingFileHint = fileHint
        activeReplayBase = activeReplay

        if (expanded) {
            val key = structureKey()
            if (key != lastStructureKey) {
                rebuildPanelContent()
                positionPanelBesideBubble()
                panel.post {
                    positionPanelBesideBubble()
                    bringBubbleToFront()
                }
            } else {
                updateTimerOnly()
            }
        }
    }

    private fun toastRecord(r: JSONObject?, stop: Boolean) {
        val ok = r?.optBoolean("ok") == true
        val err = r?.optString("error").orEmpty()
        val msg = when {
            ok && stop -> t("saved")
            ok && r?.optBoolean("already") == true -> t("already")
            ok -> t("started")
            err == "not_connected" -> t("needLive")
            err == "in_play" -> t("inPlay")
            err == "not_recording" -> t("notRec")
            err.isNotBlank() -> t("errPrefix") + err
            r == null -> t("noHub")
            else -> t("failed")
        }
        try {
            android.widget.Toast.makeText(this, msg, android.widget.Toast.LENGTH_SHORT).show()
        } catch (_: Throwable) {}
        lastStructureKey = ""
    }

    private fun postApi(
        path: String,
        body: String = "{}",
        onResult: ((JSONObject?) -> Unit)? = null
    ) {
        io.execute {
            var parsed: JSONObject? = null
            try {
                val conn = (URL("$API$path").openConnection() as HttpURLConnection).apply {
                    requestMethod = "POST"
                    connectTimeout = 2000
                    readTimeout = 8000
                    doOutput = true
                    setRequestProperty("Content-Type", "application/json")
                }
                conn.outputStream.use { it.write(body.toByteArray()) }
                val code = conn.responseCode
                val text = (if (code in 200..299) conn.inputStream else conn.errorStream)
                    ?.bufferedReader()?.readText()
                conn.disconnect()
                if (!text.isNullOrBlank()) parsed = JSONObject(text)
                Log.i(TAG, "POST $path → $code ${text?.take(120)}")
            } catch (t: Throwable) {
                Log.w(TAG, "POST $path fail: ${t.message}")
            }
            handler.post {
                onResult?.invoke(parsed)
                refreshVisibilityAndState()
            }
        }
    }

    private fun getJson(url: String): JSONObject? {
        return try {
            val conn = (URL(url).openConnection() as HttpURLConnection).apply {
                connectTimeout = 800
                readTimeout = 1500
                requestMethod = "GET"
            }
            val code = conn.responseCode
            val text = (if (code in 200..299) conn.inputStream else conn.errorStream)
                ?.bufferedReader()?.readText() ?: return null
            conn.disconnect()
            JSONObject(text)
        } catch (_: Throwable) {
            null
        }
    }
}
