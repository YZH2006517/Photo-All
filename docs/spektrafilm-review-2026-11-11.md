# Spektrafilm 上游与本地集成核对

核对日期：2026-11-11。仅调研，不升级依赖、不修改生产代码、不推送。

## 是否有更新

官方仓库为 [andreavolpato/spektrafilm](https://github.com/andreavolpato/spektrafilm)。通过 GitHub API 查到 main 为 `3bb2c2d2801ff68b92019cf1dbcbb133d60832bc`，提交时间 2026-06-06 23:40:37 UTC，内容为 V-Log 中灰曝光修复。本地 `product/package_windows.py` 固定的也是同一 SHA；比较结果 `identical`，ahead/behind 均为 0。因此当前没有比我们固定提交更靠后的 main 提交可直接升级。

官方最新 Release 是 [v0.3.3](https://github.com/andreavolpato/spektrafilm/releases/tag/v0.3.3)，发布于 2026-06-06；我们固定的主线包元数据为 0.3.4。主线包版本与 Release 标签不是一回事，不能只比较版本数字。搜索结果中的 Spektrafilm OFX 是另一个实现，不能当作本 Python 仓库的新发行版。

## 原项目怎样实现交互

1. **预览图独立缓存和缩放。** [GUI controller](https://github.com/andreavolpato/spektrafilm/blob/3bb2c2d2801ff68b92019cf1dbcbb133d60832bc/src/spektrafilm_gui/controller.py) 保存预览输入，默认最大边 640；自动预览通过后台 worker 执行，已有任务运行时记录待更新状态，完成后重放最新请求。
2. **复用 Simulator。** 同一个 controller 保留模拟器对象，后续调用 `update_params`，保留可复用的运行状态；不是每改一个参数就新建整条管线。
3. **GUI 主动开启加速。** [params_mapper.py](https://github.com/andreavolpato/spektrafilm/blob/3bb2c2d2801ff68b92019cf1dbcbb133d60832bc/src/spektrafilm_gui/params_mapper.py) 的 `_apply_settings` 设置放大机和扫描器 LUT 为开启，LUT 分辨率 17，同时启用快速统计。底层 SettingsParams 的这两个 LUT 默认值反而是关闭；只调用底层默认参数不等于沿用了原 GUI 的性能设置。
4. **保留 LUT 缓存。** [SpectralLUTService](https://github.com/andreavolpato/spektrafilm/blob/3bb2c2d2801ff68b92019cf1dbcbb133d60832bc/src/spektrafilm/runtime/services/spectral_lut_compute.py) 先在三维密度空间计算 LUT，再对图像插值。服务保存放大机、扫描器与光谱上采样缓存，并根据参数相关信息决定失效。
5. **全分辨率仍可能慢。** [官方 README](https://github.com/andreavolpato/spektrafilm/blob/3bb2c2d2801ff68b92019cf1dbcbb133d60832bc/README.md) 明确将 Python 定位为参考实现，也提示全分辨率导出很慢，并列出 Vulkan、Rust、OFX 等其他实现。

## 我们的关键差异

| 位置 | 当前行为 | 性能影响 |
| --- | --- | --- |
| `product/film_spectral.py` 的 `spectral_blocks` | 接收 `use_lut`，但始终逐块执行精确光谱转换，未使用该开关 | 限制了 81 波段临时数组占用，但仍要给每个像素重复进行光谱计算 |
| 创建 `SimulationPipeline(p)` 后 | 将原生放大机、扫描器计算方法替换为 `spectral_blocks` | 绕过上游 LUT 服务的实现；单纯打开两个布尔设置也不能恢复加速 |
| 每次模拟 | 重新构建 SimulationPipeline | Python 进程虽然常驻，管线对象与其 LUT 状态没有随之常驻 |
| 原尺寸刷新 | 交互预览后继续运行全图精算 | 界面已出现较快结果，并不意味着后台原尺寸计算已经完成 |

这些差异能够解释为何高内存机器仍有较长等待，但各项改动的独立加速倍率还没有 A/B 实测，不能把全部耗时都归因于某一行代码。

## 当前实测能支持的判断

使用 `E:/醒图over` 的 4000×6000 实拍 JPG，匹配安装包运行时：640 像素交互预览首次约 11.03 秒，后续多数约 1 秒；原尺寸基础光谱精算 83.98 秒，多工艺联调 86.74 秒。这是本轮调用的观测值，不是上游官方性能数据。完整统计见同日期测试报告。

开发虚拟环境与发行运行时虽然同为 Spektrafilm 0.3.4，但发行版有延迟导入与 SciPy FFT 补丁。因此早先开发环境首次预览 34.36 秒不作为正式发布版成绩；原记录保留在测试产物中。

## 建议后续优化顺序

先恢复预览中的原生 LUT 服务和持久 Simulator，保留颗粒、光晕、扩散等空间计算的独立阶段；再检查参数变动对应的缓存失效范围。应同时测首次构建和连续调节，避免只有首次快、随后重新烘焙的情况。

LUT 加速可以作用于原图的完整像素网格，**不需要降低图像宽高**，但颜色转换会有插值近似。应使用本轮同一批实拍图，对照精确光谱路径评估颜色误差、极端曝光、高饱和色及空间效果，再决定预览和最终导出的默认策略。不能未经比较就声称与精算逐像素完全相同。

若要进一步追求实时全图处理，再评估官方 README 指出的 GPU/Vulkan 或其他移植实现；这属于引擎迁移，工作量和输出一致性验证都大于恢复原生 LUT 路线。本轮不自动替换。
