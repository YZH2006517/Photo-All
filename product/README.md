# Photo All Studio · React + Motion + Tauri

## 当前主入口

双击 `start.cmd`，打开新的浅色桌面工作台。前端为 TypeScript + React + Motion，桌面外壳为 Tauri，照片处理通过私有本地服务连接现有 Python/Pillow/RawTherapee。所有照片在本机处理，无需账号。0.9 发行版提供包含 Python、图像依赖、RAW 与离线资源的独立 Windows 安装 EXE 和便携 ZIP，使用方法与构建见 WINDOWS_DISTRIBUTION.md。

首页为持久图集：新建图集后导入文件夹，拼贴封面显示照片数。进入图集后可叠加日期、主色、冷暖、亮度与内容筛选，选择匹配照片批量套滤镜；保留每张照片各自的曝光等参数，批量修改可整体撤销。同一原片可以属于多个图集，重新按时间分组不会修改图集成员。旧照片库自动迁入“已有照片”图集。

新界面还包括质量排序、精选与排除、启发式初选、同窗编辑、预览直方图、17 种创意风格、16 款真实 spektrafilm 胶片色彩、基本调色、RAW 专业参数、当前筛选范围配方同步、撤销/重做、16-bit PNG / TIFF、无损 WebP、JPEG、原始文件复制与 RAW 显影母版导出。Motion 动效响应系统减少动态效果偏好。

## 当前编辑工作台 · 0.9

采用左侧工具栏、中央画布、右侧参数与直方图、底部照片导览的暗色布局。构图统一提供可拖拽裁切与比例预设、90° 旋转、翻转和拉直；其余入口为光线、RGB/单通道分段线性曲线、八段 HSL、胶片、RAW 和图层。细节、修复、局部入口已移除，旧配方保持兼容。参数内容区独立滚动，底部同步按钮不遮挡白场等控件。左导航为默认收起的抽屉。

所有工具沿用 float32 处理，裁切和变换后的 PNG/TIFF 仍可导出 16-bit，完整导出重新读取原片。原图对比保留相同几何，只移除调色，裁切工具单独使用未裁切画幅。快速连续编辑时以服务器确认的准确配方标识预览缓存；旧预览未替换时禁止几何相关落笔，避免源坐标错位。当前工作台是自身高精度实现，未嵌入 GIMP、Krita 或 miniPaint；尚不支持完整蒙版体系、文字排版和 PSD 互通。

## 画质与导出

主工作台从完整源文件出发，以 float32 处理调色、Spektrafilm LUT 和图层，保留 16-bit PNG/TIFF 及 RAW 显影精度；编辑不会写回原片。界面按显示像素加载无损 PNG，放大到需要时读取完整尺寸，离屏释放高分辨率解码图片。屏幕显示最后转换为 8-bit，不能把屏幕渲染称为 16-bit HDR 显示。首次大 RAW 仍需要原生引擎显影；增加倍率不会创造超出原片的细节。

默认以原始尺寸导出 16-bit PNG，也可选 16-bit TIFF（Deflate 无损）、8-bit WebP 无损编码、JPEG（有损）或原始文件逐字节复制。PNG/TIFF 含当前完整调色和胶片；原始文件复制不应用修改，另附当前配方。RAW 显影母版是单独选项，仅包含原生 RAW 参数。留白模板和明确指定的尺寸会进行相应排版/重采样，完整源图是输入，绝不复用浏览缩略图。

高精度输入支持 RGB/灰度 JPEG、PNG、TIFF（含 LZW/Deflate）、WebP、BMP 与 RawTherapee 支持的 RAW；ICC 使用 LittleCMS 浮点转换。HEIC 高位深、CMYK/Lab 与超出 0–1 的 HDR 浮点输入目前明确报错，避免静默降成 8-bit。依赖与许可证放在 engines/precision-packages，固定版本见 requirements.txt。原片已经是 JPEG 或 8-bit 时，16-bit 输出保留后续计算精度，但不能恢复输入中不存在的数据。

图集卡片的删除按钮将整个图集移入回收站，30 天内可恢复；到期删除图集及成员记录，不删除磁盘原片。

图集内右键可移除照片，只修改当前图集成员；“全部照片”范围则从图库隐藏。两者均可撤销/重做，不删除磁盘原文件，也不破坏其他图集共享的原片。

