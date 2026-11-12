# 颗粒、光晕与冷启动：本次优化记录

保持版本 0.10.7。本次只修改源码并构建原生计算库，没有打包、提交或推送 GitHub。

## 参考机制与实现

参考本地 `F:/spektralab/upstream/engine/src/pipeline/pipeline.cpp` 的逐乳剂子层计算、`pipeline/blur.cpp` 的空间滤波及 `core/setup_cache.hpp` 的依赖缓存机制。未接入或复制 SpektraLab 引擎；使用 Photo All 自己的 C++/Vulkan 后端与现有 Spektrafilm 数据。

实测旧链路：6056×4032 输入、Portra 400、预闪、耦合剂、颗粒、光晕、自定义色温，核心计算 33.40 秒。其中颗粒约 17.13 秒，色温变换约 5.47 秒，光晕约 5.05 秒。

本次改动：

- 独立实现 GPU Poisson/二项粒子采样。逐个乳剂子层计算与累加，避免九通道整帧数组；保留染料云模糊、微结构和最终颗粒模糊。
- 实测片种高光曲线存在轻微回折。保留这些曲线的上游插值语义，但只插值当前子层，随后继续使用 GPU 颗粒采样，避免整个颗粒阶段回退 CPU。
- sRGB 解码、色温适配矩阵与编码放到 GPU。
- 独立空间着色器实现原有 FIR / Young–van Vliet 递归高斯模型。FIR 反射边界、IIR 复制边界与轴顺序保持一致；递归状态采用 FP64。缓冲区反复复用，超设备容量或不支持 FP64 时保留 CPU 空间路径。
- 校准点、Mitchell–Netravali 插值和 PCHIP 表准备使用 float64 向量计算，减少首次 JIT 等待；结果与上游数学实现逐项对照。
- 颜色计算准备结果使用数值文件缓存，跨预览进程及重启复用。缓存键包括实际参数、引擎/数据文件指纹、相关依赖版本和应用代码指纹；原子写入、损坏重建、总量上限 256 MiB。内存和底片缓存继续按原依赖失效。
- 原生预览过期时，通过独立共享取消标志通知 worker，在 GPU 分块或滤波调用间退出。取消不会销毁进程、GPU 上下文及已有缓存。仅不支持共享传输的回退请求保留原来的结束进程方式。
- 启动时不再抢先烘焙与用户选择无关的默认 Gold 200，也不再预编译用不到的 CPU 高斯分支。新原生库 ABI 为 4，安装构建要求同时包含 `film.spv` 与 `spatial.spv`。

## 实测结果

Windows、NVIDIA RTX 5080 16 GB，单任务测试。原始文件只读，使用独立测试图集及缓存目录。下面区分浏览器全过程、计算接口和重启缓存测试，不能把它们当成同一口径。

| 场景 | 结果 |
| --- | ---: |
| RAW 浏览器复杂组合原尺寸更新（上轮 → 本轮，同流程） | 35.21 → 17.37 秒 |
| RAW 浏览器首次胶片可见预览 | 3.93 秒 |
| RAW 浏览器计算中再次调参的可见响应 | 0.40 秒 |
| RAW 浏览器收到的最终尺寸 | 6056×4032 |
| RAW 复杂配方原尺寸接口，已就绪引擎 | 14.17 秒 |
| JPEG 4000×6000，同复杂配方原尺寸接口 | 14.32 秒 |
| JPEG 胶片后调阴影 / 叠加 LUT | 1.62 / 2.00 秒 |
| JPEG 复用胶片结果导出 JPEG / TIFF16 / PNG16 | 1.81 / 1.85 / 5.76 秒 |
| JPEG 只改变冲印参数，复用底片 | 2.41 秒 |
| JPEG 改变胶片前曝光，需要重算 | 14.82 秒 |
| 实际 RAW 任务取消，保持相同 worker PID | 0.16 秒 |
| 常规无颗粒配方核心计算及色差检查 | 4.71 秒；ΔE00 P95 0.00362、最大 0.02103 |

独立冷启动测试用 606×404 的真实 RAW 预览输入，同时启动交互及原尺寸 worker：全新空缓存首次复杂配方约 11.84 秒；结束两个 worker 后，保留磁盘缓存重启约 2.87 秒。首次安装仍不是零等待。浏览器首显测试使用独立图集，但科学运行库缓存可能已经存在，因此 3.93 秒不能描述为全新安装耗时。

最终原尺寸仍在后台计算，复杂组合目前没有达到两秒。不同显卡、片种、粒径、光晕半径及预闪配置会影响耗时。交互预览与原尺寸采用不同处理大小，最终原尺寸和导出不缩小照片。

GPU 颗粒是独立随机场，按同一采样模型的均值、方差与空间处理验证，不承诺与 CPU 随机噪声逐像素相同。逐像素精算仍使用原 CPU 路径；加速颜色计算沿用已明确的 LUT 近似契约。

## 验证与复现

- 7 项新增空间、随机统计、正/负片、校准等价、损坏缓存及故障回退测试通过。
- 原有 Vulkan 6 项、光谱 7 项、精度 20 项、共享缓存/取消 4 项、打包依赖 4 项通过。
- 编辑接口的预览、取消、片边及原尺寸缓存回归 8 项通过；合计 56 项后端/接口/精度测试。
- 真实 RAW 浏览器 19 项通过，无页面脚本错误，实际收到完整尺寸更新；过期原尺寸请求返回 409，最新请求成功。
- 实际共享内存取消后，worker PID 前后均为 47564，下一张不同尺寸照片继续使用 Vulkan。

原始记录位于 `validation/artifacts/spectral-followup-2026-11-12/`，浏览器记录位于 `validation/artifacts/editor-raw-real-2026-11-11-packaged/ui-spatial-gpu-final/`。

复测命令：

```powershell
# 核心复杂配方 / 默认无颗粒的精度检查
& 'product/build/runtime/engines/spectral-python/python.exe' validation/spectral_followup_probe.py --profile --spatial
& 'product/build/runtime/engines/spectral-python/python.exe' validation/spectral_followup_probe.py --profile
# 真实 JPEG / RAW 接口、导出、跨参数复用
& 'product/build/runtime/python/python.exe' validation/spectral_followup_probe.py --pipeline --compact --spatial --jpg
& 'product/build/runtime/python/python.exe' validation/spectral_followup_probe.py --pipeline --compact --spatial
# 干净缓存启动与真实任务取消（使用隔离目录）
& 'product/build/runtime/python/python.exe' validation/spectral_followup_probe.py --cold --compact
& 'product/build/runtime/python/python.exe' validation/spectral_followup_probe.py --cancel --compact
```
