import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

// versionCode grows with every release: major*10000 + minor*100 + patch of the app version (1.1.0 -> 10100).
// scripts/release.js bumps the version that Tauri writes into tauri.properties, so this follows it.
val appVersionName = tauriProperties.getProperty("tauri.android.versionName", "1.0.0")
val appVersionCode = appVersionName.split(".").map { it.toIntOrNull() ?: 0 }.let { (it.getOrElse(0) { 0 } * 10000) + (it.getOrElse(1) { 0 } * 100) + it.getOrElse(2) { 0 } }

// Release signing: the key lives outside the repo and is given by environment variables (a local shell script, or
// GitHub secrets in CI). Without them the release APK is built unsigned.
val signingKeystore: String? = System.getenv("CIROOM_ANDROID_KEYSTORE")?.takeIf { it.isNotBlank() }

android {
    compileSdk = 36
    namespace = "app.ciroom.media"
    defaultConfig {
        // The app talks plain http to the PC on the home Wi-Fi (no certificate possible for a LAN address).
        manifestPlaceholders["usesCleartextTraffic"] = "true"
        applicationId = "app.ciroom.media"
        minSdk = 24
        targetSdk = 36
        versionCode = appVersionCode
        versionName = appVersionName
    }
    signingConfigs {
        if (signingKeystore != null) {
            create("release") {
                storeFile = file(signingKeystore)
                storePassword = System.getenv("CIROOM_ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("CIROOM_ANDROID_KEY_ALIAS") ?: "ciroom"
                keyPassword = System.getenv("CIROOM_ANDROID_KEY_PASSWORD") ?: System.getenv("CIROOM_ANDROID_KEYSTORE_PASSWORD")
            }
        }
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {
                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            if (signingKeystore != null) signingConfig = signingConfigs.getByName("release")
            optimization {
               enable = true
            }
            proguardFiles(
                *fileTree(".") {
                  include("**/*.pro")
                  exclude("build/**")
                }.files.toTypedArray()
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    buildFeatures {
        buildConfig = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_1_8
    }
}

rust {
    rootDirRel = "../../../"
}

// The QR scanner plugin's ML Kit API (play-services-mlkit-barcode-scanning) normally downloads its model through
// Google Play services, which fails on phones without working Play services ("Failed to create thin barcode
// scanner"). The bundled model below ships inside the APK instead (~2.5 MB bigger) and the API finds it on its own.
dependencies {
    implementation("com.google.mlkit:barcode-scanning:17.3.0")
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = file("tauri.build.gradle.kts"))
