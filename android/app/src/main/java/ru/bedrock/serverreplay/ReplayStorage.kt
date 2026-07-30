package ru.bedrock.serverreplay

import android.content.ContentUris
import android.content.Context
import android.net.Uri
import android.os.Environment
import android.provider.MediaStore
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream

/**
 * Replay storage that embedded Node can always read/write.
 *
 * Public Documents/ often returns EACCES for the Node process on Android 10+.
 * Primary: app-internal filesDir/data/replays. Recover old files via File + MediaStore.
 */
object ReplayStorage {
    private const val TAG = "BedrockHub"
    private const val FOLDER = "BedrockServerReplay"
    private const val PROBE_MAX = 80

    private val pendingUris = HashMap<String, Uri>()

    fun resolve(ctx: Context): File {
        val primary = File(ctx.filesDir, "data/replays").also { it.mkdirs() }

        migrateInto(ctx, ctx.getExternalFilesDir("replays"), primary)
        migrateInto(
            ctx,
            File(
                Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOCUMENTS),
                "$FOLDER/replays"
            ),
            primary
        )
        migrateInto(ctx, File(ctx.filesDir, "replays"), primary)

        fixPermissions(primary)
        writeNodeIndex(ctx, primary)
        Log.i(TAG, "replays dir → ${primary.absolutePath}")
        return primary
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
        val prev = map[name]
        if (prev == null || f.length() >= prev.length()) map[name] = f
    }

    private fun scanDir(map: LinkedHashMap<String, File>, d: File?) {
        if (d == null || !d.isDirectory) return
        try {
            d.listFiles()?.forEach { addFile(map, it) }
        } catch (_: Throwable) {}
        for (i in 1..PROBE_MAX) {
            addFile(map, File(d, "Replay $i.mcreplay.gz"))
            addFile(map, File(d, "Replay_$i.mcreplay.gz"))
            for (j in 2..9) {
                addFile(map, File(d, "Replay ${i}_$j.mcreplay.gz"))
            }
        }
    }

    private fun discover(ctx: Context, dir: File): LinkedHashMap<String, File> {
        val map = LinkedHashMap<String, File>()
        scanDir(map, dir)
        scanDir(map, ctx.getExternalFilesDir("replays"))
        scanDir(map, File(ctx.filesDir, "replays"))
        scanDir(
            map,
            File(
                Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOCUMENTS),
                "$FOLDER/replays"
            )
        )

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
                        if (n.isNotEmpty()) {
                            addFile(map, File(dir, n))
                            addFile(map, File(ctx.filesDir, "data/replays/$n"))
                            ctx.getExternalFilesDir("replays")?.let { addFile(map, File(it, n)) }
                        }
                    }
                }
            }
        } catch (_: Throwable) {}

        try {
            val collection = MediaStore.Files.getContentUri("external")
            val proj = arrayOf(
                MediaStore.MediaColumns._ID,
                MediaStore.MediaColumns.DISPLAY_NAME,
                MediaStore.MediaColumns.DATA
            )
            val sel = "${MediaStore.MediaColumns.DATA} LIKE ?"
            val args = arrayOf("%/$FOLDER/replays/%")
            ctx.contentResolver.query(collection, proj, sel, args, null)?.use { c ->
                val iId = c.getColumnIndex(MediaStore.MediaColumns._ID)
                val iName = c.getColumnIndex(MediaStore.MediaColumns.DISPLAY_NAME)
                val iData = c.getColumnIndex(MediaStore.MediaColumns.DATA)
                while (c.moveToNext()) {
                    val name = if (iName >= 0) c.getString(iName) else null
                    val data = if (iData >= 0) c.getString(iData) else null
                    if (!data.isNullOrEmpty()) addFile(map, File(data))
                    if (!name.isNullOrEmpty() && isReplayName(name) && iId >= 0) {
                        pendingUris[name] = ContentUris.withAppendedId(collection, c.getLong(iId))
                        if (!map.containsKey(name)) {
                            map[name] = File(dir, name)
                        }
                    }
                }
            }
        } catch (t: Throwable) {
            Log.w(TAG, "MediaStore probe: ${t.message}")
        }

        return map
    }

    private fun copyBytes(ctx: Context, src: File, dest: File): Boolean {
        if (src.absolutePath == dest.absolutePath) return dest.exists() && dest.length() > 0
        try {
            if (src.isFile && src.canRead() && src.length() > 0) {
                FileInputStream(src).use { input ->
                    FileOutputStream(dest).use { output -> input.copyTo(output, 64 * 1024) }
                }
                if (dest.exists() && dest.length() > 0) return true
            }
        } catch (t: Throwable) {
            Log.w(TAG, "file copy ${src.name}: ${t.message}")
        }
        try {
            val collection = MediaStore.Files.getContentUri("external")
            val sel = "${MediaStore.MediaColumns.DATA}=?"
            val args = arrayOf(src.absolutePath)
            ctx.contentResolver.query(
                collection,
                arrayOf(MediaStore.MediaColumns._ID),
                sel,
                args,
                null
            )?.use { c ->
                if (c.moveToFirst()) {
                    val contentUri = ContentUris.withAppendedId(collection, c.getLong(0))
                    ctx.contentResolver.openInputStream(contentUri)?.use { input ->
                        FileOutputStream(dest).use { output -> input.copyTo(output, 64 * 1024) }
                    }
                    if (dest.exists() && dest.length() > 0) return true
                }
            }
        } catch (t: Throwable) {
            Log.w(TAG, "resolver path copy ${src.name}: ${t.message}")
        }
        try {
            val u = pendingUris[src.name] ?: pendingUris[dest.name]
            if (u != null) {
                ctx.contentResolver.openInputStream(u)?.use { input ->
                    FileOutputStream(dest).use { output -> input.copyTo(output, 64 * 1024) }
                }
                if (dest.exists() && dest.length() > 0) return true
            }
        } catch (t: Throwable) {
            Log.w(TAG, "resolver uri copy ${src.name}: ${t.message}")
        }
        return false
    }

    fun writeNodeIndex(ctx: Context, dir: File) {
        pendingUris.clear()
        try {
            val found = discover(ctx, dir)
            val arr = JSONArray()
            val now = java.time.Instant.now().toString()
            for ((name, f) in found) {
                val local = File(dir, name)
                if (!local.exists() || local.length() == 0L ||
                    (f.exists() && f.length() > local.length() && f.absolutePath != local.absolutePath)
                ) {
                    copyBytes(ctx, f, local)
                }
                if (!local.exists() || local.length() == 0L) {
                    try {
                        val u = pendingUris[name]
                        if (u != null) {
                            ctx.contentResolver.openInputStream(u)?.use { input ->
                                FileOutputStream(local).use { output ->
                                    input.copyTo(output, 64 * 1024)
                                }
                            }
                        }
                    } catch (t: Throwable) {
                        Log.w(TAG, "uri salvage $name: ${t.message}")
                    }
                }
                if (!local.exists() || local.length() == 0L) {
                    Log.w(TAG, "skip unreadable replay $name")
                    continue
                }
                try {
                    local.setReadable(true, false)
                    local.setWritable(true, false)
                } catch (_: Throwable) {}
                arr.put(
                    JSONObject()
                        .put("name", name)
                        .put("path", local.absolutePath)
                        .put("registeredAt", now)
                )
            }
            val out = File(ctx.filesDir, "data/replay-index.json")
            out.parentFile?.mkdirs()
            out.writeText(arr.toString(2) + "\n")
            Log.i(TAG, "replay-index.json entries=${arr.length()} dir=${dir.absolutePath}")
        } catch (t: Throwable) {
            Log.w(TAG, "writeNodeIndex: ${t.message}")
        } finally {
            pendingUris.clear()
        }
    }

    private fun migrateInto(ctx: Context, src: File?, dest: File) {
        if (src == null) return
        if (src.absolutePath == dest.absolutePath) return
        var n = 0
        val names = LinkedHashSet<String>()
        try {
            src.listFiles()?.forEach { f -> if (f.isFile) names.add(f.name) }
        } catch (_: Throwable) {}
        for (i in 1..PROBE_MAX) {
            names.add("Replay $i.mcreplay.gz")
            names.add("Replay_$i.mcreplay.gz")
            for (j in 2..9) names.add("Replay ${i}_$j.mcreplay.gz")
        }
        for (name in names) {
            val isReplay = isReplayName(name)
            val isMeta = name.endsWith(".meta.json", ignoreCase = true)
            if (!isReplay && !isMeta) continue
            val from = File(src, name)
            val target = File(dest, name)
            if (target.exists() && target.length() > 0) {
                if (!from.exists() || target.length() >= from.length()) continue
            }
            if (copyBytes(ctx, from, target)) {
                n++
                if (isReplay) {
                    val metaName = name
                        .replace(Regex("\\.mcreplay\\.gz$", RegexOption.IGNORE_CASE), ".meta.json")
                        .replace(Regex("\\.mcreplay$", RegexOption.IGNORE_CASE), ".meta.json")
                    if (metaName != name) {
                        val metaDst = File(dest, metaName)
                        if (!metaDst.exists() || metaDst.length() == 0L) {
                            copyBytes(ctx, File(src, metaName), metaDst)
                        }
                    }
                }
            }
        }
        if (n > 0) Log.i(TAG, "migrated $n file(s) → ${dest.absolutePath}")
    }
}
