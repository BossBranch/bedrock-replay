package ru.bedrock.serverreplay

import android.content.Context
import android.media.MediaScannerConnection
import android.os.Environment
import android.provider.MediaStore
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Replays that survive app uninstall (public Documents), with fallback to app files.
 *
 * Android Documents + FUSE often hides files from [File.listFiles] / Node `readdir`
 * while the same path still opens via [File.exists]. We therefore:
 *  - probe well-known names (`Replay N.mcreplay.gz`)
 *  - keep/merge a JSON index Node always reads
 *  - optionally query MediaStore
 */
object ReplayStorage {
    private const val TAG = "BedrockHub"
    private const val FOLDER = "BedrockServerReplay"
    private const val PROBE_MAX = 80

    fun resolve(ctx: Context): File {
        val durable = File(
            Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOCUMENTS),
            "$FOLDER/replays"
        )
        val ok = try {
            if (!durable.exists()) durable.mkdirs()
            // Do NOT require list()/canWrite — both lie on Documents FUSE after reinstall.
            durable.isDirectory
        } catch (t: Throwable) {
            Log.w(TAG, "durable replays unavailable: ${t.message}")
            false
        }
        val dir = if (ok) durable else File(ctx.filesDir, "data/replays").also { it.mkdirs() }
        if (ok) migrateFromInternal(ctx, dir)
        fixPermissions(dir)
        writeNodeIndex(ctx, dir)
        scanMedia(ctx, dir)
        Log.i(TAG, "replays dir → ${dir.absolutePath}")
        return dir
    }

    private fun fixPermissions(dir: File) {
        val files = dir.listFiles() ?: return
        for (f in files) {
            if (!f.isFile) continue
            try {
                f.setReadable(true, false)
                f.setWritable(true, false)
            } catch (_: Throwable) {}
        }
    }

    private fun isReplayName(name: String): Boolean =
        name.endsWith(".mcreplay.gz", ignoreCase = true) ||
            name.endsWith(".mcreplay", ignoreCase = true)

    private fun addFile(map: LinkedHashMap<String, File>, f: File?) {
        if (f == null || !f.isFile) return
        val name = f.name
        if (!isReplayName(name)) return
        try {
            f.setReadable(true, false)
            f.setWritable(true, false)
        } catch (_: Throwable) {}
        map[name] = f
    }

    /** Discover replays without trusting a single readdir. */
    private fun discover(ctx: Context, dir: File): LinkedHashMap<String, File> {
        val map = LinkedHashMap<String, File>()

        // 1) Classic list (often incomplete / empty on Documents)
        try {
            dir.listFiles()?.forEach { addFile(map, it) }
        } catch (_: Throwable) {}

        // 2) Probe default names — open-by-path works when list does not
        for (i in 1..PROBE_MAX) {
            addFile(map, File(dir, "Replay $i.mcreplay.gz"))
            addFile(map, File(dir, "Replay_$i.mcreplay.gz"))
            for (j in 2..9) {
                addFile(map, File(dir, "Replay ${i}_$j.mcreplay.gz"))
            }
        }

        // 3) Keep previous index entries that still exist
        try {
            val prev = File(ctx.filesDir, "data/replay-index.json")
            if (prev.isFile) {
                val arr = JSONArray(prev.readText())
                for (i in 0 until arr.length()) {
                    val o = arr.optJSONObject(i) ?: continue
                    val p = o.optString("path", "")
                    if (p.isNotEmpty()) addFile(map, File(p))
                    else {
                        val n = o.optString("name", "")
                        if (n.isNotEmpty()) addFile(map, File(dir, n))
                    }
                }
            }
        } catch (_: Throwable) {}

        // 4) MediaStore (best-effort)
        try {
            val uri = MediaStore.Files.getContentUri("external")
            val proj = arrayOf(
                MediaStore.MediaColumns.DISPLAY_NAME,
                MediaStore.MediaColumns.DATA
            )
            val sel = "${MediaStore.MediaColumns.DATA} LIKE ?"
            val args = arrayOf("%/$FOLDER/replays/%")
            ctx.contentResolver.query(uri, proj, sel, args, null)?.use { c ->
                val iName = c.getColumnIndex(MediaStore.MediaColumns.DISPLAY_NAME)
                val iData = c.getColumnIndex(MediaStore.MediaColumns.DATA)
                while (c.moveToNext()) {
                    val data = if (iData >= 0) c.getString(iData) else null
                    if (!data.isNullOrEmpty()) addFile(map, File(data))
                    else if (iName >= 0) {
                        val n = c.getString(iName)
                        if (!n.isNullOrEmpty()) addFile(map, File(dir, n))
                    }
                }
            }
        } catch (t: Throwable) {
            Log.w(TAG, "MediaStore probe: ${t.message}")
        }

        return map
    }

    /**
     * Node listReplays merges this index — recovers files Documents readdir omits.
     * Written to app-private data (always readable by our Node process).
     */
    fun writeNodeIndex(ctx: Context, dir: File) {
        try {
            val found = discover(ctx, dir)
            val arr = JSONArray()
            val now = java.time.Instant.now().toString()
            for ((name, f) in found) {
                arr.put(
                    JSONObject()
                        .put("name", name)
                        .put("path", f.absolutePath)
                        .put("registeredAt", now)
                )
            }
            val out = File(ctx.filesDir, "data/replay-index.json")
            out.parentFile?.mkdirs()
            out.writeText(arr.toString(2) + "\n")
            Log.i(TAG, "replay-index.json entries=${arr.length()} (probe+list+media)")
        } catch (t: Throwable) {
            Log.w(TAG, "writeNodeIndex: ${t.message}")
        }
    }

    private fun scanMedia(ctx: Context, dir: File) {
        try {
            val paths = discover(ctx, dir).values.map { it.absolutePath }.toTypedArray()
            if (paths.isEmpty()) return
            MediaScannerConnection.scanFile(ctx, paths, null, null)
        } catch (_: Throwable) {
            // index is enough for Node
        }
    }

    /** Copy leftover internal recordings (+ sidecars) into durable storage. */
    private fun migrateFromInternal(ctx: Context, dest: File) {
        val src = File(ctx.filesDir, "data/replays")
        if (!src.isDirectory || src.absolutePath == dest.absolutePath) return
        val files = src.listFiles() ?: return
        var n = 0
        for (f in files) {
            if (!f.isFile) continue
            val name = f.name
            val isReplay = isReplayName(name)
            val isMeta = name.endsWith(".meta.json")
            if (!isReplay && !isMeta) continue
            val target = File(dest, name)
            if (target.exists() && target.length() >= f.length()) continue
            try {
                f.copyTo(target, overwrite = true)
                target.setReadable(true, false)
                target.setWritable(true, false)
                n++
            } catch (t: Throwable) {
                Log.w(TAG, "migrate ${f.name}: ${t.message}")
            }
        }
        if (n > 0) Log.i(TAG, "migrated $n file(s) → Documents/$FOLDER/replays")
    }
}
