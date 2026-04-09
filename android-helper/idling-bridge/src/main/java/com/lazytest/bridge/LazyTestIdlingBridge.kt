package com.lazytest.bridge

/**
 * In-process registry of "things that must be idle before tests can proceed."
 *
 * The LazyTest helper queries this through `LazyTestIdlingProvider` via
 * `ContentResolver.query(content://<app-package>.lazytest.idling/state)`.
 * Everything in here runs on whatever thread the ContentProvider is called
 * on (usually a Binder thread), so the collection and `IdleSource`
 * implementations must be thread-safe.
 *
 * Design notes:
 *   - Espresso's `IdlingRegistry` is the de-facto standard on Android, and
 *     we auto-bridge it reflectively: if the app already uses Espresso,
 *     every registered `IdlingResource` is visible to LazyTest with zero
 *     additional code.
 *   - Apps that DON'T use Espresso (or want to expose bespoke sources
 *     without depending on androidx.test) can register lightweight
 *     `IdleSource` instances directly via `register()`.
 *   - All calls are best-effort: a NoClassDefFoundError on the Espresso
 *     reflection path is caught and ignored so the bridge still works in
 *     apps with zero testing dependencies.
 */
object LazyTestIdlingBridge {

    /**
     * Minimal idle-source interface. Implement this when you want to expose
     * an idle signal without depending on `androidx.test.espresso`.
     */
    interface IdleSource {
        /** Short human-readable name — shown in LazyTest's busy report. */
        val name: String

        /** True if this source has no outstanding work. */
        fun isIdleNow(): Boolean
    }

    private val sources = mutableListOf<IdleSource>()

    /**
     * Register a custom idle source. Calls are idempotent — registering
     * the same instance twice is a no-op.
     */
    @Synchronized
    fun register(source: IdleSource) {
        if (sources.none { it === source }) {
            sources.add(source)
        }
    }

    /** Unregister a previously-registered source. */
    @Synchronized
    fun unregister(source: IdleSource) {
        sources.removeAll { it === source }
    }

    /**
     * Walk both the Espresso `IdlingRegistry` (if present) and any
     * directly-registered sources. Returns the names of every source that
     * reports NOT idle.
     *
     * This is called synchronously from the ContentProvider's `query()`
     * method, so it must not block. All `isIdleNow()` implementations
     * should be O(1).
     */
    @Synchronized
    fun collectBusy(): List<String> {
        val busy = mutableListOf<String>()

        // Bespoke sources first — cheapest path.
        for (source in sources) {
            try {
                if (!source.isIdleNow()) busy.add(source.name)
            } catch (t: Throwable) {
                busy.add("${source.name}(error:${t.message})")
            }
        }

        // Espresso registry — best-effort reflection. The class may not be
        // on the classpath in apps that don't depend on Espresso, so every
        // failure is swallowed.
        try {
            val registryClass = Class.forName("androidx.test.espresso.IdlingRegistry")
            val instance = registryClass.getMethod("getInstance").invoke(null)
            val resources = registryClass
                .getMethod("getResources")
                .invoke(instance) as? Collection<*>
                ?: return busy

            for (resource in resources) {
                if (resource == null) continue
                val name = safeInvokeString(resource, "getName") ?: resource.javaClass.simpleName
                val idle = safeInvokeBoolean(resource, "isIdleNow") ?: true
                if (!idle) busy.add(name)
            }
        } catch (_: ClassNotFoundException) {
            // Espresso not present — skip.
        } catch (t: Throwable) {
            busy.add("espresso-bridge-error:${t.javaClass.simpleName}")
        }

        return busy
    }

    private fun safeInvokeString(target: Any, method: String): String? {
        return try {
            target.javaClass.getMethod(method).invoke(target) as? String
        } catch (_: Throwable) {
            null
        }
    }

    private fun safeInvokeBoolean(target: Any, method: String): Boolean? {
        return try {
            target.javaClass.getMethod(method).invoke(target) as? Boolean
        } catch (_: Throwable) {
            null
        }
    }
}
