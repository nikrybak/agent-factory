---
name: factory-docs-sync
description: Авто-синхронизация документации и памяти базы после задачи. Из реальных фактов (память ролей + результаты текущей сессии: изменённые файлы, коммиты, вердикты гейтов) переписывает docs/operations/MEMORY.md (Текущее состояние / Активные риски / Открытые вопросы / Последние изменения), дописывает строку в docs/operations/CHECKPOINTS.md (Дата|Изменение|Тесты|Docs/ADR|Риск|Commit) и обновляет tasks/CURRENT_SPRINT.md и tasks/DONE.md. Также обновляет app architecture docs и ADR при изменении архитектуры. Шаг 11 Workflow и инвариант AGENTS.md п.8. Только для инфры Software Factory (в корне: AGENTS.md с Factory City + cli/bin/infra.js).
---

# factory-docs-sync

Авто-синхронизация документации и памяти базы после задачи. Источник правды —
**реальные факты**: память ролей `.claude/agent-memory/<role>/MEMORY.md` и результаты
текущей сессии (изменённые файлы, коммиты, вердикты гейтов). Отдельного сессионного
журнала нет (ADR-0021 п.11). Из фактов перезаписывается снимок состояния,
добавляется контрольная точка и обновляются задачи. Документационный разрыв
блокирует финальный quality gate (`/factory-mandatory-quality-gate`).

## When to Use

- Шаг 11 Workflow (`/factory-docs-sync`) — после реализации и гейтов, перед
  `/factory-release-checkpoint`.
- После **любого** прогресса, даже частичного (инвариант контракта `AGENTS.md` п.8:
  `MEMORY.md`, `CHECKPOINTS.md`, `tasks/CURRENT_SPRINT.md`, `tasks/DONE.md`).
- Когда менялась архитектура (тогда дополнительно `docs/app-architecture/` и
  `docs/adr/`).

## How It Works

Процедура детерминирована: сначала читаем источники фактов, потом переписываем
производные документы. Ничего не выдумываем — каждая строка снимка и чекпойнта
опирается на запись в памяти роли, реальный коммит или результат
гейтов из текущей сессии.

### Шаг 0. Собрать факты (только чтение)

1. Прочитать память всех затронутых ролей: `.claude/agent-memory/*/MEMORY.md`
   (12 ролей; секции «Усвоенные паттерны», «Недавние решения (по датам)»).
   Особое внимание — `documentation-engineer/MEMORY.md`.
2. Прочитать текущий `docs/operations/MEMORY.md` (последние записи и «Последние
   изменения») и `git log` / `git diff --stat` сессии: что реально изменилось.
3. Зафиксировать из текущей сессии: какие модули/файлы изменены, результат
   `/factory-mandatory-test-gate` (PASS/FAIL и команда тестов, напр. `node cli/bin/infra.js
   sync --check` или `pnpm vitest run`), есть ли новый ADR, хэш коммита/мержа (если
   уже есть; иначе `dev`).

### Шаг 1. App architecture docs и ADR (если менялась архитектура)

4. Для каждого изменённого/нового модуля обновить контракт в
   `docs/app-architecture/`. Новый модуль без doc — нарушение `AGENTS.md` п.3.
5. Архитектурное решение → новый ADR в `docs/adr/` (`AGENTS.md` п.4). Сослаться на
   него из `MEMORY.md` → раздел «Important decisions».

### Шаг 2. Перезаписать `docs/operations/MEMORY.md` из фактов

6. Полностью перезаписать снимок (это снимок «как сейчас», не журнал), сохранив
   заголовок и эти разделы:
   - **Текущее состояние** — буллеты реального состояния базы (что влито, что
     работает) по фактам из памяти ролей и git-истории сессии.
   - **Important decisions** — ссылка на `docs/adr/` и спеку-источник; добавить
     новый ADR, если появился.
   - **Активные риски** — открытые риски (синхронно с
     `docs/operations/RISK_REGISTER.md`); закрытые в сессии — убрать.
   - **Открытые вопросы** — что ещё не сделано (спринты/эпики из `tasks/`).
   - **Последние изменения** — 1–3 свежие строки `YYYY-MM-DD — что (commit)`.
   Не плодить новые разделы и не удалять перечисленные.

