# 业务工单 UI 插件

[English](README.md) | 中文

这个双端 Client 插件负责 DSH 右侧栏中的只读工单页面。Task 2 只交付浏览器生命周期标记；Task 5 会用实时页面替换它。

这个包使用本地 `tsdown` 配置，因为仓库共享的 Client preset 有意只发现 `packages/*/*`。生成的 `lib/client.js` 遵循相同的 `window.__ModuleLoader__` 注册协议，并由工件生命周期测试覆盖。

## 验证

```sh
pnpm --filter @deepseek-ai/dsh-business-workorder-ui build
pnpm --filter @deepseek-ai/dsh-business-workorder-ui test
```

## 模型体验

无。这个包只负责浏览器端展示。

## 已知限制

Task 2 构建不渲染工单内容。实时只读页面及其加载、等待与错误状态属于 Task 5。
