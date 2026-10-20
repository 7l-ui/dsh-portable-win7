# 从源码准备 Win7 实验包

本仓库公开便携启动器、Win7 适配、构建脚本和离线测试。源码 Release 不含第三方运行时、API Key、办公技能素材、微软更新包或虚拟机。它不是下载源码 ZIP 后即可运行的整包，也尚未实现从空机器一条命令重建所有外部输入。

构建主机使用 Windows 10/11 x64、Node.js 24、7-Zip、x64 MinGW-w64 GCC，以及 npm/pnpm。目标运行环境为 Win7 SP1 x64，并具备 KB3063858、KB2999226 或等效组件；脚本不安装系统更新。先前验收使用 WES7 SP1 x64 同内核评估虚拟机、启用 UAC 后的非提升管理员令牌，不等于所有 Win7 版本或学校机房环境都已验证。新构建的 manifest 保持 `win7VmVerified: false`，必须另行验收。

## 1. 安装源码依赖

在仓库根目录执行。pnpm 锁定文件固定构建工具，`--ignore-scripts` 避免自动为构建主机编译另一个 ABI 的 SQLite；该原生模块在下文单独准备。Node 20 目标使用 ABI 115。

```powershell
npm ci --prefix bridge-source --ignore-scripts --no-audit --no-fund
pnpm --dir win7/tools install --frozen-lockfile --ignore-scripts --config.node-linker=hoisted
```

`win7/tools/node_modules` 需要实际目录布局，便于 `robocopy /XJ` 复制；不要直接使用仅含指向其他磁盘目录链接的依赖树。构建依赖主要为 esbuild 0.25.11、better-sqlite3 11.10.0、TypeScript 5.9.3、undici 6.21.2、core-js 3.41.0、pnpm 9.15.9。全部直接及传递依赖见锁定文件；其许可分别生效。

## 2. 准备基础目录

