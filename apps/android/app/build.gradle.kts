plugins {
    id("com.android.application")
}

android {
    namespace = "org.libdither.approver"
    compileSdk {
        version = release(36) { minorApiLevel = 1 }
    }
    buildToolsVersion = "36.0.0"

    defaultConfig {
        applicationId = "org.libdither.approver"
        // 30: Android 11, the first with KeyGenParameterSpec.setUserAuthenticationParameters (a key that asks on every
        // use, by fingerprint or the device's PIN) and BiometricPrompt with a CryptoObject and the device credential.
        minSdk = 30
        targetSdk = 36
        // CI sets these from the release tag and run number (.github/workflows/android.yml).
        versionCode = (System.getenv("APPROVER_VERSION_CODE") ?: "1").toInt()
        versionName = System.getenv("APPROVER_VERSION_NAME") ?: "0.1.0"
    }
    buildFeatures {
        buildConfig = true
    }

    // A release key from the environment (CI keeps it in repository secrets), so every published APK installs over
    // the last. Without one, release builds use the debug key, which only updates builds from the same machine.
    val releaseKey = System.getenv("APPROVER_KEYSTORE")?.takeIf { file(it).exists() }
    signingConfigs {
        if (releaseKey != null) {
            create("release") {
                storeFile = file(releaseKey)
                storePassword = System.getenv("APPROVER_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("APPROVER_KEY_ALIAS")
                keyPassword = System.getenv("APPROVER_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.getByName(if (releaseKey != null) "release" else "debug")
        }
    }
    packaging {
        resources.excludes += setOf("META-INF/*.version", "META-INF/**/*.kotlin_builtins", "kotlin/**", "DebugProbesKt.bin")
    }
    dependenciesInfo {
        includeInApk = false
        includeInBundle = false
    }
}

dependencies {
    // The link (WebSocket) and the public suffix list (HttpUrl.topPrivateDomain) for the origin checks.
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.unifiedpush.android:connector:3.3.5")
    // QR codes from the camera (Camera2 frames, decoded here: no Play Services).
    implementation("com.google.zxing:core:3.5.4")

    testImplementation("junit:junit:4.13.2")
    // Android's org.json is a stub in JVM unit tests; this is the real one.
    testImplementation("org.json:json:20240303")
}
