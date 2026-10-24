# ChatterPay Analytics API — Commits, deploy y PR

> Documento autónomo para ejecutar las tres tareas manualmente, sin invocar Skills. Las rutas concretas se verifican en la máquina; este archivo no certifica el estado de ningún repositorio, GitHub, GCP ni base de datos.

## 0. Objetivo y seguridad

Generar textos en inglés, basados en evidencia de los cambios reales, para: (1) mensajes y comandos Git por archivo, (2) notas de próximos deploys de develop y main y (3) descripciones de PR agrupadas por repositorio y task/issue.

**Restricciones de todas las tareas**

- Inspeccionar el código, diffs, archivos nuevos, commits pertinentes y contexto documentado **antes** de escribir mensajes; no atribuir cambios no verificados.
- Nunca ejecutar `git add`, `git commit`, `git push`, `git reset`, `git checkout`, `git merge`, creación de PR, triggers de Cloud Build, despliegues de Cloud Run, escrituras a GitHub/GCP ni escrituras a bases de datos. Los comandos Git de commit son **texto a entregar**, nunca para ejecutar.
- Excepción de escritura: la Skill de deploy actualiza **exclusivamente** los dos archivos de deploy que indica el operador. La Skill de PR no escribe archivos. No editar código de aplicación ni otros archivos.
- Las inspecciones Git/`gh`/cloud son de solo lectura. No leer, pegar ni guardar valores de secretos, tokens, credenciales ni el contenido de `.env`; los nombres de variables están en `.env.example`.
- No inventar IDs de issues, URLs, PRs, ramas base, entornos, cambios de configuración, operaciones en GCP ni resultados de tests. Si un dato necesario falta, consultar o marcar `UNVERIFIED`, nunca presentarlo como hecho.
- Un cambio de código no prueba que Cloud Run, Cloud Build, IAM, Secret Manager o la base de MongoDB de analytics hayan cambiado.
- La API sirve datos sintéticos en V0. Los textos no presentan cifras del mock como datos de ChatterPay B2C.
- Conservar contenido existente, no sobrescribir notas de tareas ajenas, evitar entradas duplicadas. Minimizar cambios y mostrar los archivos modificados.
- Usar nombres de repos y rutas inferidos de `git rev-parse`, `git remote -v` y evidencia real, no del nombre de la carpeta solamente. La carpeta local es `chatterpay-analytics-api` y el remoto es `chatterpay/chatterpay-analytics-api`.

## 1. Resolución de contexto, repositorios e issues

1. Leer argumentos del usuario y contexto reciente disponible. Detectar repos afectados sin expandir a repositorios no trabajados. Los repos de ChatterPay Analytics son el site (`chatterpay/chatterpay-analytics-site`) y la API (`chatterpay/chatterpay-analytics-api`).
2. Si hace falta delimitar repos, presentar las rutas encontradas y **confirmar el repositorio actual**. Para commits esta confirmación se pide siempre, aunque exista un único repo.
3. Detectar `git rev-parse --show-toplevel`, `git status --porcelain=v1`, rama y remoto. Si hay varios repos, tratar cada repositorio por separado.
4. Resolver issue/task IDs desde el pedido explícito, historial de la tarea, branch, PR, mensajes o GitHub cuando sea posible. Verificar que el issue esté asociado al repositorio correcto; `#8` en la API no identifica `#8` en el site. Usar `gh issue view <id> --repo <owner/name>` o la URL del issue si GitHub está disponible, **solo lectura**.
5. Si un issue es indispensable y falta: preguntar los ID(s) y URL(s). En commits es válido que la tarea no tenga issue si el usuario lo confirma.
6. Tipos e iconos de commit: el repo no tiene `.doc/development/coding-guidelines.md`. `AGENTS.md` define el formato `[type] :gitmoji: message`; los tipos e iconos salen del catálogo de la sección 5.
7. Elegir el scope de cada comando: pendientes del working tree para commits; trabajo realizado en la(s) tarea(s) para deploy y PR, con diff respecto a la base de comparación confirmada.

## 2. `/chatterpay-commit-messages`

