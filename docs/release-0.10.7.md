# Photo All Studio 0.10.7

相较 [GitHub 0.10.6](https://github.com/YZH2006517/Photo-All/releases/tag/v0.10.6) 的更新。

- **胶片收藏室**：新增三维胶卷架、桌面和展片动画。图集按每卷最多 36 帧分卷，每架可放 14 卷，支持新建、切换和移架。可自定义暗盒外观，使用光学观片器的实体摇杆或电子观片器翻片，支持全屏沉浸和视角调整。
- **光谱胶片模拟**：加入 Spektrafilm 光谱运行时，可调胶片、冲印、放大机滤色、预闪、耦合剂、光晕、颗粒和光源，支持实拍负片扫描冲印。光谱工艺和快速预设共用一个面板，片种列表和快速预设默认折叠。
- **原尺寸编辑预览**：主画布、原图对比和实时底图读取原尺寸像素。显卡无法容纳整张实时纹理时，调节完成后刷新原尺寸预览。修复拖动对比条时出现的浅色竖条。显示用 8-bit，导出仍支持 16-bit PNG/TIFF。
- **片边和导出**：新增 35mm、120、扫描毛边、幻灯片和相纸留白等片边，可自定义卷名、日期、帧号、签名和拍摄信息。默认导出原尺寸 8-bit JPEG，片边可随照片配方导出。
- **导入、预览和回收站**：改进 JPEG 缩略图解码和 RAW 显影缓存复用，观片台复用已加载的浏览预览。已收纳或平铺的照片不重复播放同一动画。修复没有图集时删除照片后，照片没有出现在回收站的问题。
- **显存定档**：双显卡设备取最大专用显存。无法读取时使用固定默认设置。编辑器原尺寸预览不受定档影响。

此 Windows 预发布包提供胶片收藏室，创作暗房的实验入口保留在源码中。安装包为未签名构建。内置光谱运行时后，安装包约 319 MiB，便携 ZIP 约 474 MiB。

## 下载

- [下载安装 EXE](https://github.com/YZH2006517/Photo-All/releases/download/v0.10.7/Photo-All-Studio_0.10.7_x64-setup.exe)：Windows 10/11 x64 安装包，支持手动覆盖升级。
- [下载便携 ZIP](https://github.com/YZH2006517/Photo-All/releases/download/v0.10.7/Photo-All-Studio_0.10.7_windows-x64.zip)：完整解压，打开 `Photo All Studio.exe`，保留同目录的 `runtime`。
- [SHA256SUMS.txt](https://github.com/YZH2006517/Photo-All/releases/download/v0.10.7/SHA256SUMS.txt)：下载校验值。

已核对安装程序与便携 EXE 版本、ZIP 完整性及随附源码。浏览器测试覆盖胶片架切换、光谱参数与折叠交互、对比分割线，以及 PNG 和 NEF 的原尺寸预览。本次未执行完整安装升级测试。

## 对应源码

- `Photo-All-Studio_0.10.7_source.zip` 与此发行标签对应，包含构建脚本、依赖锁文件和场景资产。
- `spektrafilm-photo-all.patch` 记录本包对固定版本 Spektrafilm 运行时的修改。
- RawTherapee、Spektrafilm 上游及相关依赖沿用 [第三方对应源码归档](https://github.com/YZH2006517/Photo-All/releases/download/v0.10.0/Photo-All-third-party-corresponding-source.zip)。
- 开放 LUT 沿用 [原始归档、许可和转换材料](https://github.com/YZH2006517/Photo-All/releases/download/v0.10.0/Photo-All-open-filter-sources.zip)。

[完整代码差异](https://github.com/YZH2006517/Photo-All/compare/v0.10.6...v0.10.7)
