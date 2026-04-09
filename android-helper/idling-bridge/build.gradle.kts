plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

// ---------------------------------------------------------------------------
// LazyTest Idling Bridge
//
// Opt-in library (Phase 3.10) that app authors add to their debug builds so
// the LazyTest helper can query app-side idle state from outside the app
// process. Without this library, the helper relies purely on accessibility
// events; with it, the helper can also ask "does the app have any pending
// Espresso IdlingResources / in-flight network requests / pending coroutine
// dispatches?" before declaring idle.
//
// Distribution: users add `debugImplementation files('path/to/lazytest-idling-bridge.aar')`
// or copy the single Kotlin file (LazyTestIdlingProvider.kt) into their debug
// source set. The library is < 5 KB — smaller than the Gradle wrapper itself.
//
// Runtime: the library registers a ContentProvider with authority
// `<app-package>.lazytest.idling` that responds to queries with a single
// row containing `idle_count` (number of not-yet-idle resources) and
// `idle_names` (comma-separated names).
//
// This is the same pattern Espresso's IdlingRegistry exposes internally, but
// bridged to a cross-process URI. Release builds don't need the library —
// if the provider isn't registered, the helper falls through to its
// accessibility-event idle path.
// ---------------------------------------------------------------------------

android {
    namespace = "com.lazytest.bridge"
    compileSdk = 34

    defaultConfig {
        minSdk = 24
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    // No external dependencies. The bridge reads Espresso's IdlingRegistry
    // purely via reflection (`Class.forName("androidx.test.espresso.IdlingRegistry")`)
    // so consumers that use Espresso get auto-bridging without us declaring
    // a dependency, and consumers that don't use Espresso can still register
    // custom `LazyTestIdlingBridge.IdleSource` implementations.
}
