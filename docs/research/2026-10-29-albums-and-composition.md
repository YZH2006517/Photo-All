# 图集、分类与合成（2026-10-29）

目标：新建图集 → 导入文件夹 → 按视觉或内容选片 → 批量滤镜 → 多图层合成与导出。
沿用 React / Motion / Tauri 界面，RawTherapee 负责 RAW 显影，所有原文件只读。

## 调研与取舍

| 项目 | 可复用思路 | 本次取舍 |
| --- | --- | --- |
| [PhotoPrism](https://docs.photoprism.app/developer-guide/metadata/colors/) | 主色、颜色索引 | 参考设计，自写轻量本地特征分析，不嵌入整个服务 |
| [Immich](https://docs.immich.app/features/searching/) | CLIP 内容检索 | 使用相同技术类别，不搬运 Postgres / 服务端架构 |
| [CLIP ONNX](https://huggingface.co/Xenova/clip-vit-base-patch32) | 图像与文字向量、零样本分类，模型卡 MIT | 固定 revision，ONNX Runtime 本地推理；中文展示对应固定英文提示词，不宣称支持任意中文搜索 |
| [Compositor](https://github.com/robbietilton/Compositor) | 图层、透明度、混合模式 | 原版为 macOS 工程；本版实现独立的跨平台合成模块，不能称为原版引擎移植 |
| [CompositorWindows](https://github.com/Cengokill/CompositorWindows) | Qt / Direct3D Windows 移植 | 技术框架与当前 WebView 不同，不引入第二套窗口 |
| [Konva](https://github.com/konvajs/konva) | 画布交互、变换 | 第一版画布交互规模小，先用浏览器原生指针事件；预览与导出统一由同一 Pillow 合成函数生成 |

## 数据与界面

图集是持久化对象，照片通过关联表加入图集，同一原片可属于多个图集，不复制或移动原图。老照片首次迁移加入“已有照片”，重启不重复迁移。空图集可以存在。首页以拼贴封面呈现图集，提供新建名称输入，进入后导入文件夹或文件。

在导入时计算中性原片的主色、色板、冷暖、亮度与饱和度。分类是当前图集内的视图，不改动图集成员。提供日期、主色、冷暖、亮度、内容类别，允许组合筛选；“选择此类”将当前结果加入多选，再选择滤镜批量应用。初选保留已有精选/排除决策，自动推荐只是启发式候选。

识图按钮执行真实 CLIP 分类，固定十余个摄影内容类别，低置信度标为“待确认”。模型首次准备需要联网下载，图片不会上传；准备好后完全本地。分类结果保存模型版本、分数与候选标签；允许重新分析。颜色不代替语义，语义不代替摄影审美。

合成工作区从当前选片创建，支持图层排序、显示隐藏、透明度、正常/正片叠底/滤色/叠加/变暗/变亮混合、位置、缩放与旋转，项目保存在照片库 SQLite，保留各图层创建时的修图配方快照。预览和 PNG 导出使用相同的 sRGB 8-bit 合成器，支持透明背景。不宣称 PSD、蒙版、笔刷或 16-bit 多图层支持；专业 RAW 16-bit 导出继续走现有 RawTherapee 路径。

## 实施与验证顺序

1. 测试先行：创建/重开图集、跨图集同文件导入、旧库迁移、颜色/冷暖/亮度及像素混合。
2. 扩展 `engine.py` 的 SQLite；新建集中模块 `workflow.py` 放视觉特征、CLIP 和合成计算；通过 `service.py` 受认证接口访问。
3. `ui/Albums.tsx` 放首页与分类控件，`ui/Composite.tsx` 放合成工作区；现有 `App.tsx` 连接范围和批量操作，避免继续堆大主文件。
4. 运行真实本地模型，使用公开测试图片验证内容分类；记录模型来源与版本，不用文件名推断内容。
5. Python / TypeScript 回归检查、真实浏览器图集全流程、合成保存重开及 PNG 检查，最后构建桌面 Release。

所有测试输入与生成物保留在 `validation/`；成品代码与模型运行时在 `product/`。
