package ru.bedrock.serverreplay

import android.content.Context
import android.util.Log
import java.io.File
import java.io.FileOutputStream

object NodeProject {
    private const val TAG = "BedrockHub"
    private const val PREFS = "bsr_node"
    private const val KEY_APK_TS = "apk_last_update"

    fun ensureCopied(ctx: Context): File {
        val dest = File(ctx.filesDir, "nodejs-project")
        val apkTs = ctx.packageManager.getPackageInfo(ctx.packageName, 0).lastUpdateTime
        val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val prev = prefs.getLong(KEY_APK_TS, -1L)
        if (dest.exists() && prev == apkTs && File(dest, "src/mobileMain.js").exists()) {
            Log.i(TAG, "nodejs-project already copied")
            return dest
        }
        Log.i(TAG, "copying nodejs-project from assets…")
        if (dest.exists()) dest.deleteRecursively()
        dest.mkdirs()
        copyAssetFolder(ctx, "nodejs-project", dest)
        prefs.edit().putLong(KEY_APK_TS, apkTs).apply()
        Log.i(TAG, "copy done → ${dest.absolutePath}")
        return dest
    }

    private fun copyAssetFolder(ctx: Context, assetPath: String, dest: File) {
        val am = ctx.assets
        val kids = try {
            am.list(assetPath)
        } catch (e: Exception) {
            null
        }
        if (kids == null || kids.isEmpty()) {
            dest.parentFile?.mkdirs()
            am.open(assetPath).use { input ->
                FileOutputStream(dest).use { output -> input.copyTo(output, 64 * 1024) }
            }
            return
        }
        dest.mkdirs()
        for (name in kids) {
            copyAssetFolder(ctx, "$assetPath/$name", File(dest, name))
        }
    }
}
