cmake_minimum_required(VERSION 3.22.1)
project(bedrock-node)

# cpp → main → src → app/libnode
set(NODE_ROOT ${CMAKE_CURRENT_SOURCE_DIR}/../../../libnode)

add_library(bedrock-node SHARED native-lib.cpp)

add_library(libnode SHARED IMPORTED)
set_target_properties(libnode PROPERTIES IMPORTED_LOCATION
    ${NODE_ROOT}/bin/${ANDROID_ABI}/libnode.so)

target_include_directories(bedrock-node PRIVATE ${NODE_ROOT}/include/node)

# Android 15+ 16 KB page size
target_link_options(bedrock-node PRIVATE
  "-Wl,-z,max-page-size=16384"
  "-Wl,-z,common-page-size=16384"
)
find_library(log-lib log)
target_link_libraries(bedrock-node libnode ${log-lib})
