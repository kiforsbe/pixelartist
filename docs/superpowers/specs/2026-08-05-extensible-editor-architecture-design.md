# PixelArtist Extensible Editor Architecture

## Summary

PixelArtist will be refactored incrementally into a browser-native editor
platform built around an `EditorHost`. The application remains vanilla
JavaScript with native ES modules, no build step, the existing project format,
and behavior-compatible workflows during the migration.

The host owns shared services and contribution registries. Sprite, tile, and
map editing become self-contained modes that contribute documents, views,
tools, commands, panels, menus, and preview behavior without requiring
mode-specific branches in shared code.

```text
bootstrap
├── browser adapters
├── application services ──> pure domain
├── editor host
│   ├── workbench and registries
│   └── common UI/components
└── registered modes
    ├── sprites
    ├── tiles
    └── maps
```

Dependency rules:

- Domain code imports no application, browser, host, or UI modules.
- Application services depend on domain code and abstract browser ports.
- Reusable components receive data and callbacks; they never import global
  state.
- Modes depend on host contracts, application services, common features, and
  domain code.
- Modes never import one another.
- Only bootstrap imports and registers concrete modes.

## Proposed Structure

```text
js/
  bootstrap.js

  domain/
    project/          project model, versioning, serialization
    bitmap/           pixels, palettes, transforms, quantization
    layers/           layer tree and compositing
    sprites/          frames, animations, strips
    tiles/            tiles, grids, terrain sets, autotiling
    maps/             maps, map layers, placement and bounds
    history/          undoable domain command primitives

  application/
    editor-store.js
    project-service.js
    document-service.js
    history-service.js
    selection-service.js
    export-service.js
    ports.js

  platform/browser/
    file-system.js
    autosave.js
    clipboard.js
    image-codec.js
    preferences.js

  host/
    editor-host.js
    mode-registry.js
    context-keys.js
    contributions/
      commands.js
      panels.js
      tools.js
      views.js
      menus.js
    workbench/
      layout.js
      panel-manager.js
      view-manager.js
      focus-service.js

  components/
    primitives/       buttons, fields, splitters, tabs, toolbar
    canvas/           viewport, camera, render layers, pointer routing
    panels/           panel frame, tree/list, empty/error states
    dialogs/          dialog host and reusable form controls

  features/
    layers/           shared layer panel with mode adapters
    colors/           palette and color controls
    preview/          shared preview panel with renderer providers
    transforms/       floating selections and clipboard operations
    project/          project settings and document navigation

  modes/
    sprites/
    tiles/
    maps/
```

`index.html` ultimately becomes a minimal shell containing the header, named
workbench regions, status bar, and dialog portal. Feature-owned markup and
listeners move beside their controllers.

## Host and Extension Contracts

Contracts use JSDoc types plus runtime validation at registration boundaries.

- `EditorHost` owns service instances, lifecycle, active mode, focus, and all
  contribution registries.
- `ModeDefinition` supplies identity, supported document kinds, a default
  view, and a `register(api)` hook.
- Contributions are tagged with their owning mode. Switching modes reconciles
  visible views, panels, tools, menus, shortcuts, and status contributions.
- Mounted contributions return a disposable handle. Mode deactivation aborts
  its subscriptions and global listeners.
- Context keys for the active mode, document kind, view, focus, and selection
  capabilities replace direct mode-name checks in shared code.

```js
ModeDefinition = {
  id, label, order,
  documentKinds,
  defaultViewId,
  register(api),
  activate(context)
}

DocumentProvider = {
  kind,
  list(project),
  get(project, id),
  create(project, input),
  rename(document, name),
  remove(project, id)
}

PanelDefinition = {
  id, title, region, order,
  when(contextKeys),
  create(container, context)
}

ViewDefinition = {
  id,
  when(contextKeys),
  create(container, context)
}

ToolDefinition = {
  id, label, shortcut,
  when(contextKeys),
  createController(context)
}

CommandDefinition = {
  id, label, shortcut,
  when(contextKeys),
  isEnabled(context),
  isChecked(context),
  execute(context, args)
}
```

A document is represented uniformly as `{ kind, id }`. This replaces parallel
sheet/map paths. Selections are stored per document so switching cannot leave
stale frame, tile, animation, or map-item selections.

UI commands and undo history remain separate concepts. The command service
owns invocation and presentation state. The history service owns undoable
project mutations and dirty-state propagation. Selection, focus, active tool,
and viewport changes remain outside undo history.

## State, Components, and Workbench

State is separated by lifetime:

- Project state: persisted model plus dirty state.
- Session state: active mode/document/view/tool and per-document selections.
- Interaction state: floating selection, previews, drag state, and playhead.
- Workspace preferences: panel visibility, sizes, collapsed state, and order,
  persisted locally rather than in project files.

`EditorStore` exposes selectors, transactions, and abortable subscriptions.
Domain objects can remain mutable, but project mutations flow through
application services or history commands instead of DOM handlers.

The fixed workbench regions are left tools/colors, center active editor, right
layers/context/assets/preview, and a bottom mode-contributed dock. Common
panels consume capability adapters rather than inspecting mode names. Canvas
views compose a shared viewport with mode-provided render layers and pointer
controllers. Focus and shortcuts are routed centrally.

## Migration Sequence

1. Add application services, host contracts, lifecycle utilities, and
   registries beside the existing application. Retain compatibility facades.
2. Move bootstrap, project lifecycle, file handling, dialogs, and command
   routing out of `main.js`; establish the workbench shell and preferences.
3. Extract Maps as the first complete mode and prove a test mode can be added
   without editing host code.
4. Extract shared canvas, layers, colors, preview, document navigation,
   selection, and transforms behind capability interfaces.
5. Extract Sprite mode, including frames, animations, timeline, tools, and
   frame editor.
6. Split Tile mode into tile, grid, terrain/autotile, tool, and editor
   contributions rather than moving the large legacy module intact.
7. Split `model.js` into bounded domain modules while retaining temporary
   re-export files.
8. Remove global-state imports, cross-mode imports, compatibility facades, and
   obsolete branches; enforce dependency boundaries.
9. Apply the light workbench redesign after ownership is stable.

Every phase leaves the application runnable and testable. There is no
repository-wide rename or big-bang rewrite.

## Testing

- Unit-test registration, duplicate IDs, context gating, disposal, and mode
  activation rollback.
- Verify per-document selections and mode/document switching.
- Test panel preference restoration and corrupt-data fallback.
- Test shared layer and preview adapters for each mode.
- Test command routing independently from history and dirty propagation.
- Register a minimal fake mode without changing host code.
- Preserve existing domain tests through compatibility exports.
- Preserve project-v3 packed and unpacked round trips.
- Browser-smoke test all modes, contextual panels, shortcuts, undo, and save.

## Assumptions

- PixelArtist remains a vanilla browser application with no build step.
- Only internally shipped modes are loaded initially.
- Existing project files and user data remain compatible.
- Behavior is preserved first, followed by a light workbench redesign.
- Workspace layout is local per browser/user.
- Existing canvas rendering and pure pixel/domain algorithms remain in use.
