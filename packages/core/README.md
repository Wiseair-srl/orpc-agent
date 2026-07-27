# @orpc-agent/core

Neutral capability model and governed agent runtime for [oRPC](https://orpc.unnoq.com) procedures. Every agent invocation runs through the same pipeline: validation, permissions, approvals, execution policies, redaction, audit.

> Independent community project, not affiliated with or endorsed by the oRPC maintainers.

## Install

```bash
pnpm add @orpc-agent/core @orpc/server
```

`zod` is an optional peer (built-in JSON Schema conversion for Zod v4).

## Use

```ts
import { agentProcedure, createCapabilityRegistry, createAgentRuntime } from "@orpc-agent/core";
```

Docs: [getting started](https://github.com/Wiseair-srl/orpc-agent/blob/main/docs/getting-started.md) · [architecture](https://github.com/Wiseair-srl/orpc-agent/blob/main/docs/architecture/execution-pipeline.md) · [repository](https://github.com/Wiseair-srl/orpc-agent)

## License

[MIT](https://github.com/Wiseair-srl/orpc-agent/blob/main/LICENSE)
