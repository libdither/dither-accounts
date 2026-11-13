# OkHttp names optional TLS providers it does not need on Android.
-dontwarn org.bouncycastle.**
-dontwarn org.conscrypt.**
-dontwarn org.openjsse.**
# Tink, pulled in by the UnifiedPush connector for Web Push decryption, names annotations it does not ship.
-dontwarn com.google.errorprone.annotations.**
-dontwarn javax.annotation.**
