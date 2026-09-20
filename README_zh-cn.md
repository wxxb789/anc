# anc —— 面向 Markdown 的隐私优先静态网站生成器

[![状态：预发布](https://img.shields.io/badge/status-pre--release-orange)](#状态)
[![node: >=22.18](https://img.shields.io/badge/node-%E2%89%A522.18-brightgreen)](#参与开发)
[![verify](https://github.com/wxxb789/anc/actions/workflows/verify.yml/badge.svg)](https://github.com/wxxb789/anc/actions/workflows/verify.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![文档：核心设计](https://img.shields.io/badge/docs-core%20design-blue)](docs/core-design/README.md)

[English](README.md) · [简体中文](README_zh-cn.md)

**anc 把一个存放 Markdown 的 Git 仓库构建成快速、可自托管的静态知识花园**：文章、反向链接、链接图谱、面包屑、标签、合集、目录、全文搜索、订阅源与站点地图，全部预先渲染为纯静态文件，任何静态主机都能托管。

每个文件默认发布，除非你主动排除。普通阅读无需 JavaScript，数据不经过任何第三方服务。

*anc* 是 **A**ctive **N**oise **C**ancelling（主动降噪）的缩写；包名与它安装的命令都是 `anc`。

## 目录

- [状态](#状态)
- [功能](#功能)
- [快速开始](#快速开始)
- [发布与否如何决定](#发布与否如何决定)
- [链接、标签与元数据](#链接标签与元数据)
- [架构](#架构)
- [参与开发](#参与开发)
- [接入与托管](#接入与托管)
- [文档](#文档)
- [许可证](#许可证)

## 状态

**预发布。** 工具可以构建、预览，并附带 GitHub Action 与 `init` 命令。`package.json` 仍然是 `"private": true`，因此 `anc` 尚未发布到任何 registry，`npx anc` 对任何人都无法解析；并且 npm 上的非 scoped 名称 `anc` 已被一个无关的包占用，正式发布需要一个 scoped 或改名后的包名。请从代码仓库检出，或使用仓库构建出的 tarball 安装。[`docs/adoption.md`](docs/adoption.md) 给出了两种方式，以及配置、排除、链接与托管说明。ANC 尚未达到 0.1.0 或 1.0.0 的完成状态，也不承诺向后兼容。

## 功能

| 能力 | 说明 |
| --- | --- |
| Markdown | CommonMark 加 GFM：表格、任务列表、脚注、callout、代码高亮 |
| 链接 | `[[wikilink]]`、相对链接与根锚定链接、Markdown 链接、笔记嵌入 |
| 关系 | 反向链接、出链与链接图谱，全部渲染为静态 HTML |
| 导航 | 标签、合集、面包屑、目录与最近更新 |
| 搜索 | Pagefind 全文搜索，支持按文档设定语言 |
| 富内容 | 客户端渲染的数学公式与 Mermaid 图表，均带源码回退 |
| 发现 | Atom 订阅源、站点地图、`robots.txt`、规范链接与 Open Graph 元数据 |
| 语言 | 按文档切换英文与简体中文（`zh-CN`）界面 |
| 隐私 | 默认发布、显式撤回；撤回的文件名不进日志 |
| 交付 | 默认静态 HTML；公开的 SQLite/WASM 快照用于懒加载预览 |
| 安全 | `dist/_headers` 提供严格 CSP；没有追踪器与分析脚本 |

## 快速开始

在本仓库的检出目录中，针对你自己的笔记运行：

```bash
node /path/to/anc/bin/anc.mjs build --content ~/notes --out ~/notes/dist
node /path/to/anc/bin/anc.mjs preview --dist ~/notes/dist
```

或安装本仓库构建出的 tarball：

```bash
cd /path/to/anc && pnpm run pack:tarball
cd ~/notes && npm install /path/to/anc/anc-*.tgz
npx anc build
npx anc preview          # 在 http://localhost:4321/ 提供 dist/
npx anc review           # 生成 .publish-set.json 供检查
npx anc build --release  # 精确发布集 + PATH 上固定版本的 Gitleaks
```

`npx anc` 是目标形态，也是包发布之后这些命令的写法。npm 上的非 scoped 名称 `anc` 已被占用，正式发布时可能需要 scoped 或改名后的包名；在决定之前，`npx anc` 会解析到一个无关的包。请改用上面两种方式之一。

## 发布与否如何决定

**所有文件默认发布，除非你排除它。** 没有白名单，也没有用于「选择加入」的 `publish: true`。两种机制可以撤回一个文件，当二者冲突时，指向「不发布」的一方获胜：

```markdown
---
publish: false
---
```

```yaml
# publish.config.yaml
title: Field Notes
origin: https://notes.example.org/
exclude:
  - "drafts/**"
  - "clients/**"
```

**匹配不到任何文件的模式会让构建失败。** 这是刻意的：把 `drafts/**` 误写成 `draft/**`，否则会在草稿上线时依然构建成功。指向已撤回笔记的链接会保留你写下的完整标签与路径，解析到 `/private/`，并被记录；被撤回笔记自身的正文、标题与摘要不会进入任何产物。

构建只输出计数，不输出文件名。被丢弃文件的清单写入 `<git-dir>/publish-report/` 下的 `content-report.json`（在 Git 仓库之外则写入用户状态目录），`git add -A` 无法触及它，它也绝不会被复制进 `dist/`。公开仓库的 workflow 日志对所有人可见，在那里出现被撤回文件的路径就等于泄露；名称与计数因此被分开。

## 链接、标签与元数据

- 五种链接写法在同一遍中解析，遵循 Obsidian 自身的顺序：`[[note]]`、`[[./sibling]]`、`[[folder/note]]`、`[text](../other.md)` 与 `[[note|shown]]`。
- 标签来自 frontmatter 列表，每个标签生成 `/tags/<key>/` 页面。内容根目录下的第一层文件夹成为扁平合集。
- `created` 与 `updated` 来自 Git 历史，不读取 frontmatter。
- frontmatter 可设置 `slug`、`language`、`description`、`tags` 与 `aliases`。别名是公开、可搜索的元数据，不产生自己的路由，刻意不作为链接目标。
- 非 Markdown 文件永不发布。没有资源管线，因此嵌入的图片会退化为文本并被记录。

## 架构

长期架构见 [`docs/core-design/`](docs/core-design/README.md)；可完成的开发目标及其完成证据见 [`docs/goals/`](docs/goals/README.md)。Markdown 始终是唯一事实来源，编译器 IR 保持私有，静态 HTML 负责页面交付，Pagefind 负责全文搜索。

- Astro `output: "static"`；构建产物是 `dist/`。
- 内容由 `scripts/markdown-to-artifact.ts` 与 `scripts/resolve-links.ts` 生成，渲染前先经 `src/lib/schema.ts` 校验。
- 唯一的公开关系与预览索引是 `data/site.<sha256>.sqlite`，包含 `nodes`、`edges`、`aliases`、`tags`、`node_tags` 五张表。它不含页面正文，也不含 SQLite FTS；浏览器以只读 Worker 懒加载它，用于悬停预览、标签浏览与图谱探索。
- 基础交互脚本只有几 KB gzip。含数学公式或图表的页面会懒加载对应的客户端渲染器，两者都带源码回退。
- 没有 D1、R2、Functions、分析、评论或构建时数据服务，也不需要运行时应用服务器。

## 参与开发

```bash
pnpm install
pnpm run verify          # lint、类型检查、构建、产物清单、密钥/残留扫描、测试
pnpm run build           # 只跑构建链
pnpm run build:fixture   # 用 32 篇笔记的语料重新构建
pnpm run build:example   # 将 example/ 构建到 .tmp/example-dist
pnpm run preview:example # 本地预览示例构建
pnpm run pack:tarball    # 编译 TypeScript 并打包可安装的 tarball
pnpm run smoke:tarball   # 在外部仓库中安装该 tarball 并读取结果
```

`pnpm run verify` 需要 `scripts/scan-secrets.ts` 导出的精确 Gitleaks 版本位于 `PATH`；普通的 `pnpm run build` 不需要。`package.json` 中的 `packageManager` 固定了 pnpm 版本，启用 `corepack enable` 后生效。依赖安装到符号链接的 `node_modules`，因此未在 `package.json` 中声明的包无法解析——这是边界而非偏好。

改动前请阅读 [`AGENTS.md`](AGENTS.md)，其中包含验证契约、各环节的运行位置，以及已知的过期内容及其归属。[`example/`](example/) 下的合成语料是最小的功能导览，包含公开笔记、两种排除机制、链接与反向链接、丰富 Markdown、数学公式与 Mermaid。

## 接入与托管

仓库根目录的 GitHub Action 会在受支持的 Linux runner 上执行 release 构建，安装校验和固定的密钥扫描器，并写出静态 `dist/`。任何静态主机都能托管该目录。`dist/_headers` 以 Cloudflare Pages 的格式提供 Content-Security-Policy 与另外三个安全响应头；不读取该文件的主机会在缺少它们的情况下提供站点，功能可用但保护更弱。

发布是显式的外部副作用。构建不会部署，本仓库也无法部署。[`docs/adoption.md`](docs/adoption.md) 同时给出了 Action 用法与手工搭建的 GitHub Pages 示例，二者都不需要任何密钥。

## 文档

- [`docs/adoption.md`](docs/adoption.md) —— 一个陌生人拿到笔记仓库后要做的事。
- [`docs/core-design/`](docs/core-design/README.md) —— 权威的长期架构。
- [`docs/goals/`](docs/goals/README.md) —— 进行中的目标与已完成目标归档。
- [`docs/gate-reading.md`](docs/gate-reading.md) —— 一个检测工具对自己说谎的七种方式。
- [`AGENTS.md`](AGENTS.md) —— 贡献者工作流与验证契约。
- [`example/`](example/) —— 展示全部公开界面的合成语料。

[Astro 文档](https://docs.astro.build) · [Pagefind 文档](https://pagefind.app/docs/)

## 许可证

本项目以 [MIT 许可证](LICENSE) 发布。

---

[English](README.md) · [简体中文](README_zh-cn.md)
