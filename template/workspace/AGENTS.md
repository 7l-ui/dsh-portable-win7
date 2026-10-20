# 便携工作区

始终使用简体中文回复。

这是 DSH 便携包的默认工作区。成果保存在当前目录；未经用户指示，不向其他项目写入文件。

Python、Node.js、pnpm 和办公库已经随包提供。编写办公文档或数据脚本前，调用 `load_workspace_dependencies` 获取当前解压位置下的解释器与库路径；不要假定原电脑的路径仍有效，不必安装系统 Python。Word、Excel、PowerPoint 任务可使用随包提供的 `office-docx`、`office-xlsx`、`office-pptx` 技能。

Git 由启动器加入本次运行的 PATH。需要第三方业务库或额外编译器时，先检查当前任务要求，再决定是否安装；不要把尚未安装的工具当作可用。