## 分类、对比和撤销

分类默认收成一行，更多筛选可展开；新增饱和度、对比度、方向、文件类型、像素、启发式质量、配方风格与胶片型号。旧图的对比度可通过“补全视觉分析”补算。分类数字会随其他已选条件实时更新，包括搜索与精选范围。每个下拉框保留自己的候选选项，按其他条件统计；零张选项显示 0 并禁用，当前选中项仍可清除。

编辑画布点击“对比原图”，使用左右分割线；拖动手柄、方向键或 Home/End 调整，双击手柄居中。原图和效果图独立缓存，拖动不请求图片或重新显影。

顶部提供明确的“撤销”“重做”按钮。Ctrl+Z 撤销，Ctrl+Shift+Z / Ctrl+Y 重做，覆盖调色、胶片配方、精选/排除和批量滤镜。历史保存在 SQLite，可跨重启恢复；新增编辑清除重做分支，无实际变化不记录一步。图层工作区有自己的撤销/重做，限本次编辑会话。导入、新建图集和导出文件不属于编辑撤销范围。搜索文字框保留系统文字撤销语义。

预览采用离屏延迟加载、前端最多 3 个并发请求、64 MiB Blob 缓存和目标 192 MiB 的解码图片缓存；当前显示图片被引用时可临时超过目标，闲置后按 LRU 回收。后台最多 2 张并发解码，32 MiB 内存 / 256 MiB 磁盘预览缓存。原图、确认配方、引擎版本或胶片 LUT 更新会使缓存失效。观片台、单张与胶卷连排共享已解码图片，同一画质的暖机切换不重新请求源图。图集缩略图使用独立缓存；观片和编辑画布从源文件生成无损 PNG，按照显示尺寸、DPR 和倍率读取，最高请求完整分辨率。完整作品导出始终重新读取完整源文件。

## 胶片电子观片台 · Lighttable

首页点击“电子观片台”后先勾选要展示的图集；同一原片只出现一次，未勾选图集不会混入，退出后返回首页。图集中的入口审阅当前筛选范围；Ctrl 多选两张以上后进入，会直接以连续胶卷浏览所选照片；编辑器入口从当前照片开始。观片范围在进入时固定，精选和排除不会让正在审阅的照片突然消失。

胶片台模拟实体灯箱：关灯时暖色台面与暗透的乳剂；L 或“开灯”开启背光，片孔透出光线。可以自由拖动胶片、拖动空白平移桌面、滚轮缩放、一键平铺。灯光亮度只影响显示，不写入照片配方。选中一张照片后拖动角部手柄可单独调整其大小，邻片保持原尺寸；已移除全局“照片尺寸”滑杆。片边包含帧号、条码、胶片型号、阴影与轻微反光；胶片位置和桌面视图缓存在本机，最多保留 8 个观片范围。

V 打开可移动的圆形放大镜，默认直径 300 CSS 像素，倍率旁的“放大镜大小”滑杆可调整尺寸。周围桌面和其他胶片保持可见，没有十字光标或文件名浮层。镜内同时放大照片、片边与邻近胶片，支持 1–20× 连续倍率；SVG 径向位移对完整 RGB 图像统一折射，四周预留 40px 采样缓冲，避免蓝色边块，边缘柔焦、玻璃反光和渐隐光晕增加实体感。它是视觉仿真，不代表经过光学校准的真实镜头或色彩测量工具。Esc 或 V 先收起放大镜。

底部导览照片可右键“删除照片”，仅从本次选定的图集中移除，可撤销；保留原文件及未选择图集的成员关系。

顶部“边框”按钮可开关胶片装饰。关闭后，平铺、胶卷连排与放大镜同步隐藏片孔、型号、条码、黑边和片面装饰，仅显示当前调色后的照片；照片比例和连续布局相应重算。开关偏好保存在本机，重开观片台保留，不修改照片配方或导出。

