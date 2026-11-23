plugins {
    id("com.android.application") version "8.13.0"
    id("org.jetbrains.kotlin.android") version "2.2.20"
    id("com.google.gms.google-services") version "4.4.4" apply false
}

// A separate debug install verifies integration without replacing a signed production release.
val isolatedIntegration = providers.gradleProperty("isolatedIntegration").orNull == "true"
if (!isolatedIntegration) apply(plugin = "com.google.gms.google-services")

android {
    namespace = "ru.eleven.ompaway"
    compileSdk = 36
    buildToolsVersion = "36.0.0"
    buildFeatures { buildConfig = true }
    defaultConfig {
        applicationId = if (isolatedIntegration) "ru.eleven.ompaway.integration" else "ru.eleven.ompaway"
        manifestPlaceholders["appLabel"] = if (isolatedIntegration) "omp-away Integration" else "omp-away"
        minSdk = 29
        targetSdk = 36
        versionCode = 5
        versionName = "1.0.4"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        buildConfigField("boolean", "ISOLATED_INTEGRATION", isolatedIntegration.toString())
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }

dependencies {
    implementation(project(":radiance"))
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation(platform("com.google.firebase:firebase-bom:34.5.0"))
    implementation("com.google.firebase:firebase-messaging")
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
    androidTestImplementation("androidx.test:runner:1.7.0")
}
