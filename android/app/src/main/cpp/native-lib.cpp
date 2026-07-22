#include <jni.h>
#include <string>
#include <cstdlib>
#include <pthread.h>
#include <unistd.h>
#include <android/log.h>

#include "node.h"

#define LOG_TAG "BedrockNode"
#define ALOG(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)

extern "C" jint JNICALL
Java_ru_bedrock_serverreplay_NodeBridge_startNodeWithArguments(
    JNIEnv *env, jobject /* thiz */, jobjectArray arguments) {

  jsize argc = env->GetArrayLength(arguments);
  char **argv = new char *[argc];
  for (int i = 0; i < argc; i++) {
    auto s = (jstring) env->GetObjectArrayElement(arguments, i);
    const char *utf = env->GetStringUTFChars(s, nullptr);
    argv[i] = strdup(utf);
    env->ReleaseStringUTFChars(s, utf);
  }

  ALOG("node::Start argc=%d", (int) argc);
  int code = node::Start(argc, argv);

  for (int i = 0; i < argc; i++) free(argv[i]);
  delete[] argv;
  return code;
}

extern "C" void JNICALL
Java_ru_bedrock_serverreplay_NativeEnv_put(
    JNIEnv *env, jobject /* thiz */, jstring key, jstring value) {
  const char *k = env->GetStringUTFChars(key, nullptr);
  const char *v = env->GetStringUTFChars(value, nullptr);
  setenv(k, v, 1);
  ALOG("env %s=%s", k, v);
  env->ReleaseStringUTFChars(key, k);
  env->ReleaseStringUTFChars(value, v);
}
