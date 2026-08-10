# PixelArtist Architecture

Snapshot as of `f433a50` ("Separate tile commands and terrain features"). No
build step, no framework — plain ES modules loaded directly by the browser
(see [Build & tooling](#build--tooling)).

This document describes the code as it exists *today*. It is mid-migration:
a legacy globally-mutable app (`js/app`, `js/ui`) is being incrementally
wrapped by a newer host/registry framework (`js/host`, `js/modes`,
`js/features`). Both are live at once, bridged explicitly — see
[State model](#state-model).

## Layering

```
js/domain      pure, dependency-free document-kind logic (maps, sprites)
js/core        generic engine: bitmap ops, sheet/layer model, undo stack,
               palettes, autotiling, filters, encoders
js/host        framework: EditorHost, contribution registries, workbench
               primitives, and application services on EditorStore
               (documents, history, selection, project, export)
js/platform    concrete adapters (preferences, file-system, clipboard,
               image-codec) injected into EditorHost
js/modes       one self-contained vertical slice per document kind:
               sprites, tiles, maps
js/features    cross-cutting shell chrome that composes host + modes:
               workbench, menu bar, document tabs, file I/O, filters
js/app         legacy composition root + global mutable state + actions
js/ui          legacy DOM-manipulation panels/dialogs, consumed by both
               js/features and js/modes
js/components  the one shared UI primitive so far (panel-frame.js)
```

`tests/architecture.test.mjs` encodes the intended dependency direction as
executable tests — it is the most authoritative source for these rules and
is worth reading directly. Rules it enforces include: `core` never imports
`app`/`ui`/`host`/`platform`/`modes`; `domain` imports nothing outside
itself; no mode imports a sibling mode's files; the shared workbench
(`features/workbench`) never imports concrete mode UI; and per-mode
pointer/geometry controllers never define `mount*Panel(` or import the
panel-UI modules — contributions register independently instead.

Allowed dependency direction (arrows = "imports from"):

```mermaid
graph TD
    UI["js/ui<br/>(legacy panels/dialogs)"]
    APP["js/app<br/>(legacy state + actions)"]
    FEATURES["js/features<br/>(shell: workbench, menu, file I/O)"]
    MODES["js/modes<br/>(sprites, tiles, maps)"]
    PLATFORM["js/platform<br/>(browser adapters)"]
    HOST["js/host<br/>(EditorHost, registries, application services)"]
    CORE["js/core<br/>(engine: model, undo, palettes)"]
    DOMAIN["js/domain<br/>(pure doc-kind logic)"]

    FEATURES --> MODES
    FEATURES --> HOST
    FEATURES --> APP
    FEATURES --> UI
    MODES --> HOST
    MODES --> CORE
    MODES --> UI
    UI --> APP
    APP --> CORE
    HOST --> CORE
    PLATFORM --> HOST
    CORE --> DOMAIN
```

`core` and `domain` sit at the bottom and import nothing above themselves
(test-enforced); `host` knows nothing about concrete modes; modes never
import each other.

## Bootstrapping

Entry point: `index.html` loads `<script type="module" src="js/bootstrap.js">`.

`js/bootstrap.js` (36 lines) runs in this order:

1. Construct `EditorHost`, wired to the **legacy** `CommandStack`
   (`app/state.js`'s `state.commands`) for undo/redo, and to browser
   platform adapters (`js/platform/browser/*`).
2. `editorHost.registerMode(spriteMode | tileMode | mapMode)` — each mode's
   `register()` hook fires synchronously, registering its document
   provider and contributions.
3. `editorHost.start('sprites')` activates the sprite mode.
4. `setEditorHost(editorHost)` publishes it through `js/host/runtime.js`'s
   module-level singleton getter — the mechanism by which deeply legacy
   code (`app/actions.js`, `js/ui/*`) reaches the one `EditorHost` instance
   without a DI container.
5. Dynamically `import('./app/main.js')` — the legacy composition root
   (16 lines, enforced ≤30 by `architecture.test.mjs`), which mounts DOM:

```js
const workbench = mountEditorWorkbench();
mountFilterController(workbench);
mountProjectController();
mountDocumentController({ editorHost, workbench });
mountApplicationMenu();
mountFileController();
```

```mermaid
sequenceDiagram
    participant HTML as index.html
    participant Boot as bootstrap.js
    participant Host as EditorHost
    participant Modes as sprite/tile/mapMode
    participant Runtime as host/runtime.js
    participant Main as app/main.js

    HTML->>Boot: load module
    Boot->>Host: new EditorHost({historyStack, preferences, platform})
    loop for each mode
        Boot->>Host: registerMode(mode)
        Host->>Modes: mode.register(api)
        Modes->>Host: documents.register(provider) + contributions
    end
    Boot->>Host: start('sprites')
    Host->>Modes: spriteMode.activate(context)
    Boot->>Runtime: setEditorHost(host)
    Boot->>Main: import('./app/main.js')
    Main->>Main: mountEditorWorkbench() / mountFileController() / ...
```

## The host — `EditorHost`

`js/host/editor-host.js` is the central object modes and features register
against. It owns:

- `store` — an `EditorStore` (see [State model](#state-model))
- `contextKeys` — a pub-sub map (`modeId`, `documentKind`, `viewId`,
  `toolId`, ...) used to gate panels/menus/commands
- `registries` — frozen object of 7 `ContributionRegistry` subclasses:
  `modes, commands, panels, tools, views, menus, previews`
- `documents/history/projects/selections/exports/focus` — the application
  services (now colocated in `js/host/*`), exposed individually and
  bundled as `services`

Key methods:

- **`registerMode(definition)`** validates via `ModeRegistry`, then calls
  `definition.register(api)`. `api` exposes *owner-scoped*
  `commands/panels/tools/views/menus/previews.register()` (auto-tagged
  `owner: modeId`, so `removeOwner` can retract everything a mode
  contributed in one call) plus `documents.register(provider)`.
- **`start(modeId)` / `activateMode(modeId)`** transactionally updates
  `store.session` and context keys, then synchronously calls
  `mode.activate(context)` (async activation is disallowed — throws).
  Rolls back on error; disposes the previous mode's activation result on
  success; fires `onDidChangeMode`.
- Every `ContributionRegistry` (`js/host/contributions/registry.js`) is
  generic: `register(definition, {owner})` validates `{id, when?}`,
  `list(context)` filters by `when(context)` and sorts by `order` then
  `id`, `removeOwner(owner)` bulk-retracts. `CommandRegistry` adds
  `execute(id, context, args)`; `PreviewRegistry` requires `render()`;
  `MenuRegistry` requires `items`; `ModeRegistry` requires `label`,
  `documentKinds`, `defaultViewId`.

So: modes register contributions once, at `registerMode` time, and get a
fresh activation context each time they become active.

```mermaid
classDiagram
    class EditorHost {
        +store: EditorStore
        +contextKeys: ContextKeys
        +registries: RegistryBundle
        +documents: DocumentService
        +history: HistoryService
        +projects: ProjectService
        +selections: SelectionService
        +exports: ExportService
        +registerMode(definition) Disposable
        +start(modeId)
        +activateMode(modeId)
        +setProject(project, opts)
        +onDidChangeMode(listener)
    }
    class RegistryBundle {
        +modes: ModeRegistry
        +commands: CommandRegistry
        +panels: PanelRegistry
        +tools: ToolRegistry
        +views: ViewRegistry
        +menus: MenuRegistry
        +previews: PreviewRegistry
    }
    class ContributionRegistry {
        <<abstract>>
        +register(definition, owner) Disposable
        +list(context) definition[]
        +removeOwner(owner)
    }
    class CommandRegistry {
        +execute(id, context, args)
    }
    class ModeDefinition {
        <<frozen object>>
        +id: string
        +label: string
        +order: number
        +documentKinds: string[]
        +defaultViewId: string
        +register(api)
        +activate(context)
    }
    class DocumentProvider {
        <<per mode>>
        +kind: string
        +list(project)
        +get(project, id)
        +create(project, input)
        +rename(document, name)
        +remove(project, id)
    }

    EditorHost *-- RegistryBundle
    RegistryBundle o-- ContributionRegistry : 7 instances
    ContributionRegistry <|-- CommandRegistry
    ContributionRegistry <|-- ModeRegistry
    EditorHost ..> ModeDefinition : registerMode()
    ModeDefinition ..> DocumentProvider : register(api) registers
```

## Modes (`js/modes/`)

Three modes — `sprites` (order 10), `tiles` (order 20), `maps` (order 30) —
each `Object.freeze`d with an identical shape:

```js
export const tileMode = Object.freeze({
  id: 'tiles', label: 'Tile Sheets', order: 20,
  documentKinds: ['tile-sheet'], defaultViewId: 'tiles.sheet',
  register(api) { api.documents.register(tileDocumentProvider); registerTileContributions(api); },
  activate() {},
});
```

Every mode has the same file shape: `index.js` (the definition above),
`documents.js` (a document provider: `{kind, list, get, create, rename,
remove}`), `contributions.js` (registers previews/tools/panels/views),
plus mode-specific controllers.

**Tiles mode** (`js/modes/tiles/`) — this is the mode the autotiles panel
belongs to. It has fully migrated to the Application/Presentation split
(see the Sprites/Maps note below), except for one deliberate exception:
`terrain-preset-art.js` (below), which by design sits outside both layers:

- `contributions.js` registers: a preview provider (`preview.js`); one
  tools contribution whose `createController` wires
  `registerTileTool()`/`registerAutotilePaintTool()` and returns
  `{decorateOverlay}` to layer tile chrome onto the shared canvas; three
  panels gated `when: keys => keys.modeId === 'tiles'` — `tiles.tiles` →
  `#panel-context` (`presentation/tile-panel.js`), `tiles.autotiles` →
  `#panel-autotiles` (`presentation/terrain-set-panel.js`), `tiles.layers` →
  `#panel-tilelayers` (`presentation/tile-layers-panel.js`); two views —
  `tiles.sheet` (shared canvas) and `tiles.tile` (per-tile zoomed editor,
  `presentation/tile-editor-presenter.js`).
- `application/commands/tile-sheet-commands.js` (299 lines) and
  `tile-layer-commands.js` (32 lines) — Command Handlers, resolve their
  sheet by id each call (no captured object references across undo/redo),
  registered by id in `contributions.js`. A test asserts these never touch
  `document/window/alert/confirm/prompt` directly.
- `application/geometry/tile-geometry.js` (79 lines) — pure hit-testing/
  resize math (tile/handle hit-testing, grid bounds, ghost-grid layout) for
  the tile tool, no DOM or state access.
- `presentation/tile-tool-presenter.js` (375 lines) — the tile tool's
  Humble Object: pointer routing and overlay rendering for create/resize/
  move of tiles and grid ownership. Dispatches Commands by id through
  `CommandRegistry`; never imports `application/commands/` directly
  (test-enforced), and never imports the contextual panels or terrain UI
  (also test-enforced).
- `presentation/tile-panel.js` (173 lines), `tile-layers-panel.js`
  (71 lines), `tile-tags-field.js` (69 lines) — panel mount functions for
  the Tiles/Tile-Layers side panels and the shared tag-editing field.
- `presentation/tile-raster-cache.js` (35 lines) — caches a flattened-sheet
  canvas + per-tile thumbnails, invalidated via `invalidateTileRaster()`.
- `application/commands/autotile-paint-commands.js` — Command Handlers
  for the Blob-47 terrain painter: `prepareTerrainPaint`,
  `paintTerrainStroke`, `resolveAutotilePaintConflict`. Resolve-by-id,
  registered by id in `contributions.js`. Wraps `core/terrainsets.js`'s
  pure `assignSlot` directly, via the shared `terrain-slot-snapshot.js`
  helper also used by `terrain-set-commands.js`.
- `application/geometry/autotile-geometry.js` — pure paint-grid/cell/mask
  helpers (`terrainPaintGrid`, `paintTileAt`, `paintCellAt`,
  `strokePaintMask`, `planTerrainPaintCells`, `describeMask`), no DOM or
  state access. `core/blob47.js`'s Blob-47 bitmask/canonicalization
  algorithm itself remains untouched, already pure Domain code.
- `presentation/autotile-paint-presenter.js` — the autotile paint tool's
  Humble Object: pointer/stroke routing, conflict resolution, and all
  Canvas overlay/preview rendering (including the Blob-47 artwork
  reference strip). Dispatches Commands by id; never imports
  `application/commands/` directly (test-enforced).
- `presentation/blob47-coverage-dialog.js` — the standalone Blob-47
  coverage-review `<dialog>`, split out of the painter so the Presenter
  doesn't also own an unrelated `document.createElement` side-panel.
- `application/commands/terrain-set-commands.js` — Command Handlers for
  terrain-set CRUD and slot assignment: `createTerrainSet`,
  `deleteTerrainSet`, `renameTerrainSet`, `assignTerrainSlot`,
  `clearTerrainSlot`, `setTerrainSymmetry`, `applyTerrainLayoutPreset`,
  `setTerrainSetLayer`. Resolve-by-id, registered by id in
  `contributions.js`. Wraps `core/terrainsets.js`'s pure
  `assignSlot`/`applyLayoutPreset` via the shared
  `terrain-slot-snapshot.js` helper below.
- `application/commands/terrain-slot-snapshot.js` — `captureTerrainSlotState`/
  `restoreTerrainSlotState`, shared by `terrain-set-commands.js`,
  `autotile-paint-commands.js`'s `resolveAutotilePaintConflict`, and (since
  3d) `tile-sheet-commands.js`'s `deleteTile`/`deleteGrid`/`resizeGridAxis`.
  Captures every terrain set's `slots` plus every tile's back-reference
  fields (`terrainSetId`/`blobIndex`/`duplicateOf`/`neighbors`) — both
  `assignSlot` and `core/model.js`'s `scrubTileReferences` can mutate a
  terrain set or tile other than the one a caller is directly acting on, so
  the snapshot always covers the whole sheet.
- `application/geometry/terrain-set-geometry.js` — pure view-arrangement
  helpers (`blobStaircaseGroups`, `gridFromRawTemplate`,
  `slotGroupsForViewMode`) for the terrain-set editor's cosmetic slot
  layout, no DOM or state access.
- `presentation/terrain-set-editor.js` — the terrain-set editor's dialogs
  (add-terrain-set, tile-picker) and `renderTerrainSetEditor`, plus the
  Name/Layer/Delete field helpers shared with `tile-panel.js`. Dispatches
  Commands by id; never imports `application/commands/` directly
  (test-enforced).
- `presentation/terrain-set-panel.js` — a thin **panel mount function**:
  builds the tile-picker dialog + editor container, delegates rendering to
  `terrain-set-editor.js`, subscribes to legacy
  `on('project'|'history'|'pixels'|'view'|'selection', ...)` events to
  schedule `queueMicrotask`-debounced re-renders, and syncs
  `state.selectedTerrainSetId` from `state.selectedTileId`.
- `terrain-preset-art.js` — **outside both `application/` and
  `presentation/`**, deliberately. Contains `importPresetArtOntoLayer`,
  which paints a terrain-set preset's reference art onto the active layer
  when a new terrain set is created from that preset. Pushes a raw
  pixel-patch undo entry directly via `core/commands.js`'s `makePixelPatch`
  (the same still-legacy, cross-mode-shared paint-commit idiom
  `js/ui/tools.js` uses elsewhere), which is exactly why it can't live in
  `presentation/`: `tests/architecture.test.mjs`'s presentation-layer scan
  forbids importing `core/commands.js` from anywhere under `presentation/`.
  This is now an enforced, tracked exception — a dedicated architecture
  test pins the exact set of non-application/presentation mode files
  allowed to import `core/commands.js` to this one file — not an
  accidental layering gap.
- `application/commands/tile-editor-commands.js` — one resolve-by-id
  Command Handler, `setTileNeighborSlot`, for the tile editor's manual
  neighbor-slot dialog. Registered by id in `contributions.js`.
- `application/geometry/tile-editor-geometry.js` — pure offset/hit-testing
  math for the tile editor's neighbor grid (`computeOffset`,
  `mapEditorPoint`, `cellAt`, `insideCenter`, `dirForCell`), no DOM or state
  access.
- `presentation/tile-editor-presenter.js` — the tile editor's Humble
  Object: a second `CanvasView` showing a zoomed, single-tile view with a
  live neighbor preview (redrawn from the same flattened-sheet cache
  pattern as `tile-raster-cache.js`) and the neighbor-slot config dialog.
  Dispatches Commands by id; never imports `application/commands/` directly
  (test-enforced).

**Sprites mode** follows the same Application/Presentation split (see
`js/modes/sprites/application/` and `js/modes/sprites/presentation/`):
`frame-tool-presenter.js` + `frame-chrome-geometry.js`/`frame-geometry.js`/
`frame-pixel-motion.js`/`frame-tool-state.js` (frame/strip tool),
`frames-panel.js`, `timeline-presenter.js` + `timeline-playback.js`
(Timeline dock), `animations-panel.js`, and `frame-editor-presenter.js` +
`onion-skin.js`/`frame-navigation.js` (frame editor + onion skin), backed by
Command Handlers under `application/commands/`. **Maps mode**: `map-editor.js`,
`map-panels.js`.

## Features (`js/features/`)

Orthogonal to modes — one slice per cross-cutting shell concern, not per
document kind. This is what actually mounts DOM at startup (called from
`app/main.js`):

- `workbench/editor-workbench.js` (289 lines) — builds the shared
  `CanvasView`s, status bar, zoom shortcuts, and **generically iterates
  the host's registries** (`registries.tools.list().map(def =>
  def.createController(...))`, a `PanelManager` reconciling
  `registries.panels` against DOM, `registries.views.list()` populating
  view controllers). Zero mode-specific imports (test-enforced).
- `project/document-controller.js` (433 lines) — mode-tab switching,
  sheet/map CRUD, undo/redo/cut/copy/paste, and
  `legacy-state-adapter.js`'s bridge to the host (see
  [State model](#state-model)).
- `project/file-controller.js` (536 lines) — open/save/import/export flows.
- `project/project-controller.js` (443 lines) — project settings, new
  project.
- `shell/menu-controller.js` (93 lines) — builds the `MENUS` array,
  mounts the menu bar.
- `transforms/filter-controller.js` (743 lines) — filter dialogs
  (Chroma Key, Quantize, Checkerboard removal) with live preview.

In short: **modes** = what document kind is being edited plus its
tool/panel/view contributions; **features** = the always-present shell
that composes the host and all registered modes together. Features import
from `js/host`, `js/app` (legacy state/actions), and `js/ui`; modes stay
self-contained and are driven generically through the registries.

## Commands — `defineAction`

`js/app/actions.js` (95 lines) is a **compatibility facade over the host's
`CommandRegistry`**, not a separate system:

```js
export function defineAction(id, def) {
  registrations.get(id)?.dispose();               // idempotent redefinition
  const action = { id, label:'', shortcut:null, isEnabled:()=>true, ...def };
  const registration = registry().register({
    ...action,
    when: context => action.isAvailable(context),
    execute: (context, args) => action.run(context, args),
  }, { owner: 'legacy-action-facade' });
}
```

`bindAction(el, id)` wires a toolbar button: click → `runAction(id)`, plus
a subscription to the legacy `on('*', ...)` firehose to refresh
`hidden`/`disabled`/`checked` after any app event.

`js/ui/menubar.js`'s `mountMenuBar(el, menus)` renders a declarative
`MENUS` array (built in `features/shell/menu-controller.js`) whose items
are only `{action: 'id'}` or `{separator: true}` — read exclusively
through `getAction`/`runAction`, silently skipping unknown ids so menus
can be built incrementally. Nested submenus via `action.submenu`
(`items | () => items`, re-evaluated on each open).

Actions are defined near the logic they trigger, all over the codebase —
one `defineAction` call per id, consumed by both a toolbar button
(`bindAction`) and a menu item (`getAction`/`runAction`), so they can never
drift out of sync with each other.

## Rendering & the `layerTree` / `layers` split

Core rendering lives in `js/core/model.js` / `js/core/pixels.js`.
`flattenSheet(sheet, floating, overrideLayers)` is the master compositor:
gathers `sheetLayers(sheet)` (walks `layerTree`), excludes layers owned by
an "accepted strip" animation, composites the rest bottom-to-top
(`flattenSheetLayers`), then hard-blits each accepted strip's own layer
group into just its animation frames' rects. `overrideLayers` lets filter
previews and the Preview panel substitute hypothetical bitmaps without
touching real data.

Consumers cache their own flattened canvas, invalidated on legacy
`'project'`/`'pixels'`/`'history'` events: `editor-workbench.js` (main
canvas), `modes/tiles/presentation/tile-raster-cache.js` (tile sheet + thumbnails),
`modes/{sprites,tiles}/preview.js` (Preview panel).

**`sheet.layerTree` and `sheet.layers` are two unrelated fields that
happen to share a naming root** — worth flagging explicitly since it's a
common trap when reading this code:

- `sheet.layerTree` — the actual pixel-layer hierarchy (a tree of
  `GROUP`/`LAYER` nodes, a group can own an animation via `animationId`).
  Exists on every sheet. `sheetLayers(sheet) = flattenLayers(sheet.layerTree)`
  is what actually gets rendered.
- `sheet.layers` — a flat array of plain strings, tile-only (`null` on
  sprite sheets). Arbitrary "layer name" tags (e.g. "Ground", "Decor")
  used to categorize individual `tile` objects (`tile.layer = name`),
  managed entirely by `application/commands/tile-layer-commands.js` +
  `presentation/tile-layers-panel.js`.
  Has nothing to do with pixel compositing.

`model.js` documents the history: *"A sheet now stores its layers inside a
hierarchical `layerTree` instead of a flat `layers[]` array... Every
operation that used to read `sheet.layers` now goes through
`sheetLayers(sheet)`..."* — `sheet.layers` was repurposed for tile-tag
names rather than removed, which is why the name collides.

```mermaid
classDiagram
    class Sheet {
        +id: string
        +kind: 'sprite' | 'tile'
        +layerTree: GroupNode
        +layers: string[] | null
        +tiles: Tile[]
    }
    class GroupNode {
        +type: 'GROUP'
        +children: (GroupNode|LayerNode)[]
        +animationId?: string
    }
    class LayerNode {
        +type: 'LAYER'
        +id: string
        +bitmap: ImageData
    }
    class Tile {
        +index: number
        +layer: string
    }
    Sheet "1" *-- "1" GroupNode : layerTree (pixel layers)
    GroupNode "1" o-- "*" GroupNode
    GroupNode "1" o-- "*" LayerNode
    Sheet "1" o-- "*" Tile : tile-kind only
    Tile "*" ..> "*" Sheet : layer references a name in sheet.layers[]

    note for Sheet "layerTree = real bitmaps, rendered.\nlayers = tile tag names, unrelated to compositing."
```

## State model

State is **distributed across two coexisting stores mid-migration**,
bridged explicitly — this is the single most important thing to
understand before changing anything here:

1. **Legacy** — `js/app/state.js`: one mutable `state` object (`project`,
   `mode`, `view`, `activeSheetId`, `activeLayerId`, `tool`,
   `commands: new CommandStack()`, `floating`, ...) plus a flat
   `on(event, fn)` / `emit(event, payload)` pub-sub (`'project' | 'view' |
   'tool' | 'history' | 'selection' | 'pixels' | 'colors' | 'brushSize' |
   'playhead' | '*'`). Almost all actual document mutation still happens
   here, and most of `js/ui`/`js/modes`/`js/features` read/write it
   directly.
2. **New** — `js/host/editor-store.js`'s `EditorStore`: a small
   selector-based reactive store (`getState()`, `transaction(reason,
   mutate)`, `subscribe(selector, listener, {equals, signal,
   fireImmediately})`) holding `{project, session, interaction,
   workspace}`. This is what `EditorHost` and its application services
   (`DocumentService`, `HistoryService`, `ProjectService`,
   `SelectionService`) operate on.

`js/features/project/legacy-state-adapter.js`'s `syncLegacyStateToHost`
is the one-way bridge, called from `document-controller.js` on every
`'project'|'view'|'selection'|'tool'|'history'` legacy event: it activates
the matching host mode, pushes `legacyState.project` into
`host.store.setProject(...)`, resolves the active document into
`host.documents.setActive(...)`, and mirrors selection ids into
`store.session` + `host.contextKeys`. Its own comment states the intent
plainly: *"the host is authoritative for mode activation while legacy
feature controllers still write the existing state object... lets
features migrate one at a time without maintaining two independent
application states."*

```mermaid
sequenceDiagram
    participant State as app/state.js (legacy, mutable)
    participant DC as document-controller.js
    participant Adapter as legacy-state-adapter.js
    participant Host as EditorHost
    participant Store as EditorStore

    State-->>DC: emit('project' | 'view' | 'selection' | 'tool' | 'history')
    DC->>Adapter: syncLegacyStateToHost(host, legacyState)
    Adapter->>Host: activateMode(matching mode)
    Adapter->>Store: setProject(legacyState.project)
    Adapter->>Host: documents.setActive(activeDocumentRef)
    Adapter->>Store: session.selectionsByDocument = ...
    Adapter->>Host: contextKeys updated
    Note over State,Store: one-way bridge — legacy state is<br/>still the source of truth for mutation
```

Undo/redo itself still runs through the one legacy `CommandStack`
(`core/commands.js`) — `EditorHost` is constructed with `historyStack:
legacyState.commands`, so `HistoryService` wraps the *same* stack rather
than a second one.

Two pieces look scaffolded but not yet wired to a real caller: `ExportService`
(exports still run through `js/app/exports.js` directly) and
`js/host/workbench/view-manager.js`'s `ViewManager` (`editor-workbench.js`
iterates `registries.views.list()` manually instead). Worth treating as
forward-looking placeholders, not active pipelines, if referencing them.

Palettes, project settings, sheets/maps/frames/animations/tiles/terrain
sets all live inline on `state.project`, created by `core/model.js`'s
`createProject`/`createSheet`/`createMap` and serialized in the same file
(`serializeGroup`/`deserializeGroup`, with a project-version migration
path from the old flat `layers[]` to `layerTree`).

## UI layer

No component framework — plain DOM manipulation, organized as **mount
functions**: `mountXxxPanel(element)` builds DOM once, wires `on(event,
fn)` subscriptions for legacy-state-driven re-renders (often
microtask-debounced, as in `presentation/terrain-set-panel.js`), and returns
`{dispose()}`. Uniform across `js/ui/*.js` and `js/modes/*/*.js`.

The one shared primitive is `js/components/panels/panel-frame.js`'s
`createPanelFrame({id, title, collapsed, onCollapsedChange})` — collapsible
chrome used exclusively by `PanelManager`
(`js/host/workbench/panel-manager.js`) for panels with no fixed
`mountPoint`. `PanelManager.reconcile(context)` diffs
`registries.panels.list(contextKeys)` against currently-mounted panels:
hides/disposes ones no longer wanted, mounts new ones either into a fixed
DOM id (`panel.mountPoint`, e.g. `#panel-context`, `#panel-autotiles`) or
into an auto-generated frame docked into a `[data-workbench-region]`
(`js/host/workbench/layout.js`). Per-panel collapsed/hidden state persists
through the injected `preferences` port.

Menus: `js/ui/menubar.js` (see [Commands](#commands--defineaction)).
Dialogs: native `<dialog>` elements in `index.html`, `.showModal()`, with
`js/ui/dialogs.js` giving one button Enter-to-submit behavior. Toolbar:
`js/ui/tools.js`'s `mountToolPalette`.

`index.html` lays out explicit regions: `#tool-palette` (left),
`#canvas-host` (center), `#side-panels` (right, holds `#panel-layers`,
`#panel-context`, `#panel-animation`, `#panel-autotiles`,
`#panel-tilelayers`, `#panel-preview`, `#panel-map-assets`),
`#timeline-dock` (bottom).

## Build & tooling

No bundler, no TypeScript — plain native ES modules
(`"type": "module"` in `package.json`). `npm test` runs `node --test
tests/*.mjs` (Node's built-in test runner, ~45 files, including the
layering-enforcing `tests/architecture.test.mjs`). `serve.ps1` runs
`npx serve` on an ephemeral port with `Cache-Control: no-store` forced
(`serve.json`) — a dev-run mechanism, not a build step, needed only
because ES modules require an HTTP server (`file://` won't work).

## Extension points

- **New mode**: `js/modes/<name>/{index.js, documents.js,
  contributions.js, ...}` following the shape in
  [Modes](#modes-jsmodes). Register a document provider, register
  contributions via the scoped `api.{commands,panels,tools,views,menus,
  previews}.register(...)` inside `register(api)`, then call
  `editorHost.registerMode(...)` in `js/bootstrap.js`. Must not import
  another mode's files (test-enforced); keep pointer/geometry logic
  separate from panel-mounting code (test-enforced for the existing
  modes).
- **New tool**: a `tools` contribution
  (`{id, label, order, createController(context)}`) in a mode's
  `contributions.js`, whose controller typically calls a
  `registerXTool()` pair and optionally returns `{decorateOverlay()}` to
  hook `canvasView.onOverlay`.
- **New menu command**: `defineAction('namespace.verb', {label, shortcut,
  run(context, args), isEnabled(), isChecked(), isAvailable(),
  submenu})` near the logic it belongs to, then add
  `{action: 'namespace.verb'}` to the relevant menu's `items` in
  `features/shell/menu-controller.js`'s `MENUS`, and/or
  `bindAction(buttonEl, 'namespace.verb')` for a toolbar button.
  `menubar.js` silently skips unregistered ids, so ordering across files
  doesn't matter.
- **New panel**: `api.panels.register({id, title, region, order, when,
  mountPoint?, persistent?, create(element, context)})` inside a mode's
  (or a feature's) contributions — either a fixed DOM id already in
  `index.html`, or an auto-generated `PanelManager`/`createPanelFrame`
  docked into a `data-workbench-region`.
