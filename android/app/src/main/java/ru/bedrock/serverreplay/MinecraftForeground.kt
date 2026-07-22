package ru.bedrock.serverreplay

import android.app.AppOpsManager
import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Process
import android.provider.Settings

/**
 * Detect whether Minecraft PE (or known Bedrock clients) is the foreground app.
 *
 * UsageStats often stops emitting ACTIVITY_RESUMED while Minecraft stays on screen
 * (Play menu → worlds/servers → in-game). We keep a sticky last-known package so the
 * overlay does not vanish mid-session, and only hide when another app clearly resumes.
 */
object MinecraftForeground {
    private val MC_PACKAGES = setOf(
        "com.mojang.minecraftpe",
        "com.mojang.minecraftpe.unlock",
        "com.mojang.minecraftworlds",
        // Bedrock Preview / alternate store builds
        "com.mojang.minecraftpe.beta",
        "com.mojang.minecraftpe.preview"
    )

    /** Last package that was observed as foreground (resume). */
    @Volatile
    private var stickyPkg: String? = null

    fun hasUsageAccess(context: Context): Boolean {
        return try {
            val appOps = context.getSystemService(Context.APP_OPS_SERVICE) as AppOpsManager
            val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                appOps.unsafeCheckOpNoThrow(
                    AppOpsManager.OPSTR_GET_USAGE_STATS,
                    Process.myUid(),
                    context.packageName
                )
            } else {
                @Suppress("DEPRECATION")
                appOps.checkOpNoThrow(
                    AppOpsManager.OPSTR_GET_USAGE_STATS,
                    Process.myUid(),
                    context.packageName
                )
            }
            mode == AppOpsManager.MODE_ALLOWED
        } catch (_: Throwable) {
            false
        }
    }

    fun usageAccessIntent(): Intent =
        Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS)

    /** @return true if a known Minecraft package is the foreground app */
    fun isMinecraftForeground(context: Context): Boolean {
        if (!hasUsageAccess(context)) return false
        return try {
            val fromEvents = foregroundFromEvents(context)
            when {
                fromEvents == null -> {
                    // No resume events — try stats, else sticky (fullscreen MC / menu)
                    val fromStats = foregroundFromUsageStats(context)
                    if (fromStats != null && fromStats != context.packageName) {
                        stickyPkg = fromStats
                        return isMinecraftPackage(fromStats)
                    }
                    isMinecraftPackage(stickyPkg)
                }
                // Peeking at our UI / overlay — do not clear sticky MC
                fromEvents == context.packageName -> isMinecraftPackage(stickyPkg)
                else -> {
                    stickyPkg = fromEvents
                    isMinecraftPackage(fromEvents)
                }
            }
        } catch (_: Throwable) {
            isMinecraftPackage(stickyPkg)
        }
    }

    private fun foregroundFromEvents(context: Context): String? {
        val usm = context.getSystemService(Context.USAGE_STATS_SERVICE) as UsageStatsManager
        val end = System.currentTimeMillis()
        // Long window: MC may not emit new resume events for minutes in menu/game.
        val begin = end - 10 * 60_000L
        val events = usm.queryEvents(begin, end)
        val ev = UsageEvents.Event()
        var lastResumePkg: String? = null
        var lastResumeTime = 0L
        while (events.hasNextEvent()) {
            events.getNextEvent(ev)
            val t = ev.timeStamp
            val isResume =
                ev.eventType == UsageEvents.Event.ACTIVITY_RESUMED ||
                    ev.eventType == UsageEvents.Event.MOVE_TO_FOREGROUND
            if (isResume && t >= lastResumeTime) {
                lastResumeTime = t
                lastResumePkg = ev.packageName
            }
        }
        return lastResumePkg
    }

    /** Fallback when events are empty/sparse. */
    private fun foregroundFromUsageStats(context: Context): String? {
        val usm = context.getSystemService(Context.USAGE_STATS_SERVICE) as UsageStatsManager
        val end = System.currentTimeMillis()
        val begin = end - 10 * 60_000L
        val stats = usm.queryUsageStats(UsageStatsManager.INTERVAL_BEST, begin, end)
            ?: return null
        if (stats.isEmpty()) return null
        val top = stats.maxByOrNull { it.lastTimeUsed } ?: return null
        if (top.packageName == context.packageName) {
            return stats
                .filter { it.packageName != context.packageName }
                .maxByOrNull { it.lastTimeUsed }
                ?.packageName
        }
        return top.packageName
    }

    fun isMinecraftPackage(pkg: String?): Boolean =
        pkg != null && MC_PACKAGES.contains(pkg)

    fun clearSticky() {
        stickyPkg = null
    }
}
