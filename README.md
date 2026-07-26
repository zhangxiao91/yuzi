# 余字

《余字·未寄出的信》是一款五回合生成式文字构筑游戏。玩家只能搬运完整意群：把手里的词组排序成一句话，让世界续写，再从续写中剪下最多两个意群。被剪下的意群会从整份手稿中消失，并在重新写回世界前保持禁用。

目标是在天亮以前，让她亲手读到并理解那封信。胜负由玩家最终句和结构化世界状态共同判断，模型只负责生成世界回应与可剪候选，不负责裁决。

## Local development

```bash
npm install
cp .env.example .env.local
cp .dev.vars.example .dev.vars
npm run dev
npm run dev:worker
```

前端默认运行在 `http://127.0.0.1:4174/lab/yuzhi/game/`，Worker 默认运行在 `http://127.0.0.1:8792`。开发环境可使用 Cloudflare Turnstile 测试令牌。

## Commands

- `npm run typecheck`: 检查前端、共享领域与 Worker 类型。
- `npm test`: 运行领域和 Worker 边界测试。
- `npm run build`: 生成 Vite 静态产物。
- `npm run deploy:dry`: 校验 Worker 配置和部署包。

## Architecture

- `shared/`: 确定性领域状态机和跨端类型。
- `src/`: React 游戏界面；只保存短会话凭据和本地残稿。
- `worker/`: Cloudflare Worker、Durable Object、Turnstile、限流与 AI Gateway 客户端。
- `docs/game-design.md`: 完整玩法规则、状态不变量与 MVP 边界。

生产环境只在 Worker secrets 中设置 `TURNSTILE_SECRET_KEY` 和 `ZXLAB_AI_GATEWAY_TOKEN`。浏览器永远不接触模型凭据。ZXLab 以 git submodule 固定本仓库版本，并把静态构建嵌入同源 `/lab/yuzhi` 页面。

## License

Source available for inspection and personal experimentation. No separate open-source license is granted yet.
