plugins {
    id("com.android.application") version "8.13.0"
    id("org.jetbrains.kotlin.android") version "2.2.20"
    id("com.google.gms.google-services") version "4.4.4"
}

val releaseTag = providers.environmentVariable("AWAY_RELEASE_TAG").orNull
val releaseVersionCode = releaseTag?.let { tag ->
    require(Regex("v(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)").matches(tag)) {
        "AWAY_RELEASE_TAG must be canonical vMAJOR.MINOR.PATCH"
    }
    val parts = tag.drop(1).split(".").map { it.toLong() }
    require(parts[0] <= 2099 && parts[1] <= 999 && parts[2] <= 999)
    (parts[0] * 1_000_000 + parts[1] * 1_000 + parts[2]).also {
        require(it > 5) { "Release versionCode must exceed the legacy versionCode 5" }
    }.toInt()
}
val signingInputs = listOf("AWAY_KEYSTORE", "AWAY_KEY_ALIAS", "AWAY_STORE_PASSWORD", "AWAY_KEY_PASSWORD")
    .associateWith { providers.environmentVariable(it).orNull }

gradle.taskGraph.whenReady {
    if (allTasks.any { it.project == project && it.name.contains("Release", ignoreCase = true) }) {
        require(releaseTag != null) { "Release tasks require AWAY_RELEASE_TAG" }
        signingInputs.forEach { (name, value) -> require(!value.isNullOrBlank()) { "Release requires $name" } }
        require(file(signingInputs.getValue("AWAY_KEYSTORE")!!).isFile) { "Release keystore is missing" }
        require(file("google-services.json").isFile) { "Release requires staged Firebase Android client configuration" }
    }
}

android {
    namespace = "ru.eleven.ompaway"
    compileSdk = 36
    buildToolsVersion = "36.0.0"
    defaultConfig {
        applicationId = "ru.eleven.ompaway"
        minSdk = 29
        targetSdk = 36
        versionCode = 5
        versionName = "1.0.4"
        releaseVersionCode?.let { versionCode = it }
        releaseTag?.let { versionName = it.drop(1) }
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    signingConfigs {
        create("protectedRelease") {
            if (signingInputs.values.all { !it.isNullOrBlank() }) {
                storeFile = file(signingInputs.getValue("AWAY_KEYSTORE")!!)
                storePassword = signingInputs.getValue("AWAY_STORE_PASSWORD")
                keyAlias = signingInputs.getValue("AWAY_KEY_ALIAS")
                keyPassword = signingInputs.getValue("AWAY_KEY_PASSWORD")
            }
        }
    }
    buildTypes {
        getByName("release") {
            signingConfig = signingConfigs.getByName("protectedRelease")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }

dependencies {
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation(platform("com.google.firebase:firebase-bom:34.5.0"))
    implementation("com.google.firebase:firebase-messaging")
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
    androidTestImplementation("androidx.test:runner:1.7.0")
}
