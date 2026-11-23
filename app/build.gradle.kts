plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "jp.k3286.minibasscoresheet"
    compileSdk = 34

    defaultConfig {
        applicationId = "jp.k3286.minibasscoresheet"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    // メンバー表のOCR取り込み：ML Kit 日本語テキスト認識（モデル同梱版）
    // 認識は端末内で完結し、画像やテキストを外部へ送信しない。
    implementation("com.google.mlkit:text-recognition-japanese:16.0.1")
}
