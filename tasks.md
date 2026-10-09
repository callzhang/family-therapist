# 实施阶段

- [x] **阶段 A：协议规则。** 历史分页/快照和双方讨论状态的纯函数模块及回归测试已实现；生产适配边界已记录，已由主 Agent 完成代码审阅与 15 项测试验收。该阶段不含真实认证、持久化、API 或部署。
- [ ] **阶段 B：云端咨询与可靠运行。** 先核实 Sites 与后台续接能力、Responses API 工具循环、模型配置及两层身份权限，再规划并实现持久 API 和咨询流程。模型 API 凭证配置的前置条件是具备可用的 OpenAI Developers 插件并按其密钥流程配置；Codex 登录不能替代 API Key。

  已完成本地 Responses 工具循环与检查点恢复（23 项测试）、云端 Therapist Skill 的格式检查、私密 Site 注册与 starter 构建。项目 Key 已安全配置，模型列表鉴权 HTTP 200；生成请求因 `credit_balance_exhausted` 返回 429，尚未证明真实工具执行或咨询质量。数据库/身份适配、后台任务和产品页面仍未完成。证据见 `docs/verification/2026-10-08-responses-runtime.md`。
- [ ] **阶段 C：只读网站与文件。** 依赖阶段 B 的持久数据与访问控制，建设只读页面、档案生成和访问验证。
- [ ] **阶段 D：本地 Skill、同步与升级。** 依赖阶段 B 的实际 API 与凭证流程，建设本地助手、同步客户端、心跳和可恢复升级。

  已交付本地 Assistant 指令源（`skills/local-therapist-assistant/`）、操作边界说明（`docs/operations/local-assistant.md`）和虚构行为评估案例规格（`evals/local-assistant/case-spec.md`）。这不代表真实 API/成员认证、同步客户端、定时 heartbeat、设备安装或升级器已完成；这些仍等待阶段 B 的可验证传输配置与后续客户端实现。
