---
title: Open Design 0.16.0
description: 选定方向、保住成果，并在一个值得信赖的创作闭环中完成交付。
---

# Open Design 0.16.0 — 更笃定的创作闭环

🎨 **92 个 PR · 20 位贡献者 · 5 天** — **选定方向、保住成果，并且不再反复猜测交付链路是否可靠。** 过去，视觉指引只覆盖少数产物；Provider 配置看似正常，却可能在第一条 prompt 才失败；长任务或更新完成后，也可能留下错误的文件或运行版本。0.16.0 把这些环节真正连成闭环——从选择风格，到重新打开承载成果的应用。

## 🔥 亮点

- 🎨 **视觉方向终于会跟着你正在制作的内容走。** 风格选择不再只属于 Deck 和 Prototype。Document、Poster 与其他 Image、Video、Web Clone、Wireframe、Mobile 和 Hyperframes 都会看到适合当前产物的视觉目录：内联给出 4 个快捷候选，一键即可进入完整图库。 (#5746)

- 🔔 **产品动态在 Open Design 里有了固定入口。** 首页和项目页顶部新增消息中心铃铛，可查看未读数量、按全部／未读／已读筛选、一键全部已读，并安全打开消息动作；匿名使用时保存在本地，登录后则跟随账号同步。日期会按本地语言显示，关闭按钮也不再需要悬停才能找到。 (#5920, #5954, #5959, #5968) 感谢 @nettee。

- 🔄 **更新后，整个打包应用会保持在同一代版本。** macOS 应用菜单中的“检查更新…”现在会明确告诉你：已经是最新版、正在下载、可重启安装、被进行中的任务阻止，还是应改用手动下载。底层也会让历史 launcher 把桌面控制权交给 active payload，清退过期或隐藏的 outer 进程，并避免 payload 清理让下一次启动失效；macOS 与 Windows 都覆盖在内。 (#5789, #5766, #5678, #5915, #5940, #5955, #5967) 感谢 @PerishCode。

- 🔑 **BYOK 会在错误配置变成失败任务之前拦住它。** 未完成的 Provider 编辑会保留为可恢复草稿，不再覆盖现有可用配置。连接测试与真实任务使用同一路由，能显示已经识别到的 Provider 错误、保留 Provider 返回的模型顺序，并为 MiniMax、DeepSeek 和 MiMo 自动补齐缺少版本段的 Anthropic-compatible 地址。 (#5745, #5712, #5713, #5774, #5807) 感谢 @Siri-Ray、@mturac。

- 🧠 **长任务会保住答案，也会保住随它生成的文件。** 原生 session 接近上下文上限时，会在触发 Provider 错误前，用最近且有用的上下文开启新 session；早期生成的 artifact 不会被冗长事件历史挤掉；已经恢复的子 Agent 不会再把父任务误标为失败；重启后中断的任务会如实收敛；确定无法恢复的失败也会给出有效诊断，而不是继续消耗重试。 (#5816, #5850, #5845, #5817, #5882) 感谢 @Siri-Ray、@tomsen02。

- 🖼️ **图片生成遇到短暂拥塞时不会立刻折断。** Nano Banana 与 custom-image 会尊重 Provider 的短暂退避并重试一次；`gpt-image-*` 参考图编辑也不再发送 endpoint 明确拒绝的参数。短暂的 429 或 503 会变成一次等待，而不是丢失整个创作回合。 (#5702, #5760) 感谢 @Siri-Ray、@xxiaoxiong。

- 🧩 **从大家真正使用的内容开始。** Slides、Image、Video 等非 Prototype 图库会优先展示已有真实使用的模板；空白 seed 和没有预览的卡片不再占据最前面。Prototype 继续保留编辑精选，每个分类的完整目录也都还在。 (#5106, #5881) 感谢 @ScarletttMoon。

- 🧬 **设计系统输入可以像真实仓库那样组织。** 只提供 repo 的创建流程不会误入网站抽取；拆分 token 的包可以把布局 token 放在配套样式表中；常见的 YAML 列表与多行写法也会完整保留作者写下的 metadata。 (#5779, #5797, #5499) 感谢 @mturac、@MuduiClaw、@EthanGuo-coder。

- 🪟 **预览不再要求你先和画框较劲。** 宽桌面页面会自动适应面板，直到你主动选择缩放；历史 Deck 打开后立即响应导航键；turn 结束会打开真正被改写的根 HTML；被安全策略阻止的资源会说明失败的项目内路径，同时不泄露 symlink 指向的位置。 (#5751, #5755, #5577, #5784) 感谢 @lefarcen、@maxmilian、@mturac。

- 🛡️ **本地能力更强，本地边界也更严。** 导入项目不能暴露隐藏凭据文件；插件卸载不能逃出自己的 registry；远程市场不能借请求转向私网；保存的网站证据不会重放第三方脚本；一个项目的 conversation 也不能被接到另一个项目的 run 上。 (#5857, #5855, #5880, #5503, #5813) 感谢 @tomsen02、@wiggdevin。

## ✨ 新增

### 🚀 部署与集成

- **发布前先预览。** Cloudflare Pages 部署现在会在界面和 `od deploy --target … --json` 中明确区分 Preview 与 Production。Preview 会返回独立 URL，不会替换线上生产域名。 (#4576) 感谢 @cbeaulieu-gt。

- **Kiro 加入 MCP 配置选择器。** 可直接从设置中复制正确的共享 server 配置，再放入 Kiro，无需手动把其他客户端的格式翻译一遍。 (#5275) 感谢 @BusanGukbap。

## 🔁 变化

### 🔑 模型、媒体与记忆

- **模型列表遵循 Provider，而不是字母表。** 在线目录的原始顺序会被保留；过期的 Moonshot 与 DeepSeek 默认值会迁移到实际可用的优选 ID；设置与 onboarding 也共享同一份真相。 (#5774) 感谢 @Siri-Ray。

- **Memory 可以复用已经保存的 MiniMax key。** 支持文本的媒体凭据不再被误判为缺失；只有图片或音频能力的 Provider 会得到明确的“不支持”提示和下一步建议。 (#5767) 感谢 @lefarcen。

- **执行模式切换后，界面会立即跟上。** 切换到 BYOK 时 composer 图标会马上更新；Local CLI 的自定义模型字段在清空后也会保持为空。 (#5379, #5749) 感谢 @yashrao2607、@jzhishu。

## 🐛 修复

### 🧠 Agent 与任务

- **MCP follow-up 真的能听到 follow-up。** 复用 conversation 时，最新 prompt 会被送进恢复的 session，不再出现“成功结束但没有任何新工作”。 (#5851) 感谢 @mturac。

- **重启与持久化的边缘情况不会再把对话留在半空。** 即使 native session 写入失败，headless turn 仍能收尾；取消的任务不会被迟到的错误重新标成失败；daemon 返回后，中断消息也不会永远停在 queued 或 running。 (#5808, #5904, #5817) 感谢 @mturac、@Siri-Ray。

- **ACP 历史会去掉空噪音，而不是丢掉真实工作。** 只有协议状态的 frame 在刷新后不再变成空白可展开行，真正的工具事件仍会保留。 (#5145) 感谢 @xxiaoxiong。

- **较早的 Windows CPU 也能获得兼容的 OpenCode runtime。** 不支持 AVX2 的机器会使用 baseline build，并得到明确更新路径，不再重复触发确定性的 illegal-instruction 崩溃。 (#5733) 感谢 @lefarcen。

### 🖼️ 预览与界面

- **细小的视觉信号重新变得可信。** 浏览器抽取失败会保持清晰红色提示；模型选择器不会跑出可视区域；Open Design Website Clone 示例也会在首屏加载真实 logo。 (#5454, #5907, #5765) 感谢 @xxiaoxiong、@lefarcen。

## 🙏 感谢所有参与 0.16.0 的贡献者

@alchemistklk · @BusanGukbap · @cbeaulieu-gt · @EthanGuo-coder · @joeylee12629-star · @jzhishu · @lefarcen · @maxmilian · @mrcfps · @mturac · @MuduiClaw · @nettee · @PerishCode · @ScarletttMoon · @Siri-Ray · @tomsen02 · @VikingOwl91 · @wiggdevin · @xxiaoxiong · @yashrao2607
