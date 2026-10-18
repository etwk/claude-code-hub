<p align="right">
  <strong>English</strong> | <a href="./README.md" aria-label="Switch to Chinese version of this README">中文</a>
</p>

<div align="center">

# CC Hub

**🚀 Intelligent AI API relay platform — the control center for multi-provider onboarding, elastic routing, and granular operations**

[![Container Image](https://img.shields.io/badge/ghcr.io-ding113%2Fclaude--code--hub-181717?logo=github)](https://github.com/ding113/claude-code-hub/pkgs/container/claude-code-hub)
[![License](https://img.shields.io/github/license/ding113/claude-code-hub)](LICENSE)
[![GitHub Stars](https://img.shields.io/github/stars/ding113/claude-code-hub)](https://github.com/ding113/claude-code-hub/stargazers)
[![Telegram Group](https://img.shields.io/badge/Telegram-Join%20Group-blue?logo=telegram)](https://t.me/ygxz_group)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/ding113/claude-code-hub)

CC Hub combines Next.js 16, Hono, PostgreSQL, and Redis to deliver a Claude/OpenAI-compatible API gateway with smart load balancing, live observability, price governance, and automated documentation, enabling teams to manage multiple AI vendors safely and transparently.

💬 **Join the discussion**: Questions about deployment, features or technical issues? Join our [Telegram community](https://t.me/ygxz_group)!

</div>

---

> [!IMPORTANT]
> **This project is currently under active refactoring**
>
> CC Hub Plus, the refactored version of CC Hub, is expected to be open-sourced under the AGPL license in Q3. CC Hub Plus is dedicated to building a high-performance, stable, commercial-grade LLM gateway, offering comprehensive commercial features such as format conversion, privacy filtering, a model marketplace, and top-up billing, while significantly improving the theoretical performance of the forwarding core. During development of the refactored version, progress and community support for the Node.js version may be delayed — thank you for your understanding.

<table>
<tr>
<td width="200">
<a href="https://cubence.com/signup?code=SCE7Y3QR&source=cch">
<img src="public/readme/cubence.jpg" alt="Cubence Logo" width="180"/>
</a>
</td>
<td>
<b>💎 Special Offer</b>: <a href="https://cubence.com/signup?code=SCE7Y3QR&source=cch">Cubence</a> is a stable and efficient AI service transit platform, providing transit services for AI tools such as Claude Code, Codex, Gemini, with good stability and cost-effectiveness.<br/>
Cubence offers special discount coupons for users of CCH: when purchasing with the coupon <code>DING113CCH</code>, you can enjoy a <b>10% discount</b> → <a href="https://cubence.com/signup?code=SCE7Y3QR&source=cch">Visit Now</a>
</td>
</tr>
</table>

<table>
<tr>
<td width="200">
<a href="https://www.packyapi.com/register?aff=withcch">
<img src="public/readme/packycode.png" alt="PackyCode Logo" width="180"/>
</a>
</td>
<td>
<b>💎 Special Offer</b>: Thanks to <a href="https://www.packyapi.com/register?aff=withcch">PackyCode</a> for sponsoring this project! PackyCode is a stable and efficient API relay service provider, offering relay services for Claude Code, Codex, Gemini and more.<br/>
PackyCode offers a special discount for users of this software. Register via this link and enter code <code>WITHCCH</code> when recharging to enjoy <b>10% off</b> → <a href="https://www.packyapi.com/register?aff=withcch">Visit Now</a>
</td>
</tr>
</table>

<table>
<tr>
<td width="200">
<a href="https://co.yes.vg/register?ref=ygxz">
<img src="public/readme/yescode.png" alt="YesCode Logo" width="180"/>
</a>
</td>
<td>
<b>💎 Special Offer</b>: <a href="https://co.yes.vg/register?ref=ygxz">YesCode</a> is a low-profile yet highly reliable AI API relay service, dedicated to providing developers with stable access to Claude, Codex, Gemini, and other models. Built on solid technical foundations with consistently dependable service quality.<br/>
Register via this link to get started → <a href="https://co.yes.vg/register?ref=ygxz">Visit Now</a>
</td>
</tr>
</table>

<table>
<tr>
<td width="200">
<a href="https://aigocode.com/invite/QDNEJJAH">
<img src="public/readme/aigocode.jpg" alt="AIGoCode Logo" width="180"/>
</a>
</td>
<td>
<b>💎 Special Offer</b>: <a href="https://aigocode.com/invite/QDNEJJAH">AIGoCode</a> is an all-in-one platform integrating the latest models from Claude Code, Codex, and Gemini, delivering stable, efficient, and cost-effective AI coding services. Flexible subscription plans (monthly or bundled), zero ban risk, direct access from China, massive credit pools, and lightning-fast responses.<br/>
AIGoCode offers a special bonus for CCH users — register via this link and receive an extra <b>10% bonus credit</b> on your first top-up → <a href="https://aigocode.com/invite/QDNEJJAH">Visit Now</a>
</td>
</tr>
</table>

<table>
<tr>
<td width="200">
<a href="https://pateway.ai/?ch=1ycdoum&aff=T8FV5H42">
<img src="public/readme/pateway.png" alt="PatewayAI Logo" width="180"/>
</a>
</td>
<td>
<b>💎 Special Offer</b>: <a href="https://pateway.ai/?ch=1ycdoum&aff=T8FV5H42">PatewayAI</a> is a premium model API relay provider built for power AI developers, focused on official direct access. It offers the full Claude lineup and Codex series with 100% official upstream channels, no mixed routes, and no watered-down quality. Billing is transparent and every token-level charge can be verified line by line.<br/>
It also supports enterprise-grade high concurrency and provides a professional management platform for business customers. Enterprise clients can sign formal contracts and request invoices; visit the official website for contact details and more information.<br/>
Register now via <a href="https://pateway.ai/?ch=1ycdoum&aff=T8FV5H42">this link</a> to get a <b>$3 trial credit</b>. Top-ups can be as low as <b>60% of list price</b>, with two-way referral bonuses, and total referral rewards up to <b>$150</b>.
</td>
</tr>
</table>

## ✨ Core Highlights

- 🤖 **Intelligent load balancing**: Weight + priority + grouping scheduler with built-in circuit breaker and up to three failover retries to keep requests stable.
- 🧩 **Multi-provider management**: Connect Claude, Codex, Gemini CLI, and OpenAI-compatible vendors simultaneously with per-provider model redirection and HTTP/HTTPS/SOCKS proxy rules.
- 🛡️ **Rate limiting & concurrency control**: Enforce RPM, monetary quotas (5-hour / weekly / monthly), and session concurrency via Redis Lua scripts with atomic counters and fail-open degradation.
- 📘 **Automated OpenAPI docs**: 39 REST endpoints exported from Server Actions into OpenAPI 3.1.0, instantly browsable in Swagger and Scalar UI.
- 📊 **Real-time monitoring & analytics**: Dashboards, active sessions, consumption leaderboards, decision-chain tracing, and proxy health tracking provide second-level visibility.
- 💰 **Price sheet management**: Paginated SQL queries with debounce search and LiteLLM sync keep thousands of model prices searchable in milliseconds.
- 🔁 **Session management**: Five-minute context cache preserves decision trails, reduces vendor switches, and maintains full auditability.
- 🔄 **OpenAI-compatible endpoint**: Supports `/v1/chat/completions` (OpenAI-compatible format), passes through tool calls and reasoning fields, enforces strict same-format routing with no cross-format conversion.

### Rerank API

Send non-streaming JSON to `POST /v1/rerank` using a CCH API key. Configure an
**OpenAI Compatible** provider whose upstream supports reranking, and include the
reranker in its model allowlist. Responses and Messages providers are not used
for this endpoint. Provider URLs may be a root, a versioned base, or a complete
rerank endpoint; CCH avoids duplicating the version or endpoint suffix.

```json
{
  "model": "your-reranker",
  "query": "What is the capital of France?",
  "documents": ["Berlin is the capital of Germany.", "Paris is the capital of France."],
  "top_n": 1,
  "return_documents": true
}
```

A nonblank string `model` is required. Authentication, user/provider model
allowlists, provider groups, rate limits, and spending limits use the normal CCH
pipeline. Query/document validation belongs to the upstream. Document objects
remain opaque, including underscore-prefixed document fields; CCH still removes
private top-level parameters and applies configured request filters. Successful
JSON responses preserve the upstream results, scores, documents, and metadata.

Accepted case/trailing-slash variants are forwarded with the canonical rerank
path. Rerank always remains non-streaming, even when its model appears in the
fake-streaming whitelist. Enabled sensitive-word rules inspect `query`, string
documents, and direct string document `text`/`content` fields, not opaque metadata.
Model-validation errors use the existing request-locale translations.

Token usage is optional. Accounting selects one report without adding competing
sources: standard `usage` directions, then `meta.billed_units` directions, then
standard total-only usage, then billed total-only usage, then `meta.tokens`
directions. Counts must be nonnegative safe integers; explicit input zero is retained.
Zero output alone is incomplete and does not suppress a later valid usage report.
Total-only usage is consumed input with zero output, not generated text. A
positive output count does not imply an input split. `search_units` are not
tokens. Without token usage, existing per-request pricing can still bill a
successful response; token counts are never fabricated.

### System One API

Send TypeSafe-compatible requests to `POST /v1/systemone` with a CCH API key.
Configure an **OpenAI Compatible** provider with your TypeSafe API key, URL
`https://api.typesafe.ai` (also accepts `/v1` or the full `/v1/systemone` URL),
and an explicit model allowlist such as `jev-latest`. Gateway prefixes such as
`https://openrouter.ai/api` and `https://ai-gateway.vercel.sh/typesafe` are retained.
Responses, Messages, and Gemini providers are not used for this endpoint.

```bash
curl https://your-cch.example/v1/systemone \
  -H "Authorization: Bearer $CCH_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"jev-latest","state":"I was charged twice.","questions":{"billing":{"type":"noul","instructions":"Is this about billing?"}}}'
```

JSON and TypeSafe's experimental image-upload multipart format are supported:
the first part is named `request` and contains the JSON request, followed by
image parts referenced by `assets`. Multipart forwarding replaces only that JSON
part, preserving image bytes, filenames, and boundary framing. Inbound compressed
bodies are decoded before inspection. Forward the required
`TypeSafe-Danger-Zone-Images: true` header when using images or `box` questions;
TypeSafe's feature, image, and question validation remains upstream-owned.

A nonblank string `model` is required, with localized validation errors. Normal
authentication, model allowlists, provider groups, rate limits, spending checks,
model redirects, and configured request filters apply. Nested `state`, question,
and asset fields (including underscore-prefixed keys) are preserved; private
top-level parameters are removed. Sensitive-word checks inspect nested state,
instructions, criteria, and choice labels, not asset bytes or transport metadata.
Image-reference spans are excluded without joining the surrounding text; Choice
option names remain literal text, matching [TypeSafe's reference rules](https://docs.typesafe.ai/images#references).
The endpoint bypasses fake streaming even for whitelisted models. Accepted path
variants are forwarded canonically; successful JSON answers and TypeSafe response
headers are preserved. CCH's existing model-list endpoint keeps its existing format;
this addition does not implement TypeSafe SDK model discovery.

Accounting reads only the response's `usage`: `input_tokens`/`output_tokens`, with
`prompt_tokens`/`completion_tokens` aliases. Counts must be nonnegative safe integers;
explicit input zero wins. A total-only report is consumed input with zero output;
positive output does not imply an input split. Missing/null token counts and zero
output alone allow existing per-request pricing on successful responses. Upstream
monetary `cost` fields are not token counts or a replacement for local pricing.

For schema-changing upgrades, follow the [database rollback procedure](docs/database-upgrade-rollback.md).
Changing the application image alone does not undo database migrations or triggers.

## ⚡️ Quick Start

### Requirements

- Docker and Docker Compose (latest version recommended)
- Optional (for local development): Node.js ≥ 22.15 (inbound zstd request-body decompression uses native `node:zlib` zstd), Bun ≥ 1.3

### 🚀 One-Click Deployment Script (✨ Recommended - Fully Automated)

The one-click deployment script **automatically handles** all of the following:

- Check and install Docker and Docker Compose (Linux/macOS support auto-install)
- Create deployment directory and configuration files
- Generate secure admin token and database password
- Start all services and wait for health checks
- Display access URLs and admin token

**Linux / macOS:**

```bash
# Download and run the deployment script
curl -fsSL https://raw.githubusercontent.com/ding113/claude-code-hub/main/scripts/deploy.sh -o deploy.sh
chmod +x deploy.sh
./deploy.sh
```

Or using wget:

```bash
wget https://raw.githubusercontent.com/ding113/claude-code-hub/main/scripts/deploy.sh
chmod +x deploy.sh
./deploy.sh
```

**Windows (PowerShell as Administrator):**

```powershell
# Download and run the deployment script
Invoke-WebRequest -Uri "https://raw.githubusercontent.com/ding113/claude-code-hub/main/scripts/deploy.ps1" -OutFile "deploy.ps1"
Set-ExecutionPolicy -ExecutionPolicy Bypass -Scope Process -Force
.\deploy.ps1
```

**Deployment Directories:**

- Linux: `/www/compose/claude-code-hub`
- macOS: `~/Applications/claude-code-hub`
- Windows: `C:\ProgramData\claude-code-hub`

**Branch Selection:**

The script will prompt you to select a deployment branch:

- `main` (default): Stable release, recommended for production
- `dev`: Development version with latest features, for testing

**Important Notes:**

- ⚠️ Please save the **Admin Token** displayed by the script - it's the only credential to access the admin dashboard!
- ⚠️ Windows users: If Docker Desktop is not installed, the script will automatically open the download page

### Three-Step Launch (Docker Compose)

1. **Clone and configure**

   ```bash
   git clone https://github.com/ding113/claude-code-hub.git
   cd claude-code-hub
   cp .env.example .env
   ```

2. **Edit configuration**

   Edit the `.env` file and **update** `ADMIN_TOKEN` (admin login token):

   ```bash
   # MUST change this!
   ADMIN_TOKEN=your-secure-token-here

   # Docker Compose defaults (usually no changes needed)
   DSN=postgres://postgres:postgres@postgres:5432/claude_code_hub
   REDIS_URL=redis://redis:6379
   ```

3. **Start services**

   ```bash
   docker compose up -d
   ```

   Check status:

   ```bash
   docker compose ps
   docker compose logs -f app
   ```

### Access the application

Once started:

- **Admin Dashboard**: `http://localhost:23000` (login with `ADMIN_TOKEN` from `.env`)
- **API Docs (Scalar UI)**: `http://localhost:23000/api/actions/scalar`
- **API Docs (Swagger UI)**: `http://localhost:23000/api/actions/docs`

> 💡 **Tip**: To change the port, edit the `ports` section in `docker-compose.yml`.

## 🖼️ Screenshots

| Feature             | Screenshot                                           | Description                                                                                                           |
| ------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Dashboard           | ![Dashboard](public/readme/首页.png)                 | Aggregates request volume, spending, active sessions, and time-series distribution for instant situational awareness. |
| Provider management | ![Provider Management](public/readme/供应商管理.png) | Configure weight, cost multiplier, concurrency caps, proxies, and model redirection per vendor for precise routing.   |
| Logs & audit        | ![Logs](public/readme/日志.png)                      | Unified request log with filters for time/user/provider/model plus token, cost, and cache-hit details.                |
| Leaderboard         | ![Leaderboard](public/readme/排行榜.png)             | Ranks users by requests, tokens, and spending to support chargeback and usage governance.                             |

## 🏗️ Architecture

### High-level view

```
Clients / CLI / Integrations
        │
        ▼
Next.js 16 App Router (v1 API routes)
        │
Hono + Proxy Pipeline (Auth → Session Allocation → Rate Limiting → Provider Selection → Forwarding → Response Handling)
        │
Multi-provider pool (Claude / OpenAI / Gemini / others) + PostgreSQL + Redis
```

- **App layer**: `src/app` hosts dashboards, settings, and API actions for UI and internal APIs.
- **Proxy core**: `src/app/v1/_lib/proxy-handler.ts` chains `ProxyAuthenticator`, `ProxySessionGuard`, `ProxyRateLimitGuard`, `ProxyProviderResolver`, `ProxyForwarder`, and `ProxyResponseHandler`.
- **Business logic**: `src/lib` contains rate limiting, session manager, circuit breaker, proxy utilities, and price-sync; `src/repository` encapsulates Drizzle ORM queries.
- **Documentation system**: `src/app/api/actions/[...route]/route.ts` converts Server Actions into OpenAPI endpoints automatically.

### Data flow & components

1. **Ingress**: Requests with API keys hit the Next.js route and pass through `ProxyAuthenticator`.
2. **Context control**: `SessionManager` fetches the five-minute cache from Redis, enforces concurrency, and records the decision chain.
3. **Rate limiting**: `RateLimitService` applies Lua-driven atomic counters for RPM, spend, and session caps, falling back gracefully if Redis is unavailable.
4. **Routing**: `ProxyProviderResolver` scores vendors with weights, priorities, breaker states, and session reuse, retrying up to three times.
5. **Forwarding & response handling**: `ProxyForwarder` sends requests upstream; `ProxyResponseHandler` processes response streams while preserving endpoint-native formats, with proxy support and model redirects.
6. **Observability**: Dashboards, leaderboards, and price sheets query PostgreSQL via repositories with hourly aggregations.

## 🚢 Deployment

### 🐳 Docker Compose (✨ Recommended, Production-Ready)

Docker Compose is the **preferred deployment method** — it automatically provisions the database, Redis, and application services without manual dependency installation, ideal for production quick-start.

1. Prepare `.env` (see `.env.example`) and point `DSN`/`REDIS_URL` to the Compose services.
2. Start the stack:
   ```bash
   docker compose up -d
   ```
3. Monitor:
   ```bash
   docker compose logs -f app
   docker compose ps
   ```
4. Upgrade:
   ```bash
   docker compose pull && docker compose up -d
   ```
   Stop and clean up with `docker compose down` when necessary.

### ☸️ Kubernetes / k3s (Production / HA / Multi-node)

The repo ships a **dual-compatible** (k3s + standard Kubernetes) one-click deploy script `scripts/deploy-k8s.sh` and a management CLI `scripts/cch`. Out of the box you get HPA autoscaling, PodDisruptionBudget, NetworkPolicy, rolling upgrades with automatic rollback on health check failure, and scheduled backups.

Quick start (auto-installs k3s if no cluster is detected):

```bash
git clone https://github.com/ding113/claude-code-hub.git
cd claude-code-hub
bash scripts/deploy-k8s.sh --install-k3s -y
```

Standard Kubernetes with domain:

```bash
bash scripts/deploy-k8s.sh \
  --ingress-host hub.example.com \
  --ingress-class nginx \
  --storage-class standard \
  -y
```

Day-2 operations with `cch`:

```bash
cch status            # pods / HPA / resources
cch update            # rolling upgrade with auto-migrate and rollback on failure
cch backup            # PostgreSQL backup (gzip, keep 30)
cch info              # show access URL and admin token
cch doctor            # diagnose cluster + deployment
```

See **[docs/k8s-deployment.md](docs/k8s-deployment.md)** for full options, placeholders, cloud provider StorageClass mapping, and troubleshooting.

### Local development (dev toolchain)

1. Enter the `dev/` folder: `cd dev`.
2. Run `make dev` to launch PostgreSQL + Redis + `bun dev` in one command.
3. Helpful targets:
   - `make db`: start only database and Redis.
   - `make logs` / `make logs-app`: tail all services or app logs.
   - `make clean` / `make reset`: clean or fully reset the environment.
4. Use `make migrate` and `make db-shell` for schema operations.

### Manual deployment (bun build + start)

1. Install dependencies and build:
   ```bash
   bun install
   bun run build      # Copies the VERSION file automatically
   ```
2. Export environment variables via your process manager (systemd, PM2, etc.) and ensure PostgreSQL/Redis endpoints are reachable.
3. Launch production server:
   ```bash
   bun run start
   ```
4. You may keep `AUTO_MIGRATE=true` for the first run, then disable it and manage migrations explicitly with Drizzle CLI.

## ⚙️ Configuration

| Variable                                   | Default                  | Description                                                                                          |
| ------------------------------------------ | ------------------------ | ---------------------------------------------------------------------------------------------------- |
| `ADMIN_TOKEN`                              | `change-me`              | Admin console token — must be updated before deployment.                                             |
| `DSN`                                      | -                        | PostgreSQL connection string, e.g., `postgres://user:pass@host:5432/db`.                             |
| `AUTO_MIGRATE`                             | `true`                   | Executes Drizzle migrations on startup; consider disabling in production for manual control.         |
| `REDIS_URL`                                | `redis://localhost:6379` | Redis endpoint, supports `rediss://` for TLS providers.                                              |
| `REDIS_TLS_REJECT_UNAUTHORIZED`            | `true`                   | Validate Redis TLS certificates; set `false` to skip (for self-signed/shared certs).                 |
| `ENABLE_RATE_LIMIT`                        | `true`                   | Toggles multi-dimensional rate limiting; Fail-Open handles Redis outages gracefully.                 |
| `ENABLE_API_KEY_VACUUM_FILTER`             | `true`                   | Enables API Key Vacuum Filter (negative short-circuit only; set to `false/0` to disable).            |
| `ENABLE_API_KEY_REDIS_CACHE`               | `true`                   | Enables API Key auth Redis cache (requires Redis; auto-fallback to DB on errors).                    |
| `API_KEY_AUTH_CACHE_TTL_SECONDS`           | `60`                     | API Key auth cache TTL in seconds (default 60, max 3600).                                             |
| `SESSION_TTL`                              | `300`                    | Session cache window (seconds) that drives vendor reuse.                                             |
| `ENABLE_SECURE_COOKIES`                    | `true`                   | Browsers require HTTPS for Secure cookies; set to `false` when serving plain HTTP outside localhost. |
| `ENABLE_CIRCUIT_BREAKER_ON_NETWORK_ERRORS` | `false`                  | When `true`, network errors also trip the circuit breaker for quicker isolation.                     |
| `APP_PORT`                                 | `23000`                  | Production port (override via container or process manager).                                         |
| `APP_URL`                                  | empty                    | Populate to expose correct `servers` entries in OpenAPI docs.                                        |
| `API_TEST_TIMEOUT_MS`                      | `15000`                  | Timeout (ms) for provider API connectivity tests. Accepts 5000-120000 for regional tuning.           |

> Boolean values support `true/false` or `1/0`. Quoting in `.env` is also fine (dotenv will strip quotes). See `.env.example` for the full list.

## ❓ FAQ

1. **Database connection failures**
   - Verify the `DSN` format and credentials; use service names (e.g., `postgres:5432`) within Docker.
   - Inspect `docker compose ps` or local PostgreSQL status, and use `make db-shell` for deeper checks.

2. **What if Redis goes offline?**
   - The platform uses a fail-open policy: rate limiting and session metrics degrade gracefully while requests continue flowing. Monitor logs for Redis errors and restore the service asap.

3. **Circuit breaker keeps opening**
   - Inspect `[CircuitBreaker]` logs to see whether repeated 4xx/5xx or network errors triggered it.
   - Check provider health in the admin console and wait 30 minutes or restart the app to reset state.

4. **“No provider available” errors**
   - Ensure providers are enabled, have reasonable weights/priorities, and haven’t hit concurrency or spend caps.
   - Review the decision-chain log to confirm whether breakers or proxy failures removed them.

5. **Proxy configuration issues**
   - Make sure URLs include a protocol (`http://`, `socks5://`, etc.) and validate via the “Test Connection” button in the UI.
   - If `proxy_fallback_to_direct` is enabled, confirm via logs that the system retried without the proxy when failures occur.

## 🤝 Contributing

We welcome issues and PRs! Please read [CONTRIBUTING.md](CONTRIBUTING.md) for the bilingual guidelines, branch strategy, and Conventional Commits requirements before submitting changes.

## 🌐 Acknowledgments

This project builds on [zsio/claude-code-hub](https://github.com/zsio/claude-code-hub), references [router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) for the OpenAI-compatible layer, and [prehisle/relay-pulse](https://github.com/prehisle/relay-pulse) for provider detection functionality. Huge thanks to the original authors and community contributors!

## ⭐ Star History

[![Star History Chart](https://api.star-history.com/svg?repos=ding113/claude-code-hub&type=Date)](https://star-history.com/#ding113/claude-code-hub&Date)

## 📜 License

Released under the [MIT License](LICENSE). You’re welcome to use and extend the project as long as you comply with the license and retain the attribution.

---

<sub>CC Hub is not an official Anthropic project and is not affiliated with Anthropic. Claude Code and Claude are trademarks of Anthropic.</sub>
