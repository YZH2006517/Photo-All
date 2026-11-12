# Photo All Studio

**一张可以开灯、摆片、放大细节的电子观片台，也是一套从选片到修图出片的本地工作台。**

在台面上自由摆放照片，切换连续胶卷与单张，用带折射效果的放大镜检查细节，再整理为风格统一的作品。免费开源，面向 Windows 10/11 x64，原片保持只读，照片处理与识图均在本机完成。

## 下载

当前版本为 **0.10.8（Windows x64 预发布版）**。

- [下载安装 EXE](https://github.com/YZH2006517/Photo-All/releases/download/v0.10.8/Photo-All-Studio_0.10.8_x64-setup.exe)：可覆盖安装升级。
- [下载便携 ZIP](https://github.com/YZH2006517/Photo-All/releases/download/v0.10.8/Photo-All-Studio_0.10.8_windows-x64.zip)：完整解压后打开 `Photo All Studio.exe`，保留同目录 `runtime`。
- [0.10.8 发布页与校验值](https://github.com/YZH2006517/Photo-All/releases/tag/v0.10.8) · [更新说明](docs/release-0.10.8.md)

发行包附带 Python、图像依赖、RawTherapee、离线识图模型、胶片 LUT 与光谱运行时，无需安装开发工具。Windows 需要 WebView2；安装器包含检测与引导安装，首次安装 WebView2 需要联网。当前构建尚未代码签名。

## 电子观片台

- 实体灯箱式背光与亮度，开关灯不改变照片配方。
- 自由拖片、逐张调整尺寸、一键平铺；连续胶卷首尾相接，可横向滑动。
- 从底部逐张拖入照片，自选台面展示；按住照片时整块准备区模糊发光，拖入准备区即可单张收纳，自动记住展示名单与摆放位置。
- 一键收纳到底部导览；进入观片台时照片从导览依次展开。连续胶卷支持播放/暂停，手动操作时自动暂停。
- 可移动折射放大镜，V 键在鼠标位置开镜，倍率与镜片尺寸独立调节，镜外保留整张台面；关灯底色可选或自定义。
- 沉浸与全屏模式，空格或边缘唤出工具；胶片片孔、边框装饰可关闭。
- 图集范围审阅、爱心选片、RAW/JPEG优先显示与持久撤销。

常用快捷键：`G` 台面、`E` 单张、`C` 胶卷连排、`V` 放大镜、`L` 背光、`I` 沉浸、`F` 全屏。

## 胶片收藏室

将图集放进三维胶卷架，在木桌上展开胶卷，通过光学观片器的实体摇杆或电子观片器翻看照片，并可切换至双层透明亚克力胶片展廊。每卷最多 36 帧，每架容纳 14 卷；支持新建、切换胶片架、自定义暗盒、视角调整与全屏沉浸。场景灯光不写入照片，照片保留自身色彩。

## 从选片到出片

- 持久图集、递归导入、共享原片、回收站恢复与 30 天到期清理。图集销毁仅清除记录，不删除磁盘原文件。
- 紧凑的颜色、冷暖、亮度、内容、饱和度、对比度、方向、格式、像素、质量参考、风格与胶片筛选；各条件联动统计。
- 拟真胶片电子观片台、沉浸模式、连续胶卷、逐张缩放和折射放大镜。
- 构图与一体化调节：光线、阴影高光、黑白色阶、RGB/通道曲线、HSL与质感，数值支持键盘输入；普通鼠标直接移动画布。
- 独立滤镜库：126款开放LUT、17款创意风格与16款Spektrafilm色彩，搜索/分组/真实预览；支持最多16层风格/LUT叠加、独立强度、顺序与收藏，RAW专业显影与16-bit导出。
- Spektrafilm 光谱工艺：胶片、冲印、放大机滤色、预闪、耦合剂、光晕、颗粒与光源，支持负片扫描冲印；快速预设与片种列表可折叠。
- 原尺寸编辑预览与原图对比；片边可自定义卷名、日期、帧号、签名和拍摄信息。
- float32 SDR 处理、非破坏配方、持久撤销；16-bit PNG/TIFF、WebP 无损、JPEG、原片复制与 RAW 母版导出。
- 导出严格使用勾选照片，可选择同一目录或按图集分目录，支持终止任务。

当前为持续开发中的桌面软件。屏幕预览为 8-bit SDR；JPEG 为有损，WebP 输出为 8-bit。尚不支持完整 Photoshop 功能、PSD 互通、HDR 工作流和手机端。



## 0.10.8 更新

- 自研 C++/Vulkan 光谱、颗粒、空间滤波和 LUT 加速，默认快速计算，导出可选逐像素精算。
- 共享原尺寸解码、已显影底片和完整光谱缓存，过期预览协作取消，保留 GPU 资源。
- 颜色计算准备可跨进程和重启复用，减少首次编译，精简光谱运行库约 30.7 MiB。
- 亚克力展廊采用双层透明夹片、抛光倒角和环境反射，改进切场与渐变灯光。

RTX 5080 16 GB、6056×4032 RAW 的复杂效果原尺寸更新由 **35.21 秒降至 17.37 秒**。已有缓存时浏览器首次胶片可见预览约 **3.93 秒**，计算中再次调参约 **0.40 秒**显示交互预览。全新空缓存首次复杂配方仍需约 **11.84 秒**初始化。2400 万像素 JPEG 复用胶片结果后导出约 **1.81 秒**。

[完整更新项、测试条件与实测数据](docs/release-0.10.8.md) · [0.10.7 历史更新](docs/release-0.10.7.md)

## 源码与构建

前端：TypeScript / React / Motion / Tauri。图像处理：Python / NumPy / Pillow / LittleCMS，RAW：RawTherapee，胶片色彩：Spektrafilm，离线内容识别：CLIP ONNX。

- 应用代码集中在 [`product/`](product/)，测试与样本独立在 [`validation/`](validation/)。
- 开发、引擎准备与能力边界见 [`product/README.md`](product/README.md)。
- 独立 Windows 发行构建与第三方分发材料见 [`product/WINDOWS_DISTRIBUTION.md`](product/WINDOWS_DISTRIBUTION.md)。
- `cd product` 后运行 `npm install`、`npm test`、`npm run desktop`；Python 与原生工具依赖见说明。

### Windows 构建与代码签名

Windows 构建工作流在 GitHub 托管的 Windows x64 环境运行。打开 [Actions](https://github.com/YZH2006517/Photo-All/actions)，选择 **Build Photo All Studio for Windows**，再点 **Run workflow**。构建通过后，运行页面的 **Artifacts** 中会提供安装包、便携包、校验值和对应源码。工作流也会在推送 `v*` 标签时运行。

照片导入、编辑和识图均在本机处理。代码签名计划采用 SignPath Foundation，启用日期及签名审批人将在正式签名启用时公布。可在 Windows 文件属性的「数字签名」页查看下载文件的实际签名状态。

## 开源许可

自有代码为 [GPL-3.0-or-later](product/LICENSE)。RawTherapee、Spektrafilm、模型及其他依赖保留各自许可证；Spektrafilm profiles/LUT 按随附 CC BY-SA 4.0 条款分发。第三方声明与对应源码材料随发行版提供。软件许可不会要求用户的照片开源。
