plugins {
    id("com.android.application") version "8.13.0"
    id("org.jetbrains.kotlin.android") version "2.2.20"
    id("org.jetbrains.kotlin.plugin.compose") version "2.2.20"
}
android {
    namespace = "com.example.radiance.prototype"
    compileSdk = 36
    buildToolsVersion = "36.0.0"
    defaultConfig {
        applicationId = "com.example.radiance.prototype"
        minSdk = 29
        targetSdk = 36
        versionCode = 1
        versionName = "0.1-prototype"
    }
    buildFeatures { compose = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }
dependencies {
    implementation(platform("androidx.compose:compose-bom:2025.10.00"))
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.activity:activity-compose:1.11.0")
    implementation(project(":radiance"))
    testImplementation("junit:junit:4.13.2")
}