### Шаг 3. Дописать строку в `docs/operations/CHECKPOINTS.md`

7. **Добавить** (не перезаписывать) одну строку в таблицу с колонками ровно
   `Дата | Изменение | Тесты | Docs/ADR | Риск | Commit`:
   - `Дата` — `YYYY-MM-DD`.
   - `Изменение` — что сделано в задаче (со ссылками на код/модули).
   - `Тесты` — `PASS — <команда/набор>` или `FAIL — …`; если тесты невозможны —
     `N/A — задача в BACKLOG (риск отмечен)` (`AGENTS.md` п.9).
   - `Docs/ADR` — какие docs/ADR обновлены (`MEMORY.md`, ADR-id, спека).
   - `Риск` — `Низкий/Средний/Высокий — пояснение`.
   - `Commit` — хэш или `dev`, если ещё не закоммичено.

### Шаг 4. Обновить `tasks/`

8. `tasks/CURRENT_SPRINT.md` — выставить `Status` (TODO/WIP/DONE) выполненным
   строкам в таблице спринта.
9. `tasks/DONE.md` — **дописать** строку `Date | Task | Tests | Docs/Artifacts |
   Checkpoint (commit)` для завершённого; обновить нижний «Итог».
10. Незакрытое оставить/завести в `tasks/BACKLOG.md` (в т.ч. невозможность
    тестов как явный риск).
11. Перед коммитом md прогнать `npx markdownlint-cli '**/*.md' --ignore
    node_modules`. Не трогать GENERATED-обёртки (`CLAUDE.md`/`GEMINI.md`/
    `.codex/config.toml`/`context-bundle.md`).

## Examples

Контекст: закрыта задача SKILL-1 (перенос 22 gate/flow-скиллов в канон `skills/`),
тесты зелёные, коммит `9c1f2ab`, новой архитектуры нет.

- **Шаг 0:** в `.claude/agent-memory/documentation-engineer/MEMORY.md` и
  `solution-architect` — запись «скиллы канонизированы в `skills/`, `.claude/skills`
  генерируется»; в `git log` сессии — коммит переноса 22 скиллов.
- **Шаг 1:** архитектура не менялась → ADR/`app-architecture` не трогаем.
- **Шаг 2** — `docs/operations/MEMORY.md`:
  - *Текущее состояние:* добавить буллет
    «22 gate/flow-скилла канонизированы в `skills/<name>/SKILL.md`; `.claude/skills/`
    раскладывается генерацией».
  - *Последние изменения:* `2026-06-30 — SKILL-1: 22 скилла перенесены в канон
    skills/ (9c1f2ab).`
- **Шаг 3** — строка в `docs/operations/CHECKPOINTS.md`:

  ```
  | 2026-06-30 | SKILL-1: 22 gate/flow-скилла канонизированы в `skills/<name>/SKILL.md`; `.claude/skills/` генерируется | PASS — тесты 21/21; `node cli/bin/infra.js sync --check` → in sync | MEMORY.md обновлён (Текущее состояние + Последние изменения) | Низкий — данные, не код | 9c1f2ab |
  ```

- **Шаг 4:**
  - `tasks/CURRENT_SPRINT.md`: строке `SKILL-1` выставить `Status = DONE`.
  - `tasks/DONE.md`: дописать
    `| 2026-06-30 | **SKILL-1** — 22 скилла в канон skills/ | 21/21 | skills/, .claude/skills (gen) | 9c1f2ab |`.
  - `tasks/BACKLOG.md`: без изменений (нет нового долга).

## Required final report

- Status: PASS / FAIL / PASS WITH RISKS
- Roles used
- Skills/plugins/MCP used
- Files changed
- Tests/checks run
- Docs updated
- Open risks
