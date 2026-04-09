// Top-level build file. Plugin versions are declared here for the root project
// and applied with `apply false` so subprojects can opt in.
plugins {
    id("com.android.application") version "8.5.2" apply false
    // `com.android.library` is provided by the same AGP version as
    // `com.android.application`. Declared here so the idling-bridge module
    // (Phase 3.10) can apply it without redeclaring the version.
    id("com.android.library") version "8.5.2" apply false
    id("org.jetbrains.kotlin.android") version "1.9.25" apply false
}
