# Photo All Studio

**一张可以开灯、摆片、放大细节的电子观片台，也是一套从选片到修图出片的本地工作台。**

在台面上自由摆放照片，切换连续胶卷与单张，用带折射效果的放大镜检查细节，再整理为风格统一的作品。免费开源，面向 Windows 10/11 x64，原片保持只读，照片处理与识图均在本机完成。

## 下载

在 [GitHub Releases](https://github.com/YZH2006517/Photo-All/releases) 下载 `*-setup.exe` 安装器，或解压整个 portable ZIP 后打开 `Photo All Studio.exe`。发行包附带 Python、图像依赖、RawTherapee、离线识图模型及胶片 LUT，无需安装开发工具。Windows 需要 WebView2；安装器包含检测与引导安装，首次安装 WebView2 需要联网。

## 电子观片台

- 实体灯箱式背光与亮度，开关灯不改变照片配方。
- 自由拖片、逐张调整尺寸、一键平铺；连续胶卷首尾相接，可横向滑动。
- 从底部逐张拖入照片，自选台面展示；拖到底部准备区上方的毛玻璃圆弧可单张收纳，自动记住展示名单与摆放位置。
- 一键收纳到底部导览；进入观片台时照片从导览依次展开。连续胶卷支持播放/暂停，手动操作时自动暂停。
- 可移动折射放大镜，倍率与镜片尺寸独立调节，镜外保留整张台面。
- 沉浸与全屏模式，空格或边缘唤出工具；胶片片孔、边框装饰可关闭。
- 图集范围审阅、爱心选片、RAW/JPEG优先显示与持久撤销。

常用快捷键：`G` 台面、`E` 单张、`C` 胶卷连排、`V` 放大镜、`L` 背光、`I` 沉浸、`F` 全屏。

## 从选片到出片

- 持久图集、递归导入、共享原片、回收站恢复与 30 天到期清理。图集销毁仅清除记录，不删除磁盘原文件。
- 紧凑的颜色、冷暖、亮度、内容、饱和度、对比度、方向、格式、像素、质量参考、风格与胶片筛选；各条件联动统计。
- 拟真胶片电子观片台、沉浸模式、连续胶卷、逐张缩放和折射放大镜。
- 构图与一体化调节：光线、阴影高光、黑白色阶、RGB/通道曲线、HSL与质感，数值支持键盘输入；普通鼠标直接移动画布。
- 独立滤镜库：126款开放LUT、17款创意风格与16款Spektrafilm色彩，搜索/分组/真实预览，RAW专业显影与16-bit导出。
- float32 SDR 处理、非破坏配方、持久撤销；16-bit PNG/TIFF、WebP 无损、JPEG、原片复制与 RAW 母版导出。
- 导出严格使用勾选照片，可选择同一目录或按图集分目录，支持终止任务。

当前为持续开发中的桌面软件。屏幕预览为 8-bit SDR；JPEG 为有损，WebP 输出为 8-bit。尚不支持完整 Photoshop 功能、PSD 互通、HDR 工作流和手机端。

## 更新

0.10.5 加入底部准备区顶部的低矮毛玻璃圆弧收纳区，支持逐张拖入、自选台面和持久化摆放；保留旧版胶片比例、响应式平铺、开场展开与联排播放。在 GitHub Releases 下载安装升级。下载新的安装 EXE 可覆盖升级。已有图库与配方保留；没有后台自动安装或账号服务。便携版需完整解压新ZIP并保留同目录runtime，个人图库仍在AppData。

## 源码与构建

前端：TypeScript / React / Motion / Tauri。图像处理：Python / NumPy / Pillow / LittleCMS，RAW：RawTherapee，胶片色彩：Spektrafilm，离线内容识别：CLIP ONNX。

- 应用代码集中在 [`product/`](product/)，测试与样本独立在 [`validation/`](validation/)。
- 开发、引擎准备与能力边界见 [`product/README.md`](product/README.md)。
- 独立 Windows 发行构建与第三方分发材料见 [`product/WINDOWS_DISTRIBUTION.md`](product/WINDOWS_DISTRIBUTION.md)。
- `cd product` 后运行 `npm install`、`npm test`、`npm run desktop`；Python 与原生工具依赖见说明。

## 开源许可

自有代码为 [GPL-3.0-or-later](product/LICENSE)。RawTherapee、Spektrafilm、模型及其他依赖保留各自许可证；Spektrafilm profiles/LUT 按随附 CC BY-SA 4.0 条款分发。第三方声明与对应源码材料随发行版提供。软件许可不会要求用户的照片开源。
