# 第三方来源与许可边界

本仓库的 MIT 许可证覆盖本项目公开的原创启动器、兼容层、构建和测试代码；不替代第三方组件各自的许可证。源码 Release 不附 DSH npm 依赖树、第三方运行时二进制、微软 MSU、虚拟机系统介质或任何 API Key。

## 上游项目与固定输入

| 项目 | 本次使用的版本/来源 | 许可与说明 |
| --- | --- | --- |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) | `@deepseek-ai/dsh@0.2.0-rc.2`；Win7 修复针对该依赖树 | [MIT](https://github.com/deepseek-ai/deepseek-harness/blob/master/LICENSE)，Copyright (c) 2026 DeepSeek。各 npm 第三方包另有许可。 |
| [sqs404/dsh-portable](https://github.com/sqs404/dsh-portable) | 固定 `v0.2.0-rc.2` release，作为基础 npm 布局输入 | [MIT 与第三方说明](https://github.com/sqs404/dsh-portable/blob/main/THIRD_PARTY_NOTICES.md)；保留下载包内 LICENSE/NOTICE。 |
| [社区 Node Win7 回移植](https://github.com/vladimir-andreevich/node.js-windows-7) | 20.19.2，固定提交 `181c7bf8d5d1173cc7f4649a45da35ceda5aeff3` | [随源码的 Node LICENSE](https://github.com/vladimir-andreevich/node.js-windows-7/blob/181c7bf8d5d1173cc7f4649a45da35ceda5aeff3/v20/node-v20.19.2/LICENSE)，含 MIT 及其依赖说明；不是 Node.js 官方 Win7 发行版。 |
| [PythonVista](https://github.com/adang1345/PythonVista) | CPython 3.12.15 x64 embed 社区回移植 | 保留发行包内完整 `LICENSE.txt`（Python/PSF 及所含组件条款）；它不代表所有第三方 Python 轮子的许可。 |
| [Git for Windows](https://github.com/git-for-windows/git/releases/tag/v2.46.2.windows.1) | PortableGit 2.46.2 x64 | Git 核心 [GPLv2](https://github.com/git-for-windows/git/blob/v2.46.2.windows.1/COPYING)；PortableGit 还含 Bash 等独立组件。发布整包需保留其声明并履行适用的源码提供义务，本仓 MIT 不能覆盖这些内容。 |
| [PowerShell](https://github.com/PowerShell/PowerShell/releases/tag/v7.2.24) | 7.2.24 win-x64 自包含 ZIP | [PowerShell MIT](https://github.com/PowerShell/PowerShell/blob/v7.2.24/LICENSE.txt)；所含 .NET 及第三方组件遵循发行包各自声明。 |
| [Supermium](https://github.com/win32ss/supermium/releases/tag/v150-r2) | v150-r2，150.0.7871.255 x64 nonsetup | Chromium 衍生项目，所含组件具有各自许可/credits；本次源码发布没有重新分发或完成整个浏览器二进制载荷的许可清单审计。 |
| [ripgrep](https://github.com/BurntSushi/ripgrep/releases/tag/13.0.0) | 13.0.0 x64 MSVC | [MIT / Unlicense](https://github.com/BurntSushi/ripgrep/blob/13.0.0/COPYING)。 |
| [Zstandard](https://github.com/facebook/zstd/releases/tag/v1.5.7) | 1.5.7 win64 CLI | [BSD 3-Clause](https://github.com/facebook/zstd/blob/v1.5.7/LICENSE)，另提供 GPLv2 选项；保留实际发行的许可。 |
| [better-sqlite3](https://github.com/WiseLibs/better-sqlite3/releases/tag/v11.10.0) | 11.10.0，Node ABI 115 x64 prebuild | [MIT](https://github.com/WiseLibs/better-sqlite3/blob/v11.10.0/LICENSE)；SQLite 及附带内容另见上游说明。 |

固定 URL、原始归档 SHA-256 及其校验依据见 [dependencies.example.json](dependencies.example.json)。SHA-256 用于固定构建输入，不替代发布者签名、组件许可审查或对未知环境的兼容验证。

## 构建工具与其他 npm / Python 依赖

`win7/tools/package.json` 和 `pnpm-lock.yaml` 记录 esbuild、TypeScript、core-js、undici、pnpm 等直接与传递依赖；`bridge-source/package-lock.json` 记录 MCP SDK 和 zod 等依赖。安装后须保留每个包的实际 LICENSE/NOTICE，不能把锁文件中的包全归入本仓 MIT。构建工具目录不作为本源码 Release 附件发布。

Python site-packages 是构建者独立提供的外部输入。本仓只记录先前测试的版本范围，没有发布这些轮子或声称自动重建完整办公环境。重分发者应逐包检查本地输入的真实来源与许可。

## 明确未包含的内容

桌面应用或 OpenAI/其他供应商的办公技能文本、模板、字体和素材没有被本仓库 MIT 重新授权。公开构建脚本不复制 `office-skills`，公开 profile 也不注册该技能；使用外部依赖的权利不等于具有再分发整个应用资源目录的权利。

Win7 补丁、安装镜像和微软评估系统受其各自条款约束，源码仓库只记录兼容前提，不捆绑、不激活、不延长评估期限，也不自动安装系统组件。
