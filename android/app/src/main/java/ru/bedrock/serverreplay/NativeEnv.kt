package ru.bedrock.serverreplay

/** Sets process environment for the embedded Node runtime (JNI). */
object NativeEnv {
    init {
        // libs loaded by NodeBridge
    }

    external fun put(key: String, value: String)
}