“胶卷连排”将照片窗口放在同一高度，片边首尾连续，像审阅一卷胶卷。拖动或滚轮可左右滑动，Ctrl+滚轮缩放并保持胶卷处于可见高度；底部胶片条和方向键可定位帧。双击照片切入单张或放大，观片界面仅保留角落爱心，点击切换收藏；键盘 P / X / U 快捷操作仍可用，单张和连排模式标记后自动前进。选片与编辑共用持久撤销/重做；所有选片操作按顺序写入同一相册库，退出和桌面关闭等待保存完成。

默认开启沉浸模式，空闲 1.8 秒隐藏上下栏和工具界面；画面内移动鼠标、选片和拖动不会弹出状态栏。按住空格或将鼠标移到窗口上下边缘可临时唤出。I 切换沉浸、F 切换真正的窗口全屏、G 接触表、E 单张、C 胶卷连排、方向键翻片。Esc 先收镜、退出全屏，再返回原工作区；正常离开观片台会恢复进入前的全屏状态。工具栏鼠标悬停或键盘焦点停留期间保持可见。点击“编辑此张”继续进入现有 RAW/胶片编辑器。

该模式是 Photo All 为共享相册、配方、选片和预览缓存独立编写的前端，并未移植 [Lighttable Digital Darkroom](https://github.com/reville/lighttable-digital-darkroom) 的 GPU 渲染器，也不等于负片扫描反转或实体灯箱校准。上游调研记录保留在研究文档；当前实际胶片色彩来自下节的 Spektrafilm 集成。

## 胶片暗房

编辑面板的“胶片”页使用 [spektrafilm](https://github.com/andreavolpato/spektrafilm) 官方 `BundleBuilder` 生成的 33³ sRGB → sRGB LUT，固定 0.3.4 源码 revision `3bb2c2d2801ff68b92019cf1dbcbb133d60832bc`。当前 16 个 LUT 均已生成，并各有不同输出。包括 Portra 160/400/800、Gold 200、Ektar 100、Ultramax 400、Fujifilm C200 / Pro 400H / X-TRA 400、Vision3 50D / 250D / 200T / 500T 等负片与对应相纸组合。

这是官方光谱模型的**色彩 LUT 加速模式**，不在每次拖动时运行全套光谱计算，不包含上游空间/随机物理效果。胶片强度支持 0–100%；“附加颗粒”“附加光晕”为 Photo All 自研的确定性效果，与上游物理颗粒/卤化物模型分开标注。预览、JPEG 导出和图层合成共用同一函数；导出配方附带引擎、版本与胶片型号。主工作台已升级为 float32 sRGB SDR 处理，PNG/TIFF 16-bit 导出包含胶片和创意风格；单独的 RAW 显影母版导出仅包含 RAW 专业参数。

选择一组照片后，浮动工具栏的“批量滤镜”中可以选创意风格或胶片。批量胶片预设统一为 100% 色彩、无附加颗粒/光晕，保留各自曝光等基础参数；单张微调后可用“同步到本组”同步完整配方。

本机已准备资源。新机器在配置好项目基础依赖与 [uv](https://docs.astral.sh/uv/) 后运行 `python film.py --setup`。脚本创建独立 Python 3.13.13 环境，下载固定上游源码、仅安装无界面核心依赖，再生成 LUT；应用渲染不依赖这个重型环境。已有环境只需运行 `engines/film-runtime/Scripts/python.exe film.py --bake`。资源位于 `engines/film-luts/`，源码与许可证在 `engines/spektrafilm-source/`，不把测试输出混进产品数据。

署名：film colour powered by **spektrafilm by Andrea Volpato**。核心代码 GPLv3；固定版本的 profiles 和生成 LUT 按随附的 **CC BY-SA 4.0** 分发。许可证、来源、生成参数和修改说明随资产保留；这不对用户最终照片附加相同许可。17 种创意风格中的新增 12 种是 Photo All 的开源预设，不冒充实测胶片型号。

导出只使用当前勾选列表；编辑模式只导出当前照片。爱心收藏与勾选互相独立，不再替换为所有收藏照片。可勾选“全部导出到同一个文件夹”，取消后按图集建立子文件夹，每张选片只导出一份。任务支持终止，保留已经完成的文件并清理当前未完成输出。

多图层合成是参考 Compositor 工作流独立编写的模块，**不是原版 Compositor 引擎移植**。编辑工作台点击“图层合成”，可排序、隐藏、删除和添加图层，调整透明度、位置、缩放和旋转，支持正常、正片叠底、滤色、叠加、变暗、变亮 6 种混合。项目自动保存在 SQLite，可重开和撤销会话内修改。图层保存创建时的配方快照，画布预览与 16-bit PNG 导出共用 float32 Pillow/NumPy 渲染器，使用预乘透明度做仿射采样，保留透明背景。画布总像素最多 800 万，最多 24 层；目前为 float32 sRGB SDR 图层合成、16-bit PNG 输出，不含蒙版、笔刷或 PSD 互通。RawTherapee 专业能力也仅包括开放的参数，不能描述为完整复刻两款软件。

## 离线识图

本机已准备 CLIP ViT-B/32 ONNX INT8 模型。新机器执行 `python setup_recognition.py`，将开源运行库与约 156 MB 模型资源安装到 `engines/`。固定模型版本为 `6b7c523703ae26e39be4b03774966f8571c7f523`，安装脚本核验 SHA-256，并保留模型卡和 MIT 许可证。下载过程只请求模型文件，不会发送照片。重启后在图集内点击“识图分类”，用 CPU 离线分析；尚未安装时明确显示模型未就绪，其他视觉分类仍可使用。

支持 14 种固定内容：风光、城市建筑、人物、动物、植物、美食、水景、夜景、日落、室内、街头、交通、静物、文档。内部使用固定英文提示词、中文显示标签，低相似度/低相对分数归为“待确认”。保存前三个候选与模型版本；分数仅是这些候选之间的相对分数，不是校准后的正确率。尚不支持任意中文语义搜索、人脸身份识别或审美打分。颜色特征以未调色原片分析，不随套滤镜变化；冷暖是画面颜色分布，不是相机白平衡色温。

研究来源与实现取舍见上级 `docs/research/2026-10-29-albums-and-composition.md`。PhotoPrism 和 Immich 只作为架构参考，未将整套服务嵌入产品。

## 集中的代码结构

- `ui/App.tsx`：工作台界面、动效与交互状态，按相册、编辑、导出区域组织。
- `ui/Editor.tsx`：集中放置专业编辑布局、裁切、曲线/HSL 与源坐标笔刷；处理计算在 `pixels.py`。
- `ui/model.ts`：类型、本地通信、选片规则与保存队列。
- `ui/Albums.tsx` / `ui/Composite.tsx`：图集与分类控件、多图层合成工作区。
- `ui/Preview.tsx` / `ui/Film.tsx`：按需预览、分割线对比与胶片控件。
- `ui/Lighttable.tsx` / `ui/FilmTable.tsx`：观片和顺序保存、沉浸全屏、实体灯箱与折射放大镜。
- `ui/style.css`：视觉规范和布局样式；不拆分大量样式文件。
- `service.py`：私有回环服务、任务队列与图片流。
- `engine.py`：现有相册、调色和 RAW 处理。
- `workflow.py`：集中放置视觉特征、CLIP 推理与图层合成计算。
- `film.py`：胶片色彩 LUT、附加效果、创意预设及独立资源准备入口。
- `pixels.py`：源位深读取、float32 调色/ICC、浮点缩放、16-bit 编解码；仅在显示或指定 8-bit 格式的输出边界量化。
- `src-tauri/src/main.rs`：桌面窗口、本地文件选择、服务进程管理。
- `app.py` / `companion.cmd`：保留的旧 Tk 扩展入口，便于对照；新主界面不依赖它。
- `validation/`（项目上一级）：全部测试、样本和验证产物。`node_modules/`、`target/`、`web-build/` 为生成内容，不是手写应用代码，不进 Git。

## 新工作台开发与运行

开发构建需要 Node.js、Rust/MSVC/WebView2，以及 Python 3.12+、Pillow、NumPy、tifffile、PyPNG 和 imagecodecs。当前机器工具链已可用。运行 `npm install` 安装锁定前端依赖，`npm run desktop` 启动开发桌面窗口。

不依赖开发服务器的本机可执行版：先运行 `npm run build`，然后在 `src-tauri` 中运行 `cargo build --features custom-protocol`。程序位于 `src-tauri/target/debug/photo-all.exe`。优化构建可用 `cargo build --release --features custom-protocol`。直接 cargo 构建仅用于开发检查；发行打包通过 package_windows.py 准备并内置独立 runtime，详见 WINDOWS_DISTRIBUTION.md。

可通过 `PHOTOALL_PYTHON` 指定 Python，`PHOTOALL_DATA_DIR` 隔离数据目录，`PHOTOALL_PRODUCT_DIR` 指定服务文件目录。默认使用 `product/data/`。Tauri 自动启动随机端口和随机令牌的回环服务，并在退出时清理进程；不会公开到局域网。首次安装缺少 Pillow 时先执行 `python -m pip install -r requirements.txt`。

前端状态测试：`npm test`；类型与生产构建：`npm run build`；Python 服务测试（项目根目录）：`python -m unittest discover -s validation -p test_service.py -v`。`validation/web_smoke.cjs` 连接真实服务与 RAW 样本测试工作流；`validation/native_smoke.cjs` 验证真实 Tauri 窗口的关闭保存与后台退出。它们使用本机测试运行时，输出只在验证区。

新增工作流回归：`python -m unittest validation.test_workflow validation.test_service -v`。`validation/albums_smoke.cjs` 验证图集、CLIP、批量滤镜与合成保存重开导出。

`validation/lighttable_smoke.cjs` 验证灯箱、拖片、圆形放大镜实际像素变化与镜外可见、显示亮度不改配方、沉浸、缩放、选片撤销/重做、并排、选定范围、保存失败恢复与全屏请求中的退出。`PHOTOALL_NATIVE_LIGHTTABLE=1` 配合 `validation/native_smoke.cjs` 验证真实桌面全屏与有待写入选片时的关闭保存。

以下各节仅记录旧版 Tk / RawTherapee 原生工作台的接口，不代表新主界面布局。

## 旧版原生工作台与扩展

运行 `python app.py --studio` 打开 **RawTherapee 5.13 中文原生专业工作台**。双击 `companion.cmd` 打开原有 Photo All Tk 相册扩展。可设置 `PHOTOALL_PYTHON` 指向自己的 Python。

专业前端使用官方开源 RawTherapee，通过其外部编辑器接口拓展；未把 Tk 窗口包装成专业编辑器，也尚未修改上游前端源码。专业编辑仍使用上游原生曲线、色彩、局部调整等界面。

在 RawTherapee 编辑页下方，点击“在外部编辑器中编辑当前图像”（调色板图标），将当前显影结果发送给 **Photo All - 相册与模板出片**。结果以 16-bit TIFF 保存到 `data/studio-inbox/`，再由扩展导入，继续组图和模板出片。主工作台的完整编辑记录与 Photo All 的轻量配方不是同一套参数；两者通过显影结果互通。

## 文件分工

- `app.py`：全部原生窗口、后台任务和交互。
- `engine.py`：图片读取与色彩、分析、调色、SQLite 相册和导出；内部按章节集中组织。
- `engines/`：独立保存的上游程序与原有许可证资源，不修改、拆散上游文件。
- `data/`：相册、缓存、原生工作台独立配置和显影结果收件箱；不复制用户 RAW 原图。
- 上级 `validation/`：测试脚本、测试样本和验证结果，与成品代码分离。

## 使用流程

1. 导入照片或文件夹（递归扫描），后台读取并建立索引。
2. 按组查看照片。优先使用 EXIF 拍摄时间，否则使用文件修改时间；相邻照片间隔超过 45 分钟建立新组。
3. 多选照片标记保留/排除，或点击“按组推荐保留”。推荐按每组待选且不完全重复的照片取评分靠前约三分之一，仅作初筛。
4. 调整当前照片的风格、曝光、冷暖、对比度和饱和度，300ms 后自动保存。可应用到本组、重置或 Ctrl+Z 撤销。
5. 选择原比例、方形留白或竖版留白模板，导出当前筛选范围内的保留照片；没有保留时导出未排除照片。输出 JPEG 和可读 JSON 配方，重名自动编号。

原图只读，预览和导出采用同一配方函数；持久撤销支持调色和选片，导入不在撤销范围。相册保存原文件路径，移动原文件后需重新导入。导出不携带原始 GPS/EXIF。

## 已有能力与边界

旧版扩展采用 RawTherapee 原生专业前端 + Tk 相册出片，无云端、无账号。当前 React/Tauri 主程序使用私有回环服务；尚未构建手机端；独立 Windows 发行版见上文。旧原生工作台配置隔离在 `data/studio-settings`，默认将 PP3 保存在其缓存中，避免在原图旁生成编辑文件。

支持 JPEG/PNG/WebP/TIFF/BMP，方向校正、带 ICC 图片转 sRGB、透明图白底合成、SHA-256 完全重复标记、启发式质量分数、5 种基础风格、3 种导出布局。dHash 已存储但尚未用于相似照片分组。

扩展的基础调色与模板是 8-bit SDR；RAW 专业显影由真正的 RawTherapee CLI 执行，可在扩展中设置曝光、相机/自动/自定义白平衡、高光压缩、亮度/色彩降噪和 USM 锐化。RAW 首次显影需数秒，结果缓存并复用，解码并发限制为 1，缓存图片限制约 1GiB。失败日志为 `data/raw-cache/last-engine.log`，超时会终止子进程。

导出格式分为：① JPEG 作品，应用 RAW 参数后再应用基础滑杆、风格与模板；② RAW 16-bit TIFF，仅包含专业 RAW 显影参数，全分辨率 sRGB，直接复制引擎生成的 16-bit 数据，并保存对应 PP3，**不包含基础调色滑杆、风格和留白模板**。窗口预览仍为 8-bit SDR，不能用于 HDR 或高位深显示验收。

RAW 格式能否解码依相机型号和引擎支持而定；已验证 Nikon D7000 NEF 与 Canon EOS 5D Mark II CR2。HEIC 仍需可选 `pillow-heif`。尚无 AI 美颜、自动逐张风格适配、端间同步。

## 引擎安装与来源

当前附本机下载的官方 Windows x64 便携版。其他机器可从 [RawTherapee 5.13 官方发布](https://github.com/RawTherapee/RawTherapee/releases/tag/5.13) 下载 `RawTherapee_5.13_win64_x86_64_release.zip`，将完整目录放入 `engines/RawTherapee-5.13/`。对应发布资产 SHA-256：`ba29d23f3f12097c925bdab6d80e831a84ed3a88a81ce94606e4dcc796fa87ee`。也可设置 `PHOTOALL_RAWTHERAPEE` 指向已安装的 `rawtherapee-cli.exe`，同目录须有 GUI 和资源。

[上游源码及 GPL 许可](https://github.com/RawTherapee/RawTherapee/tree/5.13)与随附 `licenses/`、`LICENSE` 等资源保留原样。原生引擎二进制不进入本项目 Git 追踪；对外制作包含引擎的安装包前，还需整理相应源码与第三方依赖的分发材料。

## 验证

当前主程序：在 product 运行 `npm test` 和 `npm run build`；项目根目录运行 `python -m unittest discover -s validation -p 'test_*.py'`。完整测试包含本机 HTTP 与 RawTherapee，需要允许本机网络及原生进程。真实浏览器回归先启动 `npm run dev`，再从项目根目录运行 `node validation/editor_workspace_smoke.cjs`，加 `--readiness` 验证延迟保存与旧画面期间的坐标保护。观片、缓存和原生关闭分别见 `lighttable_smoke.cjs`、`cache_geometry_smoke.cjs`、`native_smoke.cjs`，均使用隔离验证数据。

从项目根目录运行 `python -m unittest discover -s validation -p test_engine.py -v`。测试使用合成图片，不代表真实摄影样本的审美或专业画质验收。界面闭环验证脚本为 `validation/smoke_ui.py`。

真实 RAW 验证：`python validation/test_raw_integration.py`。样本来自 raw.pixls.us，CC0，来源与 SHA-256 记录在 `validation/metadata/raw-samples.json`。测试包含两个相机预览、曝光改变像素、TIFF 三通道实际 16-bit、ICC 和原图校验。受限执行沙箱内降噪可能因系统资源限制退出；本机普通权限运行已通过，不需要管理员权限。

自有代码使用 GPL-3.0-or-later，完整 GPLv3 文本见 `LICENSE`。项目免费提供；GPL 允许他人商业使用并要求按其条款提供相应源码。Pillow、Python/Tk、RawTherapee 及其依赖保留各自许可。
