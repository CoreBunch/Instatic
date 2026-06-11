import { useState, type MouseEvent, type ReactNode, type SyntheticEvent } from "react";
import { createPortal } from "react-dom";
import { registry } from "@core/module-engine";
import type { VisualComponent } from "@core/visualComponents";
import type { SavedLayout } from "@core/layouts";
import { useInsertModule } from "@site/hooks/useInsertModule";
import { useInsertPreset } from "@site/hooks/useInsertPreset";
import {
  DEFAULT_MODULE_INSERTER_FAVORITES,
  buildModuleInserterItems,
  recentKey,
  recentRefForItem,
  resolveInserterRefs,
  type ModuleInserterItem,
} from "@site/module-picker/moduleInserterModel";
import { LAYOUT_PRESETS } from "@site/module-picker";
import { useModuleInserterPreference } from "@site/module-picker/useModuleInserterPreference";
import { useModuleInsertionContext } from "@site/module-picker/useModuleInsertionContext";
import { resolveInsertLocation } from "@site/store/insertLocation";
import { selectActiveCanvasPage, useEditorStore } from "@site/store/store";
import { ModulePickerDropdown } from "@site/toolbar/ModulePickerDropdown";
import { ModuleIcon } from "@site/ui/ModuleIcon";
import type { IconComponent } from "pixel-art-icons/types";
import { BracesIcon } from "pixel-art-icons/icons/braces";
import { LayoutSolidIcon } from "pixel-art-icons/icons/layout-solid";
import { ArrowLeftIcon } from "pixel-art-icons/icons/arrow-left";
import { ArrowRightIcon } from "pixel-art-icons/icons/arrow-right";
import { CloseIcon } from "pixel-art-icons/icons/close";
import { Button } from "@ui/components/Button";
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@ui/components/ContextMenu";
import { UndoRedoButtons } from "./UndoRedoButtons";
import { cn } from "@ui/cn";
import styles from "./CanvasNotch.module.css";

const ADD_TRIGGER_TEST_ID = "canvas-notch-add-btn";
const EMPTY_COMPONENTS: VisualComponent[] = [];
const EMPTY_SAVED_LAYOUTS: SavedLayout[] = [];

/**
 * Notch action — supplies either a `moduleId` (icon resolved through the
 * module registry via `ModuleIcon`) or a literal `icon` component. Module
 * actions should always pass `moduleId` so the icon stays in sync with the
 * module declaration; ad-hoc actions (e.g. content-document blocks) supply
 * `icon` directly.
 */
export type CanvasNotchAction = {
  id: string;
  label: string;
  onClick: () => void;
  /** Renders the action disabled, with this string as the tooltip. */
  disabledReason?: string;
} & (
  | { moduleId: string; icon?: never }
  | { icon: IconComponent; moduleId?: never }
);

interface CanvasNotchProps {
  actions?: CanvasNotchAction[];
  /**
   * Replaces the default Site-editor module picker. Leave undefined to show
   * it; pass null when reusing the notch for a non-site canvas.
   */
  addControl?: ReactNode;
  floatingControl?: ReactNode;
  /**
   * Show the Undo/Redo group on the left side of the notch.
   * Defaults to true. Disable for canvases that don't drive the editor
   * page tree (e.g. the content document canvas, which has its own
   * draft-management lifecycle).
   */
  showHistoryControls?: boolean;
  /**
   * Auto-hide the notch until hovered/focused, rolling it down from the top
   * edge on demand. Used in live mode, where the frame sits flush against the
   * top of the surface and a permanently-pinned notch would overlay the
   * page's own header. A slim handle stays visible as the hover affordance.
   * Defaults to false (the notch is always pinned, as in design mode).
   */
  peek?: boolean;
}

export function CanvasNotch({
  actions,
  addControl,
  floatingControl,
  showHistoryControls = true,
  peek = false,
}: CanvasNotchProps = {}) {
  return (
    <div
      className={cn(styles.shell, peek && styles.shellPeek)}
      aria-label="Insert modules"
      data-testid="canvas-notch"
      onClick={stopCanvasInteraction}
    >
      {peek && <div aria-hidden="true" className={styles.peekHandle} />}
      <div className={styles.roller}>
        <div className={styles.notch}>
          {showHistoryControls && (
            <>
              <UndoRedoButtons />
              <div aria-hidden="true" className={styles.divider} />
            </>
          )}

          {actions
            ? actions.map((action) => renderActionButton(action))
            : <FavoriteNotchActions />}

          {addControl === undefined ? (
            <ModulePickerDropdown
              triggerClassName={styles.addButton}
              triggerTestId={ADD_TRIGGER_TEST_ID}
            />
          ) : addControl}
        </div>
        {floatingControl && (
          <div className={styles.floatingControl}>
            {floatingControl}
          </div>
        )}
      </div>
    </div>
  );
}

function stopCanvasInteraction(event: SyntheticEvent) {
  event.stopPropagation();
}

interface FavoriteMenuState {
  x: number;
  y: number;
  item: ModuleInserterItem;
}

