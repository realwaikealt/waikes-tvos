pluginManagement {
    repositories { google(); mavenCentral(); gradlePluginPortal() }
}
dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
        // libadb-android and its SPAKE2 pairing library are published on JitPack only.
        maven { url = uri("https://jitpack.io") }
    }
}
rootProject.name = "couchtv-ontv"
include(":app")