**Entrada**: repositorio confirmado, task ID opcional, working tree e índice de Git. **Salida**: texto plano por consola. No crear archivos, no escribir comandos en el repositorio, no ejecutar ninguna operación Git mutante.

### Inspección

- `git status --porcelain=v1 -uall` e inspección de todos los archivos relevantes: tracked modificados, staged, untracked, eliminados y renombrados.
- `git diff -- <path>` para cambios sin stage; `git diff --cached -- <path>` para cambios stageados; ambos si procede; leer también el contenido de archivos untracked, sin volcar secretos al informe. Para borrados, identificar qué desapareció. Para rename, examinar contenido/diff y detectar si es un solo archivo lógico.
- No inferir mensajes solo por el nombre del archivo. Si un archivo mezcla cambios inconexos, describirlos con precisión y concisión, o marcar revisión manual si no entran en 80 caracteres.
- Comprobar si ya hay archivos de otras tareas en el índice. **Advertir**: `git commit -m` sin `--only` incluye todo lo previamente stageado, lo que rompe el objetivo de un commit por archivo. No vaciar ni alterar el índice.
- Un cambio de rutas o schemas sin el `openapi/openapi.yaml` regenerado en el working tree se informa como aviso: el contrato va en la misma tarea.
- Un cambio en la salida del generador de métricas sin un `DATASET_VERSION` nuevo se informa como aviso.

### Verificaciones

- Antes de entregar los comandos, correr `yarn lint:ci`, `yarn type-check`, `yarn test` y `yarn openapi:check`.
- No correr `yarn openapi` dentro de la Skill: reescribe `openapi/openapi.yaml`.
- No correr `yarn pre-commit` ni `yarn lint:fix` dentro de la Skill: reescriben archivos. Si alguna verificación falla, informarlo junto con los comandos.

### Formato

`git add -- "path/to/file"; git commit -m "[type] :icon: Imperative description (#123)"`

- Una línea por **archivo lógico**; una línea adicional solo para avisos necesarios. No usar `git add .`, `git commit -am`, ni agrupar varios cambios en un commit. Para un rename, incluir ruta anterior y nueva si Git lo requiere.
- Mantener los corchetes literales en `[feat]`, `[fix]`, etc. El icono se escribe como texto con dos puntos: `:sparkles:`, `:bug:`, `:lock:`; **no** emoji Unicode.
- Mensaje en inglés, verbo imperativo (`Add`, `Fix`, `Update`, `Remove`, `Migrate`, `Align`, etc.). Describir el comportamiento concreto, sin frases vacías como `Update code`.
- Longitud máxima **80 caracteres para todo el asunto del commit**, incluyendo `[type]`, espacio, `:icon:`, descripción y `(#123)` si existe.
- Con issue conocido: sufijo literal `(#<id>)`. Si el usuario **confirma que no hay ID**, omitir el sufijo; no emitir `(#xxx)`, `(#0)` ni inventar un número. Si se desconoce y pudiera existir, preguntar.
- Elegir tipo por finalidad del cambio, no por extensión: workflow de GitHub Actions `ci`, `Dockerfile` o configuración de Cloud Build `build`, tests de Vitest `test`, bug `fix`, documentación y `openapi/openapi.yaml` `docs`, script de generación del contrato `build`, configuración `chore` o `build` según propósito, endpoint o comportamiento nuevo para el BFF `feat`.
- Iconos frecuentes en este repo: feature `:sparkles:`, bug `:bug:`, seguridad (sesión, JWT, códigos de acceso, headers) `:lock:`, autorización y roles `:passport_control:`, validación de schemas `:safety_vest:`, manejo de errores `:goal_net:`, mock de métricas `:clown_face:`, lógica de negocio `:necktie:`, healthcheck `:stethoscope:`, test `:white_check_mark:`, CI `:construction_worker:`, tipos `:label:`, logs `:loud_sound:`, base de datos `:card_file_box:`, configuración `:wrench:`, documentación `:memo:`, infraestructura `:bricks:`.
- Mantener las rutas aptas para la shell usada; la comilla doble funciona en Git Bash y en PowerShell para rutas ordinarias.

