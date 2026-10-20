# DSH Portable · Windows 7 实验适配

把 DeepSeek Harness 的便携启动、配置和 Win7 兼容改动整理为可审查的源码。目标是 **Windows 7 SP1 x64**，让已构建的目录在具备所需系统组件的电脑上解压运行，数据和配置随目录保存。

**本次 Release 只有源码，没有可直接运行的成品 ZIP。** 仓库不含 API Key、第三方运行时、办公 skills、私人配置或运行记录；完整构建仍需自行准备固定版本的外部输入，见 [构建说明](BUILDING.zh-CN.md) 和 [第三方说明](THIRD-PARTY-NOTICES.md)。这是社区实验适配，不是 DeepSeek 官方 Win7 发行版。

## 已实现的适配

- 便携启动器、独立数据目录、停止脚本、环境检查和本地 MCP 桥接。
- 三个 Key 配置槽；公开模板全部为空，默认选择 DeepSeek 官方，也可选择 OpenCode Go。
- 固定社区 Node 20.19.2 配合应用本地兼容 DLL；补充部分较新 Node API、SQLite、TypeScript 和 Zstandard 适配。
- Win7 受限命令采用单层 Windows Job，处理取消、超时及命令根进程退出时的子孙回收。
- 随包运行时的组装逻辑：PowerShell、Python、Git、ripgrep 与 Supermium 浏览器；对应二进制需从各自上游获取。

## 系统要求与验证范围

目标系统是 **Win7 SP1、64 位、NT 6.1.7601**。验证环境具备 **KB3063858、KB2999226 或其等效组件**；缺失组件需要管理员安装，项目不会自动改动系统。不能把此项目当作裸 Win7 SP1 零安装运行的保证，也没有证明这两个补丁是绝对最小集合。

2026-10-19，历史候选在 **Windows Embedded Standard 7 SP1 x64** 虚拟机通过非提升权限测试：本地 mock 驱动的 `write`、`load_workspace_dependencies`、`pwsh` 三个真实工具调用，浏览器页面、MCP、配置热重载，以及七项命令沙箱检查、六个子孙进程回收。测试令牌来自管理员账户经 UAC 筛选后的非提升令牌，**没有单独测试独立标准账户**。

虚拟机没有发送真实云端模型请求；实际学校电脑的补丁、权限和网络仍可能不同。此次公开版对构建路径作了参数化整理，**尚未从公开源码完整重建并重新验证同一成品**。图片附件和持久交互终端未保证。详见 [验证记录与限制](docs/validation.md) 和 [结构化摘要](docs/validation-summary.json)。

## 获取和构建

1. 在现代 Windows x64 构建机准备 Node 24、构建工具及 [构建说明](BUILDING.zh-CN.md) 列出的外部输入。
2. 按 `dependencies.example.json` 建立自己的本地输入配置，先执行只读输入校验。
3. 运行 Win7 构建脚本，输出到一个新的目录；保留第三方许可证并自行完成目标机验收。
4. 在有写入权限的短路径解压成品，运行 `配置密钥.cmd` 填入自己的 Key，再运行 `启动 DSH.cmd`。

不要直接双击仓库内的模板脚本：源码目录尚未具备运行时和 DSH 应用。Key、会话、日志和浏览器数据应留在自己的构建或运行目录，不能提交到仓库。安全问题请参阅 [SECURITY.md](SECURITY.md)。

## 开发检查

```powershell
npm test
npm run check:syntax
npm run audit:self-test
npm run audit
```

兼容层测试另需按构建说明安装 `win7/tools` 的锁定依赖，并把 `DSH_WIN7_ZSTD_PATH` 指向固定版 `zstd.exe`，再执行 `npm run test:compat`。GitHub Actions 在现代 Windows 和 Node 24 上运行源码检查，**不代表 Win7 虚拟机验收**。

## 来源和许可证

本仓库的便携包装、兼容层及构建脚本按 [MIT](LICENSE) 发布。第三方组件保留各自许可证，不因本仓库的 MIT 授权而改变；详见 [第三方说明](THIRD-PARTY-NOTICES.md)。

- [DeepSeek 官方 Harness](https://github.com/deepseek-ai/deepseek-harness)：应用上游。
- [sqs404/dsh-portable](https://github.com/sqs404/dsh-portable)：本项目固定便携基础输入的来源。
- [发布说明](RELEASE_NOTES.md)：本次源码发布的内容与边界。
