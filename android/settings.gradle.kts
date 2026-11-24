pluginManagement {
    repositories { google(); mavenCentral(); gradlePluginPortal() }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories { google(); mavenCentral() }
}
rootProject.name = "omp-away"
include(":app", ":radiance")
// Opt in to the standalone visual study without configuring it for normal app builds.
if (providers.gradleProperty("includePrototype").orNull == "true") include(":prototype")
