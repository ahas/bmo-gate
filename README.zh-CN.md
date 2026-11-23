[English](README.md) | [한국어](README.ko.md) | [日本語](README.ja.md) | **简体中文**

# bmo-gate

把一轮对话的闸门阶段做成一个独立的服务。从聊天接收器组装好本轮的信封,到智能体的回答回到房间,这期间闸门负责:

- **把参考资料交给本轮**,不做挑选:每位发言者的资料卡开头、房间中到期的记忆,以及本轮事件唤起的条目;同时提供大脑的
  索引、索引片段和索引搜索,智能体通过它们自行读取大脑的其余内容;
- **翻译**工作者或文档需要的其他语言内容,并保存这些译文;
- **记录**收到的每一项判断,以及每次运行所走的路径。

闸门顺序中不含任何闸门:智能体自己排版回复,自己维护会话(`docs/gates.md`)。本轮可能使用的大型文本模型不在这里:它是
一个独立的、兼容 OpenAI 的端点,闸门只以注册信息的形式访问它。

访问其他所有单元都只通过标准 API;在其他仓库中,只能依赖基础库 `bmo-chat`、`bmo-chat-client` 和 `bmo-ui`。

## 目录

| 目录 | 内容 |
|---|---|
| `crates/` | 构成根包的 Rust crate:契约及其客户端、存储、错误码、通往其他单元的端口、策略、词语、标记、运行、翻译阶段、参考资料路径、服务路由以及单元命令 |
| `deploy/` | 测试台的部署在运维机器上维护的服务单元 `bmo-gate-server.service`,以及标记为 `retire`、由部署停止、禁用并取消链接的单元 |
| `docs/` | 先于代码的文档:从 `docs/layout.md` 读起,公开 API 见 `docs/api.md`,其机器可读形式见 `docs/openapi.json` |
| `package/` | 由 `docs/openapi.json` 生成的 TypeScript 客户端 |
| `runtime/` | GGUF 引擎的单元模板和节点配置(`docs/gguf-llm.md`) |
| `src/` | 根包:版本、`gate-server` 二进制和 `bmo-gate` 单元命令 |
| `tests/` | 仓库的全部测试 |
| `tools/` | 工具宿主放置的工具:翻译工具 `gate/translate`,以及大脑索引工具 `gate/reference_index`、`gate/reference_piece` 和 `gate/reference_search`,各自带有清单、模式、手册和可执行文件 |
| `training/` | 部署在运维机器上运行的工具集:一个独立的 Bun 项目,用于把 GGUF 模型放置到节点上(`docs/gguf-llm.md`) |

`PERSONAL-DATA.md` 规定了任何文件都不得包含的个人数据:属于谁、哪些算在内、值应当放在哪里,以及确保这一点的检查。

## 检查改动

- `cargo check --workspace --all-targets`:静态检查。
- `cargo fmt --all --check` 和 `cargo clippy --workspace --all-targets -- -D warnings`:评审。
- `cargo test`:全部测试,包括仓库检查。个人数据检查属于测试台的快速检查,已在声明中启用。

## 版本

版本号同时写在 `VERSION` 和工作区清单中,两者一致。按照 bmo-chat 的 `docs/conventions.md`「Versions」,版本只在所有者
宣布发布时才变动;提交、部署、修复或契约变更都不会改变它,部署通过提交来区分。

## 许可证

MIT。许可证全文见 `LICENSE`,所有清单都声明了同一许可证。
