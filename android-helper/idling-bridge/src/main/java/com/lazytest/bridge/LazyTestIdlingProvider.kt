package com.lazytest.bridge

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri

/**
 * Opt-in ContentProvider that exposes app-side idle state to the LazyTest
 * helper process. Phase 3.10 of the LazyTest roadmap.
 *
 * Why a ContentProvider:
 *   - LazyTest's helper runs under the shell UID via `am instrument`, which
 *     is a separate process from the user's app. Espresso's IdlingRegistry
 *     lives in the app process, so the helper can't read it directly.
 *   - Android's Binder-based ContentResolver is the lowest-friction IPC for
 *     "read a small blob of structured data from another process". Binding
 *     AIDL services or registering broadcast receivers both require more
 *     moving parts and worse startup latency.
 *   - Queries are cheap — one Binder round-trip — so the helper can poll
 *     this from its `/wait-idle` loop without measurable overhead.
 *
 * How to use:
 *   1. Add `debugImplementation "com.lazytest:idling-bridge:1.0"` (or drop
 *      this single file into your app's debug source set).
 *   2. Optional: register custom idle sources by calling
 *      `LazyTestIdlingBridge.register(myResource)`.
 *   3. At runtime, LazyTest's helper auto-detects
 *      `content://<your-app-package>.lazytest.idling/state` and queries it
 *      once per `/wait-idle` iteration.
 *
 * The query returns a single row with these columns:
 *   - `idle_count`  (INTEGER) — number of not-yet-idle resources
 *   - `idle_names`  (TEXT)    — comma-separated names of busy resources
 *   - `version`     (INTEGER) — bridge wire-format version (currently 1)
 *
 * When idle_count == 0, the helper treats the app as idle. Any non-zero
 * value means "keep waiting" and is surfaced in the helper's waitForIdle
 * result so tests can debug who's holding things up.
 */
class LazyTestIdlingProvider : ContentProvider() {

    override fun onCreate(): Boolean = true

    override fun query(
        uri: Uri,
        projection: Array<out String>?,
        selection: String?,
        selectionArgs: Array<out String>?,
        sortOrder: String?,
    ): Cursor {
        // We ignore projection/selection — the provider has a single "row"
        // so callers never need filtering. This keeps the wire format simple
        // and avoids SQL-injection-shaped code paths.
        val busy = LazyTestIdlingBridge.collectBusy()
        val cursor = MatrixCursor(arrayOf("idle_count", "idle_names", "version"))
        cursor.addRow(arrayOf<Any>(busy.size, busy.joinToString(","), WIRE_VERSION))
        return cursor
    }

    override fun getType(uri: Uri): String = "vnd.android.cursor.item/vnd.lazytest.idle"

    // All mutations are no-ops — this provider is read-only.
    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun update(
        uri: Uri,
        values: ContentValues?,
        selection: String?,
        selectionArgs: Array<out String>?,
    ): Int = 0

    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0

    private companion object {
        private const val WIRE_VERSION = 1
    }
}