### Ejemplo de formato (no representa cambios actuales)

```text
git add -- "src/routes/metrics.ts"; git commit -m "[feat] :sparkles: Add the network filter to the revenue route (#8)"
git add -- "openapi/openapi.yaml"; git commit -m "[docs] :memo: Regenerate the OpenAPI contract for the revenue route (#8)"
git add -- "test/metrics-routes.test.ts"; git commit -m "[test] :white_check_mark: Cover unknown revenue query parameters (#8)"
```

El agente **verifica la longitud de cada mensaje** (solo el contenido entre comillas después de `-m`) antes de devolver el resultado.

## 3. `/chatterpay-deploy-texts`

**Entrada**: una o más tareas/URLs de GitHub, evidencias verificadas por repo y destino `develop`, `main` o ambos. **Salida**: actualizaciones idempotentes en los dos archivos de deploy que indica el operador (develop y main). Este repo no define su ubicación: si el operador no la da, preguntarla. No leer ni listar otros archivos de esa carpeta.

### Proceso

1. Comprobar existencia y leer por completo los dos archivos. Si falta alguno, **no** crear uno nuevo: informar y pedir la ruta correcta.
2. Resolver issue IDs y su URL/título de GitHub; si faltan, **preguntar**. La URL del issue es la del repositorio dueño de esa tarea.
3. Confirmar si la información corresponde a `develop`, a `main` o a ambos. Añadir a cada archivo solo lo que corresponde a ese ambiente. No afirmar `deployed` por leer código.
4. Inspeccionar commits/diff/PR y las evidencias aportadas. Cambios de Cloud Run, Cloud Build, IAM (`roles/run.invoker` del service account del site), Secret Manager, variables de entorno, colecciones o índices de MongoDB se incluyen solo si están sustentados por evidencia verificable.
5. Localizar una sección existente de la tarea por **URL completa** o por número y repo; actualizarla en su lugar y conservar los ítems previos. Si no existe, crearla una sola vez.
6. Agrupar los cambios por componente en subtítulos, solamente si hay datos: `### API Changes`, `### Site Changes`, `### GCP Changes`, `### Database Changes`, `### Configuration Changes`, `### Deployment Changes`. Adaptarse a los encabezados ya usados en el archivo.
7. Las notas contienen solo los cambios (código, contrato OpenAPI, objetos de base de datos, configuración, recursos de GCP), en inglés técnico y pasado (`Added`, `Fixed`, `Updated`). Sin estados de avance, procedimientos, comandos ni rutas locales. Conservar nombres precisos (ruta y método, schema, `DATASET_VERSION`, colección, variable de entorno por nombre, servicio de Cloud Run) y evitar relleno.
8. No revelar valores de variables ni material secreto; una variable nueva se nombra sin su valor si es un secreto.
9. Mantener Markdown válido, orden y contenido ajeno. Reportar secciones agregadas/actualizadas en cada destino. Si no hay tareas para uno de los destinos, conservarlo intacto y explicar por qué.

### Ejemplo de formato (no hay que replicar afirmaciones sin probarlas)

```md
## [#8: Serve revenue metrics by network and asset](https://github.com/chatterpay/chatterpay-analytics-api/issues/8)

### API Changes

- Added `GET /v1/metrics/revenue` with transfer and swap fees, volume, and network and asset breakdowns from the mock dataset.
- Updated `openapi/openapi.yaml` with the revenue route.

### GCP Changes

- Granted `roles/run.invoker` on the API service to the site service account.
```

Este bloque es **modelo de estructura**, no datos validados. No añadir la entrada del ejemplo si el trabajo actual no la incluye.

## 4. `/chatterpay-pr-texts`

**Entrada**: repositorios y tareas trabajados dentro del scope de la sesión/branch; issues/URLs verificables, commits/diffs relevantes. **Salida**: texto en consola. No se crea ni actualiza ningún archivo.

- Si hay varios repos, usar encabezados `## <owner>/<repo>` y mantener bajo cada uno las tareas **de ese repositorio**. El bloque de cada PR se puede copiar sin el encabezado externo.
- Por tarea:

