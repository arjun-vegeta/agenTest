plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.lazytest.helper"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.lazytest.helper"
        minSdk = 24
        targetSdk = 34
        // versionCode is bumped when the helper protocol or behavior changes;
        // the TypeScript installer compares this against the on-device value to
        // decide whether to reinstall.
        versionCode = 1
        versionName = "1.0.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
        }
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    // The test APK builds against `androidTest`. We don't have any *unit* tests
    // (the helper itself is the test APK).
    sourceSets {
        getByName("androidTest") {
            java.srcDirs("src/androidTest/java")
            manifest.srcFile("src/androidTest/AndroidManifest.xml")
        }
    }

    packaging {
        resources {
            excludes += setOf(
                "/META-INF/{AL2.0,LGPL2.1}",
                "/META-INF/LICENSE*",
                "/META-INF/NOTICE*"
            )
        }
    }
}

dependencies {
    // NanoHTTPD: tiny embedded HTTP server (~80KB), no Android Service required.
    implementation("org.nanohttpd:nanohttpd:2.3.1")

    // org.json is part of the Android platform — no dependency needed.

    // androidx.test infra for the @Test entry-point pattern.
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test:rules:1.6.1")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test.uiautomator:uiautomator:2.3.0")
    androidTestImplementation("junit:junit:4.13.2")
}