function FavoriteNotchActions() {
  const insertModule = useInsertModule();
  const insertPreset = useInsertPreset();
  const { favorites, setFavorites, toggleFavorite } = useModuleInserterPreference();
  const insertionContext = useModuleInsertionContext();
  const visualComponents = useEditorStore((s) => s.site?.visualComponents ?? EMPTY_COMPONENTS);
  const savedLayouts = useEditorStore((s) => s.site?.layouts ?? EMPTY_SAVED_LAYOUTS);
  const insertLayout = useEditorStore((s) => s.insertLayout);
  const canvasPage = useEditorStore(selectActiveCanvasPage);
  const selectedNodeId = useEditorStore((s) => s.selectedNodeId);
  const insertComponentRef = useEditorStore((s) => s.insertComponentRef);
  const [menu, setMenu] = useState<FavoriteMenuState | null>(null);

  const { allItems } = buildModuleInserterItems({
    modules: registry.list(),
    context: insertionContext,
    layoutPresets: LAYOUT_PRESETS,
    savedLayouts,
    visualComponents,
  });
  const resolvedFavorites = resolveInserterRefs(favorites, allItems);
  const favoriteItems =
    favorites.length > 0 && resolvedFavorites.length === 0
      ? resolveInserterRefs(DEFAULT_MODULE_INSERTER_FAVORITES, allItems)
      : resolvedFavorites;

  function insertComponent(componentId: string) {
    if (!canvasPage) return;
    const location = resolveInsertLocation(
      canvasPage,
      selectedNodeId ?? canvasPage.rootNodeId,
    );
    if (!location) return;
    insertComponentRef(location.parentId, componentId, location.index);
  }

  // Reorder a favorite by swapping it with its visible neighbour. The swap
  // runs on the raw `favorites` ref array (keyed by item) so any favorites
  // that don't resolve against the current registry stay pinned in place.
  function moveFavorite(item: ModuleInserterItem, direction: "left" | "right") {
    const visibleIndex = favoriteItems.findIndex((fav) => fav.key === item.key);
    const neighbor = favoriteItems[visibleIndex + (direction === "left" ? -1 : 1)];
    if (!neighbor) return;
    const next = [...favorites];
    const from = next.findIndex((ref) => recentKey(ref) === item.key);
    const to = next.findIndex((ref) => recentKey(ref) === neighbor.key);
    if (from === -1 || to === -1) return;
    [next[from], next[to]] = [next[to], next[from]];
    setFavorites(next);
  }

  function undockFavorite(item: ModuleInserterItem) {
    toggleFavorite(recentRefForItem(item));
  }

  const menuIndex = menu
    ? favoriteItems.findIndex((fav) => fav.key === menu.item.key)
    : -1;
  const canMoveLeft = menuIndex > 0;
  const canMoveRight = menuIndex >= 0 && menuIndex < favoriteItems.length - 1;

  return (
    <>
      {favoriteItems.map((item) => {
        const action = actionForItem(item, {
          insertModule,
          insertPreset,
          insertComponent,
          insertLayout,
        });
        if (!action) return null;
        return renderActionButton(action, {
          onContextMenu: (event) => {
            event.preventDefault();
            setMenu({ x: event.clientX, y: event.clientY, item });
          },
        });
      })}
      {menu &&
        createPortal(
          <ContextMenu
            x={menu.x}
            y={menu.y}
            ariaLabel={`${menu.item.name} favorite options`}
            animateExit
            onClose={() => setMenu(null)}
          >
            <ContextMenuItem
              disabled={!canMoveLeft}
              onClick={() => {
                moveFavorite(menu.item, "left");
                setMenu(null);
              }}
            >
              <span aria-hidden="true">
                <ArrowLeftIcon size={13} />
              </span>
              Move left
            </ContextMenuItem>
            <ContextMenuItem
              disabled={!canMoveRight}
              onClick={() => {
                moveFavorite(menu.item, "right");
                setMenu(null);
              }}
            >
              <span aria-hidden="true">
                <ArrowRightIcon size={13} />
              </span>
              Move right
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
              danger
              onClick={() => {
                undockFavorite(menu.item);
                setMenu(null);
              }}
            >
              <span aria-hidden="true">
                <CloseIcon size={13} />
              </span>
              Undock
            </ContextMenuItem>
          </ContextMenu>,
          document.body,
        )}
    </>
  );
}

function actionForItem(
  item: ModuleInserterItem,
  handlers: {
    insertModule: ReturnType<typeof useInsertModule>;
    insertPreset: ReturnType<typeof useInsertPreset>;
    insertComponent: (componentId: string) => void;
    insertLayout: (layoutId: string) => string | null;
  },
): CanvasNotchAction | null {
  if (item.kind === "module") {
    return {
      id: item.key,
      label: item.name,
      moduleId: item.id,
      onClick: () => handlers.insertModule(item.module),
      disabledReason: item.disabledReason,
    };
  }
  if (item.kind === "layout") {
    return {
      id: item.key,
      label: item.name,
      icon: LayoutSolidIcon,
      onClick: () => handlers.insertPreset(item.preset),
    };
  }
  if (item.kind === "savedLayout") {
    return {
      id: item.key,
      label: item.name,
      icon: LayoutSolidIcon,
      onClick: () => handlers.insertLayout(item.id),
      disabledReason: item.disabledReason,
    };
  }
  if (item.kind === "component") {
    return {
      id: item.key,
      label: item.name,
      icon: BracesIcon,
      onClick: () => handlers.insertComponent(item.id),
    };
  }
  return null;
}

function renderActionButton(
  action: CanvasNotchAction,
  options?: { onContextMenu?: (event: MouseEvent<HTMLButtonElement>) => void },
) {
  const ActionIcon = action.icon;
  return (
    <Button
      key={action.id}
      variant="ghost"
      size="sm"
      iconOnly
      className={styles.quickButton}
      onClick={action.onClick}
      onContextMenu={options?.onContextMenu}
      disabled={Boolean(action.disabledReason)}
      aria-label={`Add ${action.label}`}
      tooltip={action.disabledReason ?? `Add ${action.label}`}
      data-testid={`canvas-notch-${testIdPart(action.label)}-btn`}
    >
      {ActionIcon ? (
        <ActionIcon size={14} aria-hidden="true" />
      ) : (
        <ModuleIcon
          moduleId={action.moduleId}
          size={14}
          aria-hidden="true"
        />
      )}
    </Button>
  );
}

function testIdPart(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