```md
### Changes related to #8

- Added `GET /v1/metrics/revenue`, which returns transfer and swap fees, volume, and network and asset breakdowns whose totals equal the sum of their series, with `dataStatus: "mock"`.
- Regenerated `openapi/openapi.yaml` and added route tests for the `network` and `range` filters and for unknown parameters answering 400.
```

- Cada bullet refleja cambios **implementados**, su motivo cuando corresponde, efectos funcionales, módulos/rutas clave y tests añadidos o ejecutados que estén verificados. Precisión técnica por encima de adjetivos; evitar listas de rutas sin explicación.
- Inglés en pasado (`Added`, `Fixed`, `Updated`). Sin encabezados vacíos y sin afirmar una validación no ejecutada.
- Determinar el diff contra la rama base del PR: `gh pr view`/`gh pr diff` en modo lectura si existe PR, o la rama contra el merge-base de la base confirmada. No asumir `develop`/`main` sin confirmación. Cambios sin commit se incluyen solo cuando pertenecen al scope pedido y se aclara que todavía no están en el PR.
- Si faltan issue IDs: preguntar antes de finalizar. No agrupar en una tarea arbitraria ni inventar `#0`.

## 5. Catálogo de tipos e iconos

`AGENTS.md` fija el formato `[type] :gitmoji: message`; este catálogo define los valores.

### Tipos permitidos

- `feat`: user-facing feature.
- `fix`: user-facing bug fix.
- `perf`: performance.
- `build`: build system, packaging, container or deployment configuration.
- `ci`: CI automation.
- `docs`: documentation.
- `refactor`: behavior-preserving source refactor.
- `style`: formatting without behavior changes.
- `test`: tests.
- `chore`: maintenance outside source and tests.
- `revert`: revert a previous change.

### Códigos de iconos Gitmoji

Los códigos (por ejemplo, `:sparkles:`) se escriben literalmente en mensajes Git. El emoji visual sirve solo para identificar la opción.

- 🎨 :art: Improve structure / format of the code.
- ⚡️ :zap: Improve performance.
- 🔥 :fire: Remove code or files.
- 🐛 :bug: Fix a bug.
- 🚑️ :ambulance: Critical hotfix.
- ✨ :sparkles: Introduce new features.
- 📝 :memo: Add or update documentation.
- 🚀 :rocket: Deploy stuff.
- 💄 :lipstick: Add or update the UI and style files.
- 🎉 :tada: Begin a project.
- ✅ :white_check_mark: Add, update, or pass tests.
- 🔒️ :lock: Fix security or privacy issues.
- 🔐 :closed_lock_with_key: Add or update secrets.
- 🔖 :bookmark: Release / Version tags.
- 🚨 :rotating_light: Fix compiler / linter warnings.
- 🚧 :construction: Work in progress.
- 💚 :green_heart: Fix CI Build.
- ⬇️ :arrow_down: Downgrade dependencies.
- ⬆️ :arrow_up: Upgrade dependencies.
- 📌 :pushpin: Pin dependencies to specific versions.
- 👷 :construction_worker: Add or update CI build system.
- 📈 :chart_with_upwards_trend: Add or update analytics or track code.
- ♻️ :recycle: Refactor code.
- ➕ :heavy_plus_sign: Add a dependency.
- ➖ :heavy_minus_sign: Remove a dependency.
- 🔧 :wrench: Add or update configuration files.
- 🔨 :hammer: Add or update development scripts.
- 🌐 :globe_with_meridians: Internationalization and localization.
- ✏️ :pencil2: Fix typos.
- ⏪️ :rewind: Revert changes.
- 🔀 :twisted_rightwards_arrows: Merge branches.
- 📦️ :package: Add or update compiled files or packages.
- 👽️ :alien: Update code due to external API changes.
- 🚚 :truck: Move or rename resources (e.g.: files, paths, routes).
- 📄 :page_facing_up: Add or update license.
- 💥 :boom: Introduce breaking changes.
- 🍱 :bento: Add or update assets.
- ♿️ :wheelchair: Improve accessibility.
- 💡 :bulb: Add or update comments in source code.
- 💬 :speech_balloon: Add or update text and literals.
- 🗃️ :card_file_box: Perform database related changes.
- 🔊 :loud_sound: Add or update logs.
- 🔇 :mute: Remove logs.
- 👥 :busts_in_silhouette: Add or update contributor(s).
- 🚸 :children_crossing: Improve user experience / usability.
- 🏗️ :building_construction: Make architectural changes.
- 📱 :iphone: Work on responsive design.
- 🤡 :clown_face: Mock things.
- 🙈 :see_no_evil: Add or update a .gitignore file.
- 📸 :camera_flash: Add or update snapshots.
- ⚗️ :alembic: Perform experiments.
- 🔍️ :mag: Improve SEO.
- 🏷️ :label: Add or update types.
- 🌱 :seedling: Add or update seed files.
- 🚩 :triangular_flag_on_post: Add, update, or remove feature flags.
- 🥅 :goal_net: Catch errors.
- 💫 :dizzy: Add or update animations and transitions.
- 🗑️ :wastebasket: Deprecate code that needs to be cleaned up.
- 🛂 :passport_control: Work on code related to authorization, roles and permissions.
- 🩹 :adhesive_bandage: Simple fix for a non-critical issue.
- 🧐 :monocle_face: Data exploration/inspection.
- ⚰️ :coffin: Remove dead code.
- 🧪 :test_tube: Add a failing test.
- 👔 :necktie: Add or update business logic.
- 🩺 :stethoscope: Add or update healthcheck.
- 🧱 :bricks: Infrastructure related changes.
- 🧑‍💻 :technologist: Improve developer experience.
- 🧵 :thread: Add or update code related to multithreading or concurrency.
- 🦺 :safety_vest: Add or update code related to validation.

