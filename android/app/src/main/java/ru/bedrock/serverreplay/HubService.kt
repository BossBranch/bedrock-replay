package ru.bedrock.serverreplay

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.os.Process
import android.util.Log
import androidx.core.app.NotificationCompat
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

class HubService : Service() {
    companion object {
        private const val TAG = "BedrockHub"
        const val CHANNEL_ID = "bsr_hub"
        const val NOTIF_ID = 42
        const val ACTION_STOP = "ru.bedrock.serverreplay.STOP"
        const val ACTION_PROXY_STATE = "ru.bedrock.serverreplay.PROXY_STATE"
        const val EXTRA_PROXY_RUNNING = "proxy_running"
        private val nodeStarted = AtomicBoolean(false)

        @Volatile
        var projectDir: File? = null
            private set

        @Volatile
        var lastError: String? = null
            private set

        @Volatile
        var proxyRunning: Boolean = false
            private set
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            shutdownEverything("stop")
            return START_NOT_STICKY
        }
        if (intent?.action == ACTION_PROXY_STATE) {
            proxyRunning = intent.getBooleanExtra(EXTRA_PROXY_RUNNING, false)
            updateNotif(
                if (proxyRunning) getString(R.string.notif_running)
                else getString(R.string.notif_idle)
            )
            return START_STICKY
        }

        try {
            ensureChannel()
            startForeground(
                NOTIF_ID,
                buildNotification(
                    if (proxyRunning) getString(R.string.notif_running)
                    else getString(R.string.notif_idle)
                )
            )
        } catch (t: Throwable) {
            Log.e(TAG, "startForeground failed", t)
            lastError = t.message
        }

        if (nodeStarted.compareAndSet(false, true)) {
            Thread({
                try {
                    Log.i(TAG, "loading native libs…")
                    NodeBridge
                    Log.i(TAG, "copying node project…")
                    val dir = NodeProject.ensureCopied(this)
                    projectDir = dir
                    val data = File(filesDir, "data").apply { mkdirs() }
                    val mainJs = File(dir, "src/mobileMain.js")
                    if (!mainJs.exists()) {
                        throw IllegalStateException("missing ${mainJs.absolutePath}")
                    }
                    Log.i(TAG, "start node ${mainJs.absolutePath}")
                    NativeEnv.put("BEDROCK_REPLAY_ROOT", dir.absolutePath)
                    NativeEnv.put("BEDROCK_REPLAY_DATA", data.absolutePath)
                    NativeEnv.put("BEDROCK_REPLAY_REPLAYS", ReplayStorage.resolve(this@HubService).absolutePath)
                    NativeEnv.put("BEDROCK_REPLAY_MOBILE", "1")
                    NativeEnv.put("BEDROCK_REPLAY_API_PORT", "18766")
                    NativeEnv.put("HOME", filesDir.absolutePath)
                    NativeEnv.put("TMPDIR", cacheDir.absolutePath)
                    updateNotif(getString(R.string.notif_idle))
                    // Restore bubble if overlay already permitted (no Settings storm on first launch)
                    Thread({
                        try {
                            Thread.sleep(2000)
                            OverlayService.start(this@HubService)
                        } catch (_: Throwable) {}
                    }, "overlay-boot").start()
                    val code = NodeBridge.startNodeWithArguments(arrayOf("node", mainJs.absolutePath))
                    Log.w(TAG, "node exited code=$code")
                    lastError = "node exited $code"
                    nodeStarted.set(false)
                    proxyRunning = false
                    try { OverlayService.stop(this@HubService) } catch (_: Throwable) {}
                    updateNotif("Остановлен ($code)")
                } catch (t: Throwable) {
                    Log.e(TAG, "hub failed", t)
                    lastError = t.message
                    nodeStarted.set(false)
                    proxyRunning = false
                    try { OverlayService.stop(this@HubService) } catch (_: Throwable) {}
                    updateNotif("Ошибка: ${t.message}")
                }
            }, "nodejs-hub").start()
        }
        return START_STICKY
    }

    /**
     * User swiped the app away from recents → stop proxy + kill process.
     * Back button uses moveTaskToBack and does NOT call this (proxy stays for Minecraft).
     */
    override fun onTaskRemoved(rootIntent: Intent?) {
        Log.i(TAG, "onTaskRemoved — stopping proxy and exiting")
        shutdownEverything("task_removed")
        super.onTaskRemoved(rootIntent)
    }

    private fun shutdownEverything(reason: String) {
        try { OverlayService.stop(this) } catch (_: Throwable) {}
        proxyRunning = false
        thread(name = "hub-shutdown") {
            try {
                val url = URL("http://127.0.0.1:18766/api/stop")
                (url.openConnection() as HttpURLConnection).apply {
                    requestMethod = "POST"
                    connectTimeout = 1500
                    readTimeout = 2000
                    doOutput = true
                    setRequestProperty("Content-Type", "application/json")
                    outputStream.use { it.write("{}".toByteArray()) }
                    responseCode
                    disconnect()
                }
            } catch (_: Throwable) {}
            try {
                stopForeground(STOP_FOREGROUND_REMOVE)
            } catch (_: Throwable) {}
            try {
                stopSelf()
            } catch (_: Throwable) {}
            // Node runs in-process — kill whole app so ports 19132/19133 truly stop
            try {
                Thread.sleep(200)
            } catch (_: Throwable) {}
            Log.i(TAG, "killProcess reason=$reason")
            Process.killProcess(Process.myPid())
        }
    }

    private fun updateNotif(text: String) {
        try {
            val mgr = getSystemService(NotificationManager::class.java)
            mgr.notify(NOTIF_ID, buildNotification(text))
        } catch (_: Throwable) {}
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val mgr = getSystemService(NotificationManager::class.java)
        val ch = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.notif_channel),
            NotificationManager.IMPORTANCE_LOW
        )
        mgr.createNotificationChannel(ch)
    }

    private fun buildNotification(text: String): Notification {
        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val stopPi = PendingIntent.getService(
            this, 1,
            Intent(this, HubService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(text)
            .setSmallIcon(R.drawable.ic_stat_play)
            .setContentIntent(open)
            .setOngoing(proxyRunning)
            .addAction(0, getString(R.string.notif_stop), stopPi)
            .build()
    }
}
