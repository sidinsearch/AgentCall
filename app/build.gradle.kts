plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val productionSigningEnvironment = mapOf(
    "keystore" to System.getenv("AGENTCALL_ANDROID_KEYSTORE_FILE"),
    "keystorePassword" to System.getenv("AGENTCALL_ANDROID_KEYSTORE_PASSWORD"),
    "keyAlias" to System.getenv("AGENTCALL_ANDROID_KEY_ALIAS"),
    "keyPassword" to System.getenv("AGENTCALL_ANDROID_KEY_PASSWORD"),
)
val configuredProductionSigningValues =
    productionSigningEnvironment.filterValues { !it.isNullOrBlank() }
if (configuredProductionSigningValues.isNotEmpty() &&
    configuredProductionSigningValues.size != productionSigningEnvironment.size
) {
    throw GradleException(
        "Production Android signing is partially configured; set all required AGENTCALL_ANDROID_* variables.",
    )
}
val productionSigningConfigured =
    configuredProductionSigningValues.size == productionSigningEnvironment.size
val productionKeystore =
    productionSigningEnvironment.getValue("keystore")?.let(::file)
if (productionSigningConfigured &&
    (productionKeystore == null || !productionKeystore.isAbsolute || !productionKeystore.isFile)
) {
    throw GradleException(
        "AGENTCALL_ANDROID_KEYSTORE_FILE must identify an existing absolute regular file outside the repository.",
    )
}

android {
    namespace = "com.callagent.gateway"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.callagent.gateway"
        minSdk = 26
        targetSdk = 34
        versionCode = 333
        versionName = "1.0.1"
    }

    signingConfigs {
        if (productionSigningConfigured) {
            create("production") {
                storeFile = productionKeystore
                storePassword = productionSigningEnvironment.getValue("keystorePassword")
                keyAlias = productionSigningEnvironment.getValue("keyAlias")
                keyPassword = productionSigningEnvironment.getValue("keyPassword")
                enableV1Signing = false
                enableV2Signing = true
                enableV3Signing = true
                enableV4Signing = false
            }
        }
    }

    buildTypes {
        debug {
            // Keep the cloud/CLI debug APK installable beside the production
            // release APK. The CLI transport is tested independently and
            // must not require uninstalling the stable USB dialer.
            applicationIdSuffix = ".cli"
            versionNameSuffix = "-cli"
        }
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (productionSigningConfigured) {
                signingConfig = signingConfigs.getByName("production")
            }
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }

    kotlinOptions {
        jvmTarget = "1.8"
    }

    sourceSets {
        getByName("test").resources.srcDir(rootProject.file("protocol"))
    }
}

tasks.register("verifyProductionSigningConfigured") {
    group = "verification"
    description = "Fails unless all protected production Android signing inputs are configured."
    doLast {
        if (!productionSigningConfigured) {
            throw GradleException(
                "Production Android signing is not configured. " +
                    "Set the documented AGENTCALL_ANDROID_* environment variables.",
            )
        }
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.appcompat:appcompat:1.6.1")
    implementation("com.google.android.material:material:1.11.0")
    implementation("androidx.constraintlayout:constraintlayout:2.1.4")

    // Pure JVM unit tests for device-selection and profile safety logic.
    testImplementation("junit:junit:4.13.2")

}