## 6. Configuración por usuario y por proyecto

- **Personal:** `~/.claude/skills/<name>/SKILL.md`. Disponible para todas las sesiones locales de ese perfil.
- **Proyecto:** `<repo-root>/.claude/skills/<name>/SKILL.md`. Disponible en sesiones cuyo directorio de trabajo pertenezca a este repo.
- Config de ChatterPay Analytics: `<repo-root>/.claude/rules/chatterpay-workflows.md`; referencia para lectura humana: `<repo-root>/.claude/docs/chatterpay-workflows-reference.md`.
- Si personal y proyecto contienen el mismo nombre de Skill, **la personal tiene prioridad en la invocación**. Por eso las Skills buscan primero la referencia y la config del proyecto, que describen este repo.
- Las Skills se invocan explícitamente; no se inyectan automáticamente en cada conversación.

## 7. Criterios de aceptación

1. Desde un repo con 3 archivos pendientes, `chatterpay-commit-messages` devuelve exactamente 3 líneas `git add ...; git commit -m ...`; cada asunto tiene <=80 caracteres, está en inglés e incluye icono textual; **git status permanece igual**.
2. Con issue ID presente, se usa el sufijo correcto. Si el operador confirma ausencia de issue, no se genera placeholder.
3. Un `fix` de seguridad no se etiqueta `feat` solo porque cambió código; se leen los diffs y el catálogo.
4. Con cambios ya stageados de otra tarea, se muestra aviso de posible contaminación del commit; no se manipula el índice.
5. Los resultados de `yarn lint:ci`, `yarn type-check`, `yarn test` y `yarn openapi:check` se informan junto con los comandos.
6. `chatterpay-deploy-texts` identifica la tarea por URL y no la duplica al ejecutarse dos veces; escribe solo el entorno correspondiente y conserva secciones ajenas.
7. Ninguna nota menciona recursos de GCP, objetos de MongoDB ni variables de entorno sin evidencia.
8. `chatterpay-pr-texts` muestra en consola las secciones por repositorio e issue y no escribe archivos.
9. Faltan ID, repo, rama base, entorno o rutas de deploy: el comando pregunta solo lo necesario y no inventa valores.
10. Ninguno de los tres comandos ejecuta commit, push, deploy, PR ni mutaciones externas.
