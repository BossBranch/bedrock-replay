plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "ru.bedrock.serverreplay"
    compileSdk = 35

    defaultConfig {
        applicationId = "ru.bedrock.serverreplay"
        minSdk = 26
        targetSdk = 35
        versionCode = 1100
        versionName = "1.1.0"
        ndkVersion = "27.0.12077973"
        ndk {
            abiFilters += listOf("armeabi-v7a", "arm64-v8a", "x86_64")
        }
        externalNativeBuild {
            cmake {
                arguments += listOf("-DANDROID_STL=c++_shared")
            }
        }
    }

    signingConfigs {
        create("release") {
            // Local only: android/keystore.properties (gitignored) + release.keystore
            val propsFile = rootProject.file("keystore.properties")
            val store = rootProject.file("release.keystore")
            if (propsFile.exists() && store.exists()) {
                val props = java.util.Properties().apply {
                    propsFile.inputStream().use { load(it) }
                }
                storeFile = store
                storePassword = props.getProperty("storePassword")
                keyAlias = props.getProperty("keyAlias")
                keyPassword = props.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            signingConfig = signingConfigs.getByName("release")
        }
        debug {
            // keep default debug signing
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
        }
    }

    sourceSets {
        getByName("main") {
            jniLibs.srcDirs("libnode/bin")
        }
    }

    packaging {
        jniLibs {
            // Uncompressed, zip-aligned .so — required for 16 KB devices (with aligned ELFs)
            useLegacyPackaging = false
        }
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.webkit:webkit:1.12.1")
}
