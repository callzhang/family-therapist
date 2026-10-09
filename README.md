# 家庭关系咨询系统

本仓库按阶段规划并实现一对夫妻使用的家庭关系咨询系统。当前代码包括历史和讨论协议、成员 Token API 边界、只读网站查询适配器，以及本地验证过的表达 intake 和持久讨论命令。网站仍只读；命令 API 不代表 Therapist worker、模型调用或生产部署已经完成。

阶段 A 的精确设计与范围见[设计规格](docs/superpowers/specs/2026-10-08-family-therapist-design.md)、[系统路线图](docs/superpowers/plans/2026-10-08-family-therapist-roadmap.md)和[协议实现计划](docs/superpowers/plans/2026-10-08-family-therapist-protocol.md)。生产适配器应遵守[协议边界](docs/operations/protocol.md)。

使用本机 Node.js 内置测试运行阶段 A：

```sh
node --test tests/protocol/history.test.mjs tests/protocol/discussion.test.mjs
```

阶段 B 已增加 Responses 工具循环和检查点恢复模块；完整本地测试命令为：

```sh
node --test tests/protocol/history.test.mjs tests/protocol/discussion.test.mjs tests/therapist/responses.test.mjs
```

协议及持久化 SQLite 集成测试涵盖双人确认、CAS 并发、原子回滚和不可覆盖的 UUID 回执。云端 Therapist Skill 已编写；Responses API 实际生成曾因余额耗尽而阻塞，详见[当前验证记录](docs/verification/2026-10-08-responses-runtime.md)。本地测试和构建不代表 hosted migration、线上运行或外部执行结果。

本地 Therapist Assistant 的指令源与操作边界已写入 [Skill](skills/local-therapist-assistant/SKILL.md) 和[运维说明](docs/operations/local-assistant.md)，并附有虚构行为评估案例规格。此为文档交付，不是本地客户端、云端消息 API、认证配置、heartbeat 或自动更新实现；阶段 D 仍未完成。