Win7 适配以 DSH **0.2.0-rc.2** 固定依赖树为输入。`build.ps1` 可下载并校验 [sqs404 的固定发行包](https://github.com/sqs404/dsh-portable/releases/tag/v0.2.0-rc.2)，组装基础目录；它需要构建者自行合法取得的 `primary-runtime`，内含 `runtime.json`、`dependencies/node`、`dependencies/python` 和 `dependencies/pnpm`。本仓库不提供该桌面应用载荷的自动下载、办公 Python 轮子全量重建或重分发授权。

必须显式指定外部路径；脚本不再搜索本机安装目录或原开发工作区的邻居项目。示例路径需替换为自己的输入：

```powershell
./build.ps1 -PrimaryRuntimeSource 'D:\build-inputs\primary-runtime' `
  -GitSource 'D:\build-inputs\git' `
  -BridgeSource './bridge-source' `
  -SevenZipExecutable 'C:\Program Files\7-Zip\7z.exe' -NoArchive
```

默认输出为 `artifacts/DSH-Portable-Windows-x64`，仅作为 Win7 适配的基础。脚本按白名单复制三个 runtime dependency 目录，不复制 `office-skills`；公开 profile 也不注册该办公技能。`-ArchivePath`、`-UpstreamDirectory`、`-OutputDirectory` 可显式指定。基础包 SHA-256 为 `d9b6abeadea953a1974f90ce59de61d47ef366a3b8f60a21c6fc256c9aaf1923`。已经手工准备好等价基础目录时，可直接在下一步配置 `paths.base`。

外部 Python site-packages 必须与 CPython 3.12 x64 ABI 相容，并由构建者核对其来源、许可和目标机兼容性。此前测试组合包含 numpy 2.3.5、pandas 3.0.1、python-docx 1.2.0、python-pptx 1.0.2、openpyxl 3.1.5、Pillow 12.3.0、lxml 6.1.3、XlsxWriter 3.2.9；单独用新版 pip 重装不能自动等同于该测试组合。本仓库不捆绑这些轮子或任何 OpenAI/桌面应用办公技能内容。

## 3. 下载并手工解包固定运行时

[dependencies.example.json](dependencies.example.json) 列出发布者下载 URL、文件 SHA-256 和校验依据。它区分发布者 hash/digest 与本地计算 hash，后者不代表取得了独立签名。下载内容不得擅自替换成同名最新版本。

以下路径相对于配置中的 `paths.research`，默认 `downloads/win7-research`。用 7-Zip 等解压，不执行 Git 的自解压安装程序，不把兼容 DLL 写入系统目录。

| 固定输入 | 解包后必须存在 |
| --- | --- |
| 社区 Node 20.19.2 x64，提交 `181c7bf8d5d1173cc7f4649a45da35ceda5aeff3` | `node/node20-runtime/node-v20.19.2-win-x64/node.exe` |
| PythonVista 3.12.15 embed x64 | `deps/python31215/python.exe` |
| PortableGit 2.46.2 x64 | `deps/git2462/cmd/git.exe` |
| PowerShell 7.2.24 win-x64 | `deps/powershell7224/pwsh.exe` |
| Supermium v150-r2 nonsetup x64 | `deps/supermium150/Supermium/chrome.exe` |
| ripgrep 13.0.0 x64 MSVC | `deps/ripgrep13/ripgrep-13.0.0-x86_64-pc-windows-msvc/rg.exe` |
| Zstandard 1.5.7 win64 | `deps/zstd/zstd-v1.5.7-win64/zstd.exe` |
| better-sqlite3 11.10.0，Node v115 win32 x64 prebuild | `sqlite/build/Release/better_sqlite3.node` |

SQLite release 是 `.tar.gz`，需解开 gzip 与内层 tar 两层。预构建 addon SHA-256 固定为 `1eeaea9a4acb37a35d5057ab76b9ca923b6684df019b1316717f1ea6d9eff1a1`；这是上游 release 二进制，不是本仓库从 C++ 源码独立重编译的结果。直接用构建机 Node 24 的 npm install 生成 `.node` 会得到错误 ABI。

## 4. 配置路径并检查

```powershell
Copy-Item dependencies.example.json inputs.local.json
# 修改 inputs.local.json 的 paths；它不应包含 API Key。
node win7/prepare-inputs.mjs --inputs inputs.local.json --check
# 可选：同时核对已下载的原始归档 SHA-256。
node win7/prepare-inputs.mjs --inputs inputs.local.json --check --archives
```

配置路径相对于该 JSON 文件；`gcc` 可填 PATH 上的 `gcc.exe` 或 x64 MinGW-w64 编译器绝对路径。`prepare-inputs.mjs` 只读检查，不下载、解压、安装或读取密钥。缺输入会列出目录/版本问题并返回非零退出码。

## 5. 在新目录构建

```powershell
node win7/build-win7.mjs artifacts/DSH-Portable-Win7-x64-Rebuilt --inputs inputs.local.json
```

也可用 `--base`、`--research`、`--tools`、`--gcc`、`--sqlite-addon`、`--python-site-packages` 临时覆盖路径；命令行相对路径按当前目录解析。输出目录必须不存在，公开构建不支持断点续跑；检查失败不会创建输出。

构建只修改新输出：编译应用目录 `DSHAPI32.dll`、替换固定 Node 的 ADVAPI32 导入名、转译 JavaScript、应用哈希约束的 Win7 Job 与状态文件兼容修复、复制真实 SQLite/Zstd 实现。原始下载不变。`licenses/win7-transformations.json` 记录转译前后 SHA-256；`manifest.json` 记录版本和默认空密钥状态。没有运行私用密钥预置脚本。

构建包含外部二进制、编译器和时间戳，不承诺字节级可复现。当前源码参数化版本只完成语法、依赖预检和离线测试；未从空输入重新构建并重跑此前虚拟机验收。发布自己的运行时整包前，还须核对各组件许可、版权声明及源码提供义务，尤其 Git 中 GPL 等组件。

## 6. 验证边界

源码测试与 CI 的通过只代表其标出的宿主测试范围。完整运行探针需要包含外部运行时的全新 `validation` 副本，且所有槽位为空；详见 [win7/README.zh-CN.md](win7/README.zh-CN.md)。测试只使用本地 mock，不应把真实 Key、会话或办公文件放入测试产物。

Win7 兼容重点是核心文本交互、文件写入、PowerShell 命令、MCP/HMR 与 Job 进程回收。图片附件、ConPTY 持久终端以及未附带的办公技能不能由上述结果推定可用。
