# Photo All Studio 创作暗房接手索引

从仓库根目录 `F:/PHOTO ALL` 打开这些文件。优先读 `product/ui/WetLab.tsx`，创作暗房的大部分逻辑都在这里。

| 文件 | 负责什么 |
| --- | --- |
| [WetLab.tsx](../product/ui/WetLab.tsx) | 创作暗房主文件。开头的 `SERUMS`、`CreativeMix`、`creativeRecipe` 和 `creativePatch` 定义药剂、配方状态及照片参数映射。中段的 `makeStudio` 负责四个 3D 场景、器具、灯光、相机、拖拽计量、倾倒、显影和晾晒动画。底部的 `WetLab` 负责导航、选片、撤销、预览和应用配方。 |
| [darkroom.css](../product/ui/darkroom.css) | 创作暗房的导航、提示、发光刻度等界面样式，主要搜索 `.cl-` 和 `.creative-lab`。材质、灯光和器具形状在 `WetLab.tsx` 里改。 |
| [Darkroom.tsx](../product/ui/Darkroom.tsx) | 观片暗房和胶卷架。导出的 `Darkroom` 在观片与创作暗房之间切换，`darkroomRolls` 按图集把照片分成最多 36 张一卷。 |
| [App.tsx](../product/ui/App.tsx) | 首页入口和返回路径。`openDarkroom` 打开暗房，传给 `Darkroom` 的 `onApply` 把配方写回当前照片。 |
| [LivePreview.tsx](../product/ui/LivePreview.tsx) · [model.ts](../product/ui/model.ts) | 前者负责 WebGL 即时预览。后者负责预览请求、缓存及显存分档，搜索 `draftBlob`、`liveBaseBlob`、`previewGraphics`。 |
| [service.py](../product/service.py) · [pixels.py](../product/pixels.py) | 后端精细预览与像素渲染。精细预览入口是 `/api/draft-preview`，实时预览的底图和 LUT 来自 `/api/live-base` 与 `/api/live-look`。 |

**数据流**　拖瓶、定量、拨表或显影 → 更新 `CreativeMix` → `creativeRecipe` 生成预览配方 → 点击「应用到照片」时用 `creativePatch` 保存变化。原片保持只读。药剂、时间和温度在这里用于创作调色映射。

**验证入口**　[wetlab.test.ts](../validation/wetlab.test.ts) 检查配方和流程逻辑，[wetlab_smoke.cjs](../validation/wetlab_smoke.cjs) 检查场景与指针交互。历史设计记录见 [创作暗房](research/2026-11-03-creative-darkroom.md) 和 [工坊](research/2026-11-03-wetlab.md)，以当前源码为准。
