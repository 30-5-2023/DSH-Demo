# Agent Note：工单服务拥有的动态交互表单

Status: implemented

[English](2026-09-22-business-agent-dynamic-forms.md) | 中文

## Problem

任意工单活动都可能需要类型化用户输入或澄清。模型响应具有概率性，不能成为稳定 UI 协议的来源。原有业务集成只有文本唤醒提示，没有一条可重放的路径把服务拥有的输入请求变成左侧表单，再把用户值交回权威活动状态机。

## Decision

工单服务拥有与活动类型无关、带版本的 `interaction-request`，并通过 `interaction.required` 只发布路由标识。唤醒适配器要求已绑定的 DSH Agent 调用 `mcp__workorder__get_interaction_request`。Agent-scoped 展示投影把 MCP `structuredContent` 持久化为 `tool/result.meta`，业务 Client toolview 校验该元数据后才按固定字段词汇渲染。

Client 不调用工单写接口。它把提交值记录成 Session UserMessage，要求 Agent 调用 `mcp__workorder__submit_interaction_response`。服务校验字段值、版本、归属和幂等键后，才把活动从 `waiting` 改为 `running`。

MVP 字段词汇为 `text`、`textarea`、`integer`、`date`、`boolean`、`select`、`multi-select` 和 `resource`。资源值包含平台 `resourceId`；文件上传是独立操作。任意 HTML、脚本、远程组件和模型散文都不是表单定义。

## Alternatives considered

**复用 `dsh-user-questions`。** 否决，因为它的问题词汇不能表达业务字段校验或资源引用。

**解析模型散文。** 否决，因为文案变化会改变 UI 行为，Session 重放也不会携带经过校验的表单定义。

**让浏览器写工单。** 否决，因为这会绕过模型可见的 Session 输入、MCP 授权、幂等和审计。

**把 A2A 作为表单协议。** 否决，因为手工、质检和工具活动需要相同交互。A2A 执行器可以把自身的 input-required 状态映射为服务交互，但不拥有 UI 协议。

## Consequences

工单服务、Host 适配器和 Client 分别校验各自的线协议输入。`activity.changed` 保持为看板刷新信号，`interaction.required` 是唯一表单唤醒信号。当前 mock 在内存中保存交互和幂等结果，并接受已有资源标识；生产部署仍需持久化交互记录、事件重放、资源授权和审计保留策略。
