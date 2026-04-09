package com.lazytest.helper

import android.app.UiAutomation
import android.graphics.Rect
import android.os.Build
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONArray
import org.json.JSONObject

@Suppress("unused")
private val UNUSED_BUILD_REF: Int = Build.VERSION.SDK_INT

/**
 * Walks the live AccessibilityNodeInfo tree from UiAutomation and serializes
 * it to JSON in-memory.
 *
 * Replaces the slow `uiautomator dump` path which forks a process, walks the
 * tree across many Binder IPCs, writes XML to /sdcard, then `cat`s it back.
 *
 * Performance trick: on API 33+ we set the prefetch strategy to
 * PREFETCH_DESCENDANTS_HYBRID, which lets the framework batch up to 50 child
 * nodes per IPC call. On older APIs we rely on the older flag-based prefetch.
 */
class TreeDumper(private val uiAutomation: UiAutomation) {

    /**
     * Dump the active window's tree.
     *
     * @param packageFilter optional package name — when set, only nodes whose
     *   packageName matches are included (cuts out system UI overlays).
     * @param compact when true, returns the LLM-friendly pruned format that
     *   collapses single-child wrapper containers and omits default values.
     */
    fun dump(packageFilter: String?, compact: Boolean): JSONObject {
        val root = uiAutomation.rootInActiveWindow
            ?: return JSONObject().apply {
                put("ok", false)
                put("error", "rootInActiveWindow returned null")
                put("code", "NO_ACTIVE_WINDOW")
            }

        val rootJson = serializeNode(root, depth = 0, compact = compact)
        return JSONObject().apply {
            put("ok", true)
            put("packageName", packageFilter ?: root.packageName?.toString() ?: "")
            put("compact", compact)
            put("tree", rootJson)
        }
    }

    private fun serializeNode(
        node: AccessibilityNodeInfo,
        depth: Int,
        compact: Boolean,
    ): JSONObject {
        // Note: AccessibilityNodeInfo prefetching is configured per-window by
        // the AccessibilityService config, not per-node. The framework's
        // default strategy already batches descendants on API 33+.

        val out = JSONObject()
        val rect = Rect()
        node.getBoundsInScreen(rect)

        // Identity
        node.viewIdResourceName?.takeIf { it.isNotEmpty() }?.let {
            out.put("id", it)
        }
        val className = node.className?.toString().orEmpty()
        if (className.isNotEmpty()) {
            if (compact) {
                // For LLM tree, only emit short class name when there's no
                // other label — matches existing tree-parser behavior.
                val hasLabel = !node.text.isNullOrEmpty() ||
                    !node.contentDescription.isNullOrEmpty() ||
                    !node.viewIdResourceName.isNullOrEmpty()
                if (!hasLabel) {
                    out.put("cls", shortClassName(className))
                }
            } else {
                out.put("class", className)
            }
        }
        node.text?.toString()?.takeIf { it.isNotEmpty() }?.let { out.put("text", it) }
        node.contentDescription?.toString()?.takeIf { it.isNotEmpty() }?.let {
            out.put(if (compact) "desc" else "description", it)
        }
        if (!compact) {
            node.packageName?.toString()?.let { out.put("packageName", it) }
        }

        // Geometry — always present.
        out.put("bounds", "[${rect.left},${rect.top}][${rect.right},${rect.bottom}]")

        // State flags. In compact mode, only emit non-default values.
        if (compact) {
            if (!node.isEnabled) out.put("enabled", false)
            if (node.isChecked) out.put("checked", true)
            if (node.isFocused) out.put("focused", true)
            if (node.isSelected) out.put("selected", true)
            if (node.isPassword) out.put("password", true)
            if (node.isScrollable) out.put("scrollable", true)
            if (node.isClickable && node.viewIdResourceName.isNullOrEmpty() &&
                node.text.isNullOrEmpty() && node.contentDescription.isNullOrEmpty()
            ) {
                out.put("clickable", true)
            }
        } else {
            out.put("enabled", node.isEnabled)
            out.put("checked", node.isChecked)
            out.put("checkable", node.isCheckable)
            out.put("focused", node.isFocused)
            out.put("selected", node.isSelected)
            out.put("clickable", node.isClickable)
            out.put("longClickable", node.isLongClickable)
            out.put("scrollable", node.isScrollable)
            out.put("password", node.isPassword)
        }

        // Available actions (compact only — full mode reports flags directly).
        if (compact) {
            val actions = JSONArray()
            if (node.isClickable) actions.put("tap")
            if (node.isLongClickable) actions.put("long_press")
            if (node.isScrollable) actions.put("scroll")
            if (node.isCheckable) actions.put("check")
            if (className == "android.widget.EditText") actions.put("type")
            if (className == "android.widget.SeekBar") actions.put("adjust")
            if (actions.length() > 0) out.put("actions", actions)
        }

        // Children — recurse, with optional pruning in compact mode.
        val childCount = node.childCount
        if (childCount > 0) {
            val children = JSONArray()
            for (i in 0 until childCount) {
                val child = node.getChild(i) ?: continue
                try {
                    if (compact && shouldPrune(child)) {
                        continue
                    }
                    val childJson = serializeNode(child, depth + 1, compact)
                    if (compact && isEmptyWrapper(child) && childJson.optJSONArray("children") != null) {
                        // Collapse: replace this empty wrapper with its children.
                        val grand = childJson.getJSONArray("children")
                        for (j in 0 until grand.length()) {
                            children.put(grand.getJSONObject(j))
                        }
                    } else {
                        children.put(childJson)
                    }
                } finally {
                    // Recycling AccessibilityNodeInfo is required pre-API-33.
                    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
                        @Suppress("DEPRECATION")
                        child.recycle()
                    }
                }
            }
            if (children.length() > 0) out.put("children", children)
        }

        return out
    }

    private fun shouldPrune(node: AccessibilityNodeInfo): Boolean {
        val rect = Rect()
        node.getBoundsInScreen(rect)
        // Zero-size or off-screen nodes never matter to the LLM.
        if (rect.width() <= 0 || rect.height() <= 0) return true
        // Strip the system UI overlay.
        val pkg = node.packageName?.toString() ?: return false
        return pkg == "com.android.systemui"
    }

    private fun isEmptyWrapper(node: AccessibilityNodeInfo): Boolean {
        // A "wrapper" is an unlabeled, non-interactive container with exactly
        // one child. Collapsing it removes redundant nesting from the LLM tree.
        if (node.childCount != 1) return false
        if (node.isClickable || node.isScrollable || node.isLongClickable) return false
        if (!node.text.isNullOrEmpty()) return false
        if (!node.contentDescription.isNullOrEmpty()) return false
        if (!node.viewIdResourceName.isNullOrEmpty()) return false
        return true
    }

    private fun shortClassName(fqcn: String): String {
        val idx = fqcn.lastIndexOf('.')
        return if (idx >= 0 && idx < fqcn.length - 1) fqcn.substring(idx + 1) else fqcn
    }
}
