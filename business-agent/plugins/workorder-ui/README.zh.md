---
description: "在 DSH 右侧栏只读展示工单进度，包括权威快照刷新、实时连接状态、活动资源，以及本地化的加载和失败状态。"
kind: "package-reference"
---

# 业务工单 UI 插件

[English](README.md) | 中文

## 摘要

这个页面让用户跟踪 MVP 工单，同时保持对话为唯一写入入口。它从业务服务读取完整快照，只把 SSE 帧用作请求新快照的信号。活动列表在桌面和窄宽度下展示活动顺序、状态、人工阻塞情况以及输入或输出元数据。

## 目录

- [使用此包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

业务 Bundle 挂载此插件，并通过右侧栏引导页提供工单页面。

```yaml
- name: '@deepseek-ai/dsh-business-workorder-ui'
```

可单独构建并验证它的浏览器工件：

```sh
pnpm --filter @deepseek-ai/dsh-business-workorder-ui build
pnpm --filter @deepseek-ai/dsh-business-workorder-ui test
```

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节 — 点击展开</summary>

Tab 定义和按键注册的 body 使用公开右侧栏注册表。Body 在浏览器输入处校验每个 HTTP 快照和 SSE 版本，收到较新事件帧后重新拉取完整快照，并在事件流断开时保留最近一次快照。本包的构建配置生成浏览器闭包并编译 CSS Module，因为共享 Client 包发现机制只覆盖 `packages/*/*`。

</details>

-----

<a id="model-experience"></a>
## 模型体验

无。这个包只在浏览器中展示服务状态，不提供模型可见输入。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 本地 MVP 固定展示 `http://127.0.0.1:8090` 中的 `WO-MVP-001`；部署配置和当前会话工单选择尚不可用。
- 进程重启会重置业务服务，页面会重新连接到新的种子快照。
- 资源行只展示元数据，不能打开或下载内容。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
