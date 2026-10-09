# 家庭关系咨询系统

本仓库实现一对伴侣共用的咨询工作流。当前包含：表达 intake 与双人确认协议、持久讨论和历史接口、Responses 工具循环及检查点恢复模块、只读网站查询、成员 Token 与浏览器会话、以及本地 Agent 客户端、同步和运行时模块。网站目前只读；这些实现和本地测试不证明云端模型调用或自动 heartbeat 已在运行。

源码仓库：[callzhang/family-therapist](https://github.com/callzhang/family-therapist)（私有）。网站：[我们之间](https://YOUR_SITE_HOSTNAME)（保持 Sites 原有私密访问范围）。服务端模型配置、密钥和成员校验信息分别存储在 Sites；本地草稿、真实 Token 与测试数据库不包含在源码或发布包内。

开发入口：

```sh
# 全部协议、治疗师、本地客户端和网站测试
node --test tests/therapist/*.test.mjs tests/local/*.test.mjs tests/protocol/*.test.mjs tests/site/*.test.mjs

# 构建网站源代码
npm run build
```

网站源代码位于 [`sites/family-therapist`](sites/family-therapist)。成员 Token 的本地配置和新 D1 初始化流程见[成员 Token 运维说明](docs/operations/member-tokens.md)。不要将明文 Token 或服务端 seed 配置提交到仓库。

生产运行仍有明确门槛：需先在目标 D1 应用审查过的迁移，再通过服务端 `THERAPIST_MEMBER_SEED` 和已认证的 `POST /api/setup` 初始化空空间，并配置只允许预期用户访问的私密 Sites 外层访问策略。部署、schema 变更和权限配置需要按当前平台能力分别执行与验证。实际 Responses API 生成还需要可用的 Provider 余额；此前运行因余额耗尽受阻，见[运行验证记录](docs/verification/2026-10-08-responses-runtime.md)。持久化 Worker、运行时健康、heartbeat/定时执行和外部结果回执也必须在目标环境单独配置并验证；构建、测试或部署成功本身不证明它们已运行。

产品范围和阶段状态见[系统设计](docs/superpowers/specs/2026-10-08-family-therapist-design.md)及[路线图](docs/superpowers/plans/2026-10-08-family-therapist-roadmap.md)。

发布检查包括全部 179 项确定性测试、应用类型检查和 Worker 构建。生产依赖的 5 项已知漏洞已升级至补丁版本，同一生产依赖审计现为 0 项；此结论不包括开发依赖或咨询质量评估，详见[依赖验证说明](docs/operations/production-dependency-security.md)。
