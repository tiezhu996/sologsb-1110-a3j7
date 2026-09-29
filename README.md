# 古琴斫制工序记录台（gbguqin）

面向斫琴师与琴坊档案员：把面板底板材、槽腹尺寸、灰胎髹漆遍次与上弦记录串成可回溯的工序档案；音色评价只用文字填写，不做音频文件与波形处理。纯前端单页应用，数据全部保存在浏览器本地，不依赖任何后端服务或外部接口。

## Docker 一键启动

```bash
cp .env.example .env
docker compose up -d --build
```

启动后访问：<http://localhost:21810>

停止并清理：

```bash
docker compose down
```

## 技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | Vue 3 + TypeScript（`<script setup>`） |
| 构建 | Vite 6（`npm run build` 含 `vue-tsc --noEmit` 类型检查） |
| UI | Element Plus 2 |
| 路由 | Vue Router 4（5 条业务路由 + 404） |
| 状态 | Pinia（boardStore / chamberStore / lacquerStore / stringingStore） |
| 存储 | IndexedDB（Dexie，库名 `gbguqin-db`） |
| 托管 | nginx:alpine（多阶段构建，SPA try_files + gzip） |

## 双机合档（可预览的备份合并）

两位档案员各自补录后，顶栏「合并备份」选择对方导出的 JSON，**不会清空本机**，先出预览再提交：

- 去重业务键：板材按**板材号**、槽腹按**琴号**、髹漆按**琴号 + 遍次**、上弦按**琴号 + 上弦日期**（归一到天，时分秒不同不算差异）。
- 预览分三类：`新增`（本机无同键，提交时重映射内部 id 写入）、`内容一致`（幂等跳过）、`冲突`（同键内容不同，进冲突列表）。
- 冲突逐条决定「保留本机 / 采用导入」，决定前与提交前本机原记录保持原样；只有点「提交合并」才在一个事务里落库。
- 提交时仍未处理的冲突**留在本机冲突队列**（IndexedDB `mergeQueue` 表），顶栏徽标提示条数；**导出备份自动带上**，对方或下次打开继续处理，同键队列项幂等合入、决议不被覆盖。
- 采用导入覆盖同键本机行时沿用本机行 id；髹漆写入后按琴号重算累计厚度。备份内业务键重复或缺键的行进「已跳过」提示，不入库。


## 本地开发

```bash
cd frontend
npm install
npm run dev      # http://localhost:21810
npm run build    # 类型检查 + 生产构建
```

## 目录结构

```
.
├── docker-compose.yml         # 顶层 name / COMPOSE_PROJECT_NAME 容器名 / 端口映射
├── .env.example               # COMPOSE_PROJECT_NAME、FRONTEND_PORT
├── frontend/
│   ├── Dockerfile             # node:20-alpine 构建 → nginx:alpine 托管
│   ├── nginx.conf             # try_files SPA 回退 + gzip
│   ├── public/favicon.svg
│   └── src/
│       ├── types/             # wood-board / sound-chamber / lacquer-layer / stringing（+ merge / ui）
│       ├── stores/            # boardStore / chamberStore / lacquerStore / stringingStore
│       ├── components/        # 各页通用组件 + MergeBackupDialog（备份合并预览）
│       ├── components/common/ # DimensionChart / LayerStack / ToneTextEditor / FilterBar / StatBadge / ProcessTimeline / EmptyPanel
│       ├── hooks/             # useGuqinFilter / useStageProgress
│       ├── pages/             # WorkshopBoard / BoardList / ChamberEditor / LacquerLedger / StringingLog（+ NotFound）
│       ├── router/index.ts    # 路由表
│       └── utils/             # layer.ts / db.ts / export.ts / merge.ts（+ wood.ts / seed.ts / id.ts / plain.ts）
```

## 功能与路由

| 路由 | 页面 | 说明 |
| --- | --- | --- |
| `/` | 琴坯进度 | 选材/掏膛/灰胎/上弦四阶段统计、推进比、缺失项与工序动态 |
| `/boards` | 板材登记与配对 | 面板底板配对、含水率回显、厚度差、槽腹剖面标注 |
| `/chambers` | 槽腹尺寸记录 | 纳音/龙池/凤沼三处厚度、槽腹深度、天地柱与龙池凤沼尺寸，SVG 剖面标注 |
| `/lacquer` | 灰胎髹漆遍次 | 按遍次累加厚度、荫房温湿度窗口校验、层积条与养护天数 |
| `/stringing` | 上弦与音色评价 | 散音/按音/泛音三段纯文本评语、九德简述、缺陷标记与版本对照 |

## 数据存储说明

- 全部数据存于浏览器 IndexedDB（Dexie，库名 `gbguqin-db`），表：`boards`、`chambers`、`lacquers`、`stringings`、`meta`、`mergeQueue`。
- `db.version(1)` 建表声明索引；`db.version(2).upgrade(...)` 为髹漆表增加 `[guqinNo+seq]` 复合索引并回填历史厚度；`db.version(3)` 增加合并冲突队列表 `mergeQueue`。升级前可用顶栏「导出备份」导出全量 JSON（含未处理冲突）。
- 首次打开且表为空时写入一批示例工序档案（`src/utils/seed.ts`）。
- 容器无状态：不使用数据库服务、不挂载命名卷，`docker compose down` 后数据仍留在浏览器中。
