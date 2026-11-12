param(
    [string]$VulkanHeaders = "$env:VULKAN_SDK/Include",
    [string]$Compiler = "C:/msys64/ucrt64/bin/g++.exe",
    [string]$ShaderCompiler = "C:/msys64/ucrt64/bin/glslangValidator.exe"
)
$ErrorActionPreference = "Stop"
$target = Join-Path $PSScriptRoot "../engines/photo-all-gpu"
New-Item -ItemType Directory -Force -Path $target | Out-Null
if (!(Test-Path (Join-Path $VulkanHeaders "vulkan/vulkan.h"))) {
    throw "Pass -VulkanHeaders pointing to the Khronos Vulkan-Headers include directory."
}
& $ShaderCompiler -V --target-env vulkan1.1 (Join-Path $PSScriptRoot "film.comp") -o (Join-Path $target "film.spv")
if ($LASTEXITCODE -ne 0) { throw "Shader compilation failed." }
& $ShaderCompiler -V --target-env vulkan1.1 (Join-Path $PSScriptRoot "spatial.comp") -o (Join-Path $target "spatial.spv")
if ($LASTEXITCODE -ne 0) { throw "Spatial shader compilation failed." }
$previousPath = $env:PATH
try {
    $env:PATH = (Split-Path $Compiler) + ";" + $env:PATH
    $vulkanImport = Join-Path (Split-Path $Compiler) "../lib/libvulkan-1.dll.a"
    & $Compiler -std=c++20 -O3 -shared -s -static-libgcc -static-libstdc++ -static -I $VulkanHeaders (Join-Path $PSScriptRoot "film.cpp") $vulkanImport -o (Join-Path $target "photo_all_gpu.dll")
    if ($LASTEXITCODE -ne 0) { throw "Native compilation failed." }
} finally {
    $env:PATH = $previousPath
}
