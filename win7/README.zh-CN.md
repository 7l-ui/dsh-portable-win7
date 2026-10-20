# Win7 兼容层开发

完整输入布局与构建命令见 [构建说明](../BUILDING.zh-CN.md)，历史实测范围见 [验证记录](../docs/validation.md)。本目录只提供源码；运行时、微软更新、办公技能和密钥不随仓库分发。

在现代 Windows 构建机使用 Node 24。依赖按 `tools/pnpm-lock.yaml` 安装后，先作只读检查，再输出到一个不存在的新目录：

```powershell
node win7/prepare-inputs.mjs --inputs inputs.local.json --check
node win7/build-win7.mjs artifacts/DSH-Portable-Win7-x64-Rebuilt --inputs inputs.local.json
```

源码兼容测试要求固定版 Zstandard CLI。设置 `DSH_WIN7_ZSTD_PATH` 后运行 `node win7/test-compat.mjs`。工具依赖默认从 `win7/tools/node_modules` 查找；可用 `DSH_BUILD_TOOLS` 指定另一个已安装的依赖目录。构建参数中的 `--tools` 同样指向 `node_modules`，具体用法见构建说明。

`apply-win7-jobs.mjs` 对固定版本的四个命令执行模块进行哈希约束转换。仅 NT 6.1 使用受限单 Job 路径，保持 token/ACL 限制，验证 Job 继承并在超时、取消或命令根退出后回收子孙。`apply-win7-state-rename.mjs` 仅为 NT 6.1 的状态文件原子替换增加有界瞬态错误重试；不直接覆盖文件或绕过持续权限失败。

`compat` 提供 SQLite、TypeScript、Zstandard、util 和 preload 兼容实现；`compat/native` 保存应用目录 DLL 的 C/DEF 源码。构建不会把兼容 DLL 写入系统目录。

完整程序探针需要构建出的独立 `validation` 副本，所有密钥槽位必须为空：

```powershell
# candidate-node 为该验证副本中 runtime/node/node.exe 的完整路径。
candidate-node win7/verify-host.mjs <validation副本绝对路径> <安全报告绝对路径>
candidate-node win7/verify-services.mjs <validation副本绝对路径> <安全报告绝对路径>
candidate-node win7/verify-sandbox.mjs <validation副本绝对路径> <安全报告绝对路径>
```

这些探针会在授权测试副本中创建本地模拟会话、文件和进程，并停止自己启动的实例。请勿使用个人运行目录或真实密钥。宿主结果只能证明对应宿主的行为，不能代替真实 Win7 测试；新的构建保留 `win7VmVerified: false`，不会继承历史候选的结论。

先前实测覆盖 WES7 SP1 x64、KB3063858/KB2999226 组合及非提升筛选管理员令牌。独立标准账户、其他机房策略、图片附件及持久交互终端没有由这些结果得到保证。
