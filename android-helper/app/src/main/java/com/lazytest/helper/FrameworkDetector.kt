package com.lazytest.helper

import android.app.Instrumentation
import android.content.pm.PackageManager
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Detect what UI framework an Android app is built with by examining:
 *
 *   1. The accessibility tree's class names (fast path; works when RN/
 *      Flutter/Compose have published a populated a11y tree — breaks down
 *      with modern RN Fabric, which flattens React views into plain
 *      Android widgets so no `ReactViewGroup` class names surface).
 *
 *   2. The installed app's native library directory via
 *      `PackageManager.getApplicationInfo(pkg).nativeLibraryDir`. This is
 *      an APK-bundled `lib/<abi>/` path that the helper can `list()` with
 *      shell UID permissions on essentially every API level, without
 *      needing PTRACE_MODE_READ for another process's `/proc/<pid>/maps`.
 *      SELinux on API 34+ emulators (sdk_gphone64_arm64 API 36 in
 *      particular) blocks shell UID from reading other apps' /proc/maps,
 *      which made the previous approach silently return empty.
 *
 *   3. (Legacy fallback only) /proc/<pid>/maps for running processes, kept
 *      as a best-effort third signal on builds where it happens to work.
 *
 * Used by `lazytest_connect` so the LLM knows whether it's looking at
 * React Native, Flutter, Compose, or classic Android Views — and can adjust
 * its element-targeting strategy accordingly (e.g. RN's testID maps to
 * resource-id, Flutter often has empty resource-ids, Compose needs
 * `testTagsAsResourceId` to surface IDs).
 *
 * Even when all on-device signals fail, the host-side `connect.ts` runs a
 * Metro `/json/list` probe as a final positive-ID check for React Native,
 * so framework detection as a whole has three layered fallbacks.
 */
class FrameworkDetector(private val instrumentation: Instrumentation) {

    fun detect(packageFilter: String?): JSONObject {
        val signals = mutableListOf<String>()
        val frameworks = mutableSetOf<String>()

        // 1. View-class signal — fast and reliable when an a11y tree exists
        //    AND the app surfaces framework-specific class names. RN Fabric
        //    builds often fail this check because the renderer flattens
        //    views, so this is best-effort.
        val root = instrumentation.uiAutomation.rootInActiveWindow
        if (root != null) {
            val classNames = mutableSetOf<String>()
            collectClassNames(root, classNames, depth = 0, maxDepth = MAX_TREE_DEPTH)
            for (cls in classNames) {
                when {
                    cls.contains("FlutterView") || cls.contains("FlutterSurfaceView") -> {
                        frameworks.add("flutter"); signals.add("class:$cls")
                    }
                    cls.contains("ReactRootView") || cls.contains("ReactViewGroup") ||
                        cls.contains("RCTView") -> {
                        frameworks.add("react_native"); signals.add("class:$cls")
                    }
                    cls.contains("AndroidComposeView") -> {
                        frameworks.add("compose"); signals.add("class:$cls")
                    }
                }
            }
        }

        val pkg = packageFilter ?: root?.packageName?.toString()

        // 2. PackageManager.nativeLibraryDir signal — preferred over
        //    /proc/<pid>/maps because it doesn't require the app to be
        //    running AND doesn't require PTRACE_MODE_READ on another
        //    process. The lib dir is a world-readable path owned by the
        //    system so shell UID can list it on any modern API level.
        if (pkg != null) {
            try {
                val appInfo = instrumentation.targetContext.packageManager
                    .getApplicationInfo(pkg, 0)
                val libDir = appInfo.nativeLibraryDir
                if (libDir != null) {
                    val files = File(libDir).list() ?: emptyArray()
                    for (name in files) {
                        matchLibName(name, frameworks, signals, source = "nativeLib")
                    }
                }
            } catch (_: PackageManager.NameNotFoundException) {
                // package not installed — ignore
            } catch (_: Throwable) {
                // any other failure (permission, IO) is best-effort
            }
        }

        // 3. Legacy /proc/<pid>/maps scan — kept as a third signal for the
        //    builds where it still works. Silently no-ops on API 34+ where
        //    shell UID can't read other apps' /proc entries.
        if (pkg != null && !frameworks.any { it.startsWith("react_native") || it == "flutter" }) {
            val pid = readPidOf(pkg)
            if (pid != null) {
                val libs = readMappedLibs(pid)
                for (lib in libs) {
                    matchLibName(lib, frameworks, signals, source = "procMaps")
                }
            }
        }

        // Normalize: if we found any RN variant, the umbrella is "react_native"
        if (frameworks.any { it.startsWith("react_native") }) {
            frameworks.add("react_native")
        }
        // If nothing matched, classify as native.
        val primary = when {
            frameworks.contains("flutter") -> "flutter"
            frameworks.contains("react_native") -> "react_native"
            frameworks.contains("compose") -> "compose"
            else -> "native"
        }

        val signalArr = JSONArray()
        signals.forEach { signalArr.put(it) }
        val frameworkArr = JSONArray()
        frameworks.forEach { frameworkArr.put(it) }

        return JSONObject().apply {
            put("ok", true)
            put("packageName", pkg ?: "")
            put("primary", primary)
            put("frameworks", frameworkArr)
            put("signals", signalArr)
        }
    }

