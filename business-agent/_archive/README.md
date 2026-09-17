# _archive — 讨论存档

**设计时不要读这里。** 当前设计只有一份：[../DESIGN.md](../DESIGN.md)。目录里的路径按归档前的位置写，链接可能已失效——这里只负责留住「当时为什么这么定、否掉了什么」。

| 文件 | 原来是什么 |
|---|---|
| `ARCHITECTURE.md` | 上一版设计总览。领域模型、状态机、七条规矩、事件载荷字段等细节压在这里，`DESIGN.md` 只取了架构、边界、原型与时序 |
| `FEATURES.md` | 特性登记表（编号、状态、实现方式、验证命令、变更记录） |
| `requirements/0001-workorder-execution-pane.md` | 右侧页面为什么这么设计、默认页怎么抢过来、挂载方式；含已作废的 10 个自建工具设计 |
| `requirements/0002-conversation-pipeline-interaction.md` | 左右交互：唤醒原语、进度行为什么不能走自定义会话事件、绑定怎么读 |
| `requirements/0003-left-right-system-split.md` | 服务边界：为什么拆两个系统、三张脸怎么来的、事件面为什么用 SSE |
| `requirements/README.md`、`TEMPLATE.md` | 需求澄清文档的存放规则与模板 |

归档原因：细节与架构混在一起会带偏判断。**先把架构对齐，末端细节后补。**
