# Photo All Studio

免费的开源本地照片整理与修图软件，面向 Windows 10/11 x64。把一组照片导入图集，用颜色与内容找到相近风格，再批量调色、模拟胶片与导出作品。所有照片在本机处理。

## 下载

在 [GitHub Releases](https://github.com/YZH2006517/Photo-All/releases) 下载 `*-setup.exe` 安装器，或解压整个 portable ZIP 后打开 `Photo All Studio.exe`。发行包附带 Python、图像依赖、RawTherapee、离线识图模型及胶片 LUT，无需安装开发工具。Windows 需要 WebView2；安装器包含检测与引导安装，首次安装 WebView2 需要联网。

## 功能

- 持久图集、递归导入、共享原片、回收站恢复与 30 天到期清理。图集销毁仅清除记录，不删除磁盘原文件。
- 紧凑的颜色、冷暖、亮度、内容、饱和度、对比度、方向、格式、像素、质量参考、风格与胶片筛选；各条件联动统计。
- 拟真胶片电子观片台、沉浸模式、连续胶卷、逐张缩放和折射放大镜。
- 构图裁切/旋转/翻转/拉直、光线、RGB/通道曲线、HSL、RAW 专业显影、17 款创意风格与 16 款 Spektrafilm 色彩。
- float32 SDR 处理、非破坏配方、持久撤销；16-bit PNG/TIFF、WebP 无损、JPEG、原片复制与 RAW 母版导出。
- 导出严格使用勾选照片，可选择同一目录或按图集分目录，支持终止任务。

当前为持续开发中的桌面软件。屏幕预览为 8-bit SDR；JPEG 为有损，WebP 输出为 8-bit。尚不支持完整 Photoshop 功能、PSD 互通、HDR 工作流和手机端。

## 源码与构建

前端：TypeScript / React / Motion / Tauri。图像处理：Python / NumPy / Pillow / LittleCMS，RAW：RawTherapee，胶片色彩：Spektrafilm，离线内容识别：CLIP ONNX。

- 应用代码集中在 [`product/`](product/)，测试与样本独立在 [`validation/`](validation/)。
- 开发、引擎准备与能力边界见 [`product/README.md`](product/README.md)。
- 独立 Windows 发行构建与第三方分发材料见 [`product/WINDOWS_DISTRIBUTION.md`](product/WINDOWS_DISTRIBUTION.md)。
- `cd product` 后运行 `npm install`、`npm test`、`npm run desktop`；Python 与原生工具依赖见说明。

## 开源许可

自有代码为 [GPL-3.0-or-later](product/LICENSE)。RawTherapee、Spektrafilm、模型及其他依赖保留各自许可证；Spektrafilm profiles/LUT 按随附 CC BY-SA 4.0 条款分发。第三方声明与对应源码材料随发行版提供。软件许可不会要求用户的照片开源。