    /**
     * Shared lib-name matcher used by both the `nativeLibraryDir` scan and
     * the legacy `/proc/<pid>/maps` scan. Keeps the framework-identification
     * strings centralized so adding a new framework takes one edit.
     */
    private fun matchLibName(
        name: String,
        frameworks: MutableSet<String>,
        signals: MutableList<String>,
        source: String,
    ) {
        when {
            name.contains("libflutter.so") -> {
                frameworks.add("flutter"); signals.add("$source:libflutter.so")
            }
            name.contains("libhermes") -> {
                frameworks.add("react_native_hermes"); signals.add("$source:libhermes")
            }
            name.contains("libjsc") -> {
                frameworks.add("react_native_jsc"); signals.add("$source:libjsc")
            }
            name.contains("libreactnative") -> {
                frameworks.add("react_native"); signals.add("$source:libreactnative")
            }
        }
    }

    private fun collectClassNames(
        node: AccessibilityNodeInfo,
        out: MutableSet<String>,
        depth: Int,
        maxDepth: Int,
    ) {
        if (depth > maxDepth) return
        node.className?.toString()?.let { out.add(it) }
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            try {
                collectClassNames(child, out, depth + 1, maxDepth)
            } finally {
                if (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.TIRAMISU) {
                    @Suppress("DEPRECATION")
                    child.recycle()
                }
            }
        }
    }

    private fun readPidOf(packageName: String): Int? {
        // /proc/<pid>/cmdline contains the package name for app processes.
        // May or may not be readable depending on SELinux policy — callers
        // treat a null result as "just use the nativeLibraryDir signal".
        val procDir = File("/proc")
        val children = procDir.listFiles { f -> f.isDirectory && f.name.all { it.isDigit() } }
            ?: return null
        for (dir in children) {
            try {
                val cmd = File(dir, "cmdline").readText().trim('\u0000', ' ', '\n')
                if (cmd == packageName || cmd.startsWith("$packageName:")) {
                    return dir.name.toInt()
                }
            } catch (_: Throwable) {
                // /proc entries vanish — ignore
            }
        }
        return null
    }

    private fun readMappedLibs(pid: Int): Set<String> {
        // /proc/<pid>/maps lists every mapped object including .so files.
        // Blocked by yama ptrace_scope / SELinux on API 34+ for shell UID
        // reading another app's maps — returns empty on permission failure.
        val out = HashSet<String>()
        try {
            File("/proc/$pid/maps").useLines { lines ->
                for (line in lines) {
                    val idx = line.lastIndexOf(' ')
                    if (idx >= 0) {
                        val path = line.substring(idx + 1)
                        if (path.endsWith(".so")) {
                            out.add(path.substringAfterLast('/'))
                        }
                    }
                }
            }
        } catch (_: Throwable) {
            // ignore
        }
        return out
    }

    private companion object {
        private const val MAX_TREE_DEPTH = 6
    }
}
