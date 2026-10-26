# Kotlin JSON elements are used directly; no reflection-based app serializers.
# WebRTC's native JNI entry points call Java classes/methods by their ABI names.
# The published AAR has no consumer ProGuard rules; retain those native bridges.
-keep class org.webrtc.** { *; }
