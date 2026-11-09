---
description: "通过官方 Sign in with ChatGPT 在 DeepSeek Harness 中使用自己的 ChatGPT 订阅额度。"
kind: "package-bundle"
---

# DSH ChatGPT Provider

[![CI / Publish](https://github.com/ywh1357/dsh-chatgpt-provider/actions/workflows/publish.yml/badge.svg)](https://github.com/ywh1357/dsh-chatgpt-provider/actions/workflows/publish.yml)
[![npm version](https://img.shields.io/npm/v/dsh-chatgpt-provider.svg)](https://www.npmjs.com/package/dsh-chatgpt-provider)

DeepSeek Harness 模型提供商插件。通过官方 Sign in with ChatGPT（SIWC）授权，在 DSH 中使用 ChatGPT 订阅支持的模型。

**0.1.9** 支持文本、图片和 DSH 函数工具。

需要 Node.js ≥24.9.0，目标 DSH 版本为 **0.2.1-rc.5**。账号是否可以使用订阅额度、可选模型及额度限制由 OpenAI 的授权和模型目录决定。

## 安装和使用

### 从 npm 安装

使用 CLI 的 Web profile 时，直接从 npm 安装已发布的插件：

```shell
dsh plugin --profile web add dsh-chatgpt-provider
dsh web --no-open
```

如果没有全局安装 `dsh`，可以通过 `npx` 执行：

```shell
npx @deepseek-ai/dsh plugin --profile web add dsh-chatgpt-provider
npx @deepseek-ai/dsh web --no-open
```

需要固定版本时，将包名替换为 `dsh-chatgpt-provider@0.1.9`。插件安装到指定的 profile；上述命令针对 Web profile，不会安装到 DSH Desktop。安装后重启对应的 DSH 实例，再按下方步骤登录。

### 从源码打包安装

在仓库目录生成安装包。

```powershell
npm ci --ignore-scripts --legacy-peer-deps
npm pack
```

在 DSH Desktop 的插件管理器中安装生成的 `dsh-chatgpt-provider-0.1.9.tgz`，然后重启。使用 CLI 的 Web profile 时，运行下面的命令。

```powershell
$bundle = (Resolve-Path .\dsh-chatgpt-provider-0.1.9.tgz).Path
dsh plugin --profile web add $bundle
dsh web --no-open
```

### 登录和使用

打开 **设置 → 模型 → ChatGPT plan → 使用 ChatGPT 继续**，再打开授权链接并允许使用订阅额度。卡片显示“已连接”后，在模型选择器里选择 ChatGPT plan 下的模型。若浏览器无法访问 DSH Host 的回环地址，展开“无法自动返回？手动提交回调”，将浏览器地址栏中的完整回调 URL 粘贴并提交。

“管理用量”常驻卡片右侧；点击 **⋯** 展开账号设置，使用“刷新状态”或“退出登录”。异常提示直接显示，不会被折叠隐藏。

选择模型目录中支持图片的模型后，可直接粘贴或上传图片并提问。图片格式、尺寸和完整性检查由 DSH 附件服务处理；已被 DSH 卸载的历史图片保留占位文本，不会重新发送图片字节。纯文本请求的序列化格式保持原样。

请求使用官方 `https://api.openai.com/v1/responses`，通过 OAuth 访问令牌认证。每次请求使用 `store: false`、`stream: true`，完整传递所需历史和工具结果，并保留同账号、同模型下的加密推理内容。仅收到 `response.completed` 才标记成功；额度错误和流中断会作为失败返回。

## 开发与配置

```powershell
npm ci --ignore-scripts --legacy-peer-deps
npm run typecheck
npm test
npm pack
```

测试覆盖 OAuth 身份校验、异常回调后的正常登录、跨实例 Token 刷新、旧 Token 的延迟 401、刷新异常后的恢复、明确失效令牌的清除、工具结果回传、JSON 历史恢复、额度错误、请求取消及真实 Cordis Loader 的加载卸载。

默认回调端口是 `1455`。端口被占用时，在 profile 的 `cordis.patch.yml` 中覆盖配置并重启：

```yaml
- id: chatgpt-provider
  config:
    callbackPort: 0
```

`0` 表示使用空闲端口。若模型目录缺少上下文窗口，可在同一 `config` 中配置 `modelContextWindows: { "模型 slug": 128000 }`，数值应以该模型的实际限制为准。全部选项见 `src/index.ts` 的 `Config`。

`requestTimeoutMs` 默认是 180000 毫秒。生成请求开始时计时，收到每个 SSE 事件后重新计时。

## 当前边界

- 支持一个账号注册、文本、用户图片及 DSH 函数工具的图片结果。普通文件仍由 DSH 转为文本。暂不支持图片生成、多账号、WebSocket 和内置工具。目录未声明图片能力的模型继续按文本模型处理。
- 凭据保存在 DSH Host 的凭据服务中，默认文件为 `$DSH_HOME/.credentials.yaml`。浏览器只收到账号状态。该文件不是系统加密保险箱；Windows 文件 ACL 由 DSH/运行环境管理。
- 刷新使用 DSH 存储事务串行完成。收到 401 后会在允许刷新时核验当前凭据，确认刷新令牌失效才要求重新登录。503 会保留连接并提示稍后重试。如果服务端已轮换 Token 但响应丢失，后续刷新仍可能确认旧令牌失效并要求重新登录。
- 普通请求不支持 `temperature`、`stop`、`maxTokens`。DSH 摘要压缩请求使用 SIWC 的输出限制，省略 DSH 自带的 `maxTokens`。不会自动重试推理，额度耗尽时应在 ChatGPT 的用量设置中处理。
- 当前工程测试针对 DSH 0.2.1-rc.5；包声明的 0.2.2-alpha.2 兼容性未在本工程验证。

## 来源

本实现基于 `dsh-chatgpt-plan` 的 MIT 代码。上游版权声明见 `LICENSE`。 [上游源码](https://github.com/yossi-lee/dsh-chatgpt-plan/tree/b18bc4a48b9160b4a7a7014876881f52b89c46e6)

协议依据：[注册与登录](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)、[模型与推理](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)、[账号与续期](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)、[错误恢复](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery)。
