# 家庭关系咨询系统

本仓库按阶段规划并实现一对夫妻使用的家庭关系咨询系统。当前阶段 A 只实现两个与平台无关的协议模块：按服务器顺序分页读取历史，以及双方对话题、提案和共识的状态转换。它们是供后续适配器使用的纯规则，不包含生产 API、身份认证、持久数据库、模型调用或部署。

阶段 A 的精确设计与范围见[设计规格](docs/superpowers/specs/2026-10-08-family-therapist-design.md)、[系统路线图](docs/superpowers/plans/2026-10-08-family-therapist-roadmap.md)和[协议实现计划](docs/superpowers/plans/2026-10-08-family-therapist-protocol.md)。生产适配器应遵守[协议边界](docs/operations/protocol.md)。

使用本机 Node.js 内置测试运行阶段 A：

```sh
node --test tests/protocol/history.test.mjs tests/protocol/discussion.test.mjs
```

阶段 B 已增加 Responses 工具循环和检查点恢复模块；完整本地测试命令为：

```sh
node --test tests/protocol/history.test.mjs tests/protocol/discussion.test.mjs tests/therapist/responses.test.mjs
```

38 项测试通过。云端 Therapist Skill 已编写；Sites starter 已注册和构建，但产品 API、数据库适配、网页和本地客户端尚未交付。模型列表鉴权成功，实际生成因 API 余额耗尽而阻塞，详见[当前验证记录](docs/verification/2026-10-08-responses-runtime.md)。

本地 Therapist Assistant 的指令源与操作边界已写入 [Skill](skills/local-therapist-assistant/SKILL.md) 和[运维说明](docs/operations/local-assistant.md)，并附有虚构行为评估案例规格。此为文档交付，不是本地客户端、云端消息 API、认证配置、heartbeat 或自动更新实现；阶段 D 仍未完成。
