package com.lazytest.helper

import android.app.Instrumentation
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Detect what UI framework an Android app is built with by looking at the
 * accessibility tree class names and the loaded native libraries.
 *
 * Used by `lazytest_connect` so the LLM knows whether it's looking at
 * React Native, Flutter, Compose, or classic Android Views — and can adjust
 * its element-targeting strategy accordingly (e.g. RN's testID maps to
 * resource-id, Flutter often has empty resource-ids, Compose needs
 * `testTagsAsResourceId` to surface IDs).
 */
class FrameworkDetector(private val instrumentation: Instrumentation) {

    fun detect(packageFilter: String?): JSONObject {
        val signals = mutableListOf<String>()
        val frameworks = mutableSetOf<String>()

        // 1. View-class signal — fast and reliable when an a11y tree exists.
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

        // 2. Loaded-library signal — works even when a11y tree is empty.
        val pkg = packageFilter ?: root?.packageName?.toString()
        if (pkg != null) {
            val pid = readPidOf(pkg)
            if (pid != null) {
                val libs = readMappedLibs(pid)
                for (lib in libs) {
                    when {
                        lib.contains("libflutter.so") -> {
                            frameworks.add("flutter"); signals.add("lib:libflutter.so")
                        }
                        lib.contains("libhermes") -> {
                            frameworks.add("react_native_hermes"); signals.add("lib:libhermes")
                        }
                        lib.contains("libjsc") || lib.contains("libjscexecutor") -> {
                            frameworks.add("react_native_jsc"); signals.add("lib:libjsc")
                        }
                        lib.contains("libreactnative") || lib.contains("libreactnativejni") -> {
                            frameworks.add("react_native"); signals.add("lib:libreactnative")
                        }
                    }
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
        // Restricted on user builds — best-effort, returns empty on failure.
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
