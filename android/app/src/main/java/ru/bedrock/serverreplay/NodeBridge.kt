package ru.bedrock.serverreplay

object NodeBridge {
    init {
        System.loadLibrary("c++_shared")
        System.loadLibrary("node")
        System.loadLibrary("bedrock-node")
    }

    external fun startNodeWithArguments(arguments: Array<String>): Int
}
