// ==UserScript==
// @name           Zen Tree Tabs
// @description    Sidebery-style tree tabs for Zen: nesting, collapsing, drag & drop with depth, splits and pinned tabs.
// @ignorecache
// ==/UserScript==

(async function ZenTreeTabs() {
  // A reload replaces the previous instance in this window.
  window.ZenTreeTabs?.destroy();

  await UC_API.Windows.waitWindowLoading(window);
  if (!window.gZenWorkspaces) {
    return; // Not a Zen browser window (or Zen internals changed).
  }
  await gZenWorkspaces.promiseInitialized;

  const { SessionStore } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs"
  );

  const SCRIPT_URL = "chrome://userscripts/content/zen-tree-tabs.uc.js"; // <profile>/chrome/JS
  // Both under <profile>/chrome (symlinks into the project).
  const SCRIPT_FILE = ["JS", "zen-tree-tabs.uc.js"];
  const STYLE_FILE = ["resources", "zen-tree-tabs.css"];
  const chromeFile = parts => {
    const file = Services.dirsvc.get("UChrm", Ci.nsIFile);
    for (const part of parts) {
      file.append(part);
    }
    return file;
  };

  // Same step Zen uses for folder indentation (ZenFolders.mjs, baseSpacing).
  const INDENT_PX = 14;
  // Sideways pointer travel during a drag that changes the drop level by one.
  // Equal to the indent, so the level follows the drag image: where the
  // dragged tab is drawn horizontally is the level it lands at.
  const DRAG_LEVEL_PX = INDENT_PX;

  // Tree state lives in tab attributes (the source of truth while running)
  // and is mirrored into SessionStore so it survives restarts and "undo close
  // tab". The mirror is re-synced on every render because SessionStore can
  // drop values that were set on tabs that hadn't been restored yet.
  const ATTR_ID = "ztt-id";
  const ATTR_PARENT = "ztt-parent";
  const ATTR_COLLAPSED = "ztt-collapsed";
  const ATTR_HAS_CHILDREN = "ztt-has-children";
  const ATTR_HIDDEN = "ztt-hidden";
  const ATTR_DROP_PARENT = "ztt-drop-parent";
  const ATTR_NESTED = "ztt-nested";
  const ATTR_INDENTED = "ztt-indented"; // We own this element's --zen-folder-indent.
  const PERSISTED = [ATTR_ID, ATTR_PARENT, ATTR_COLLAPSED];

  const pref = (name, fallback) => Services.prefs.getBoolPref(`zen-tree-tabs.${name}`, fallback);
  // Read on every call, so flipping the pref takes effect immediately.
  const log = (...args) => pref("debug", false) && console.log("[zen-tree-tabs]", ...args);

  const lifetime = new AbortController();
  const { signal } = lifetime;
  const listen = (target, type, handler, capture = false) =>
    target.addEventListener(type, handler, { capture, signal });

  const bounds = el => window.windowUtils.getBoundsWithoutFlushing(el);

  // ── State helpers ──────────────────────────────────────────────────────

  // A tab's saved values (SessionStore) are the truth until we've read them
  // onto the tab ("claimed" it); only then do our attributes get written back.
  // Restored tabs get their saved values from Firefox *after* they're created
  // (and TabOpen has fired), so writing earlier would overwrite the real tree
  // with fresh ids and no parents.
  const claimed = new WeakSet();

  function savedValue(tab, attr) {
    try {
      return SessionStore.getCustomTabValue(tab, attr) ?? "";
    } catch (e) {
      return "";
    }
  }

  // Read saved values onto the tab (saved wins), then own it.
  function claim(tab, { force = false } = {}) {
    if (claimed.has(tab) && !force) {
      return;
    }
    for (const attr of PERSISTED) {
      const value = savedValue(tab, attr);
      if (value) {
        tab.setAttribute(attr, value);
      }
    }
    claimed.add(tab);
    ensureId(tab);
  }

  function setState(tab, attr, value) {
    claim(tab); // Never let a write happen before the saved values are in.
    if (value) {
      tab.setAttribute(attr, value);
    } else {
      tab.removeAttribute(attr);
    }
    persist(tab, attr);
  }

  function persist(tab, attr) {
    if (!claimed.has(tab)) {
      return;
    }
    const value = tab.getAttribute(attr) ?? "";
    try {
      if ((SessionStore.getCustomTabValue(tab, attr) ?? "") === value) {
        return;
      }
      if (value) {
        SessionStore.setCustomTabValue(tab, attr, value);
      } else {
        SessionStore.deleteCustomTabValue(tab, attr);
      }
    } catch (e) {
      log("persist failed", attr, e);
    }
  }

  function ensureId(tab) {
    if (!tab.hasAttribute(ATTR_ID)) {
      tab.setAttribute(ATTR_ID, Services.uuid.generateUUID().toString().slice(1, -1));
      persist(tab, ATTR_ID);
    }
    return tab.getAttribute(ATTR_ID);
  }

  // ── Nodes ──────────────────────────────────────────────────────────────
  //
  // The tree is made of nodes: a plain tab, or a split view (Zen's
  // split-view tab group, shown as one row) as a whole. A node's state lives
  // on its tabs: they all carry the same parent/collapsed values, and any of
  // their ids can be a child's parent id, so a split keeps its children when
  // one of its tabs leaves or the split dissolves.

  const isSplit = el => !!el?.hasAttribute?.("split-view-group");
  const splitOf = tab => (isSplit(tab?.group) ? tab.group : null);
  const nodeOf = tab => splitOf(tab) ?? tab;
  const tabsOf = node => (isSplit(node) ? node.tabs : [node]);
  const leadTab = node => tabsOf(node)[0];
  // Every tab of every space. gBrowser.tabs only has the *active* space's
  // tabs (Zen keeps the others in their own space containers), but the tree
  // lives in all spaces. Within a container this is DOM (= tab) order.
  function allTabs() {
    const spaces = document.querySelectorAll("zen-workspace");
    if (!spaces.length) {
      return gBrowser.tabs;
    }
    const tabs = [];
    const collect = container => {
      for (const el of container?.children ?? []) {
        if (gBrowser.isTab(el)) {
          tabs.push(el);
        } else if (gBrowser.isTabGroup(el)) {
          tabs.push(...el.tabs);
        }
      }
    };
    for (const space of spaces) {
      collect(space.pinnedTabsContainer);
      collect(space.tabsContainer);
    }
    return tabs;
  }

  const firstIndex = node => allTabs().indexOf(leadTab(node));
  const lastIndex = node => allTabs().indexOf(tabsOf(node).at(-1));

  // Pinned and normal tabs take part (each section of a space is its own
  // tree): plain tabs, or splits that aren't inside a Zen folder. Folders and
  // Essentials stay Zen's.
  function isTreeTab(tab) {
    return (
      !!tab &&
      !tab.closing &&
      (!tab.group || (isSplit(tab.group) && !tab.group.group)) &&
      !tab.hasAttribute("zen-essential") &&
      !tab.hasAttribute("zen-glance-tab") &&
      !tab.hasAttribute("zen-empty-tab")
    );
  }

  const isTreeNode = node => !!node && tabsOf(node).some(isTreeTab);

  function spaceOf(el) {
    return leadTab(el)?.getAttribute("zen-workspace-id") ?? "";
  }

  // Each space has two separate trees: pinned tabs and normal tabs.
  function sectionOf(el) {
    return `${spaceOf(el)}${leadTab(el)?.pinned ? "|pinned" : ""}`;
  }

  // Tree nodes in tab order (optionally one section, minus some).
  function treeNodes(section = null, exclude = new Set()) {
    const nodes = [];
    for (const tab of allTabs()) {
      if (!isTreeTab(tab)) {
        continue;
      }
      const node = nodeOf(tab);
      if (nodes.at(-1) !== node && !exclude.has(node) && (section === null || sectionOf(node) === section)) {
        nodes.push(node);
      }
    }
    return nodes;
  }

  const nodeId = node => ensureId(leadTab(node));
  const nodeHasId = (node, id) => !!id && tabsOf(node).some(t => t.getAttribute(ATTR_ID) === id);

  // id -> node, for every tab id.
  function idMap() {
    return new Map(allTabs().map(t => [t.getAttribute(ATTR_ID), nodeOf(t)]));
  }

  // A node's parent id: the first one among its tabs that isn't the node
  // itself (a split made from a parent and its child would otherwise loop).
  function parentIdOf(node) {
    for (const tab of tabsOf(node)) {
      const id = tab.getAttribute(ATTR_PARENT);
      if (id && !nodeHasId(node, id)) {
        return id;
      }
    }
    return null;
  }

  const isCollapsed = node => tabsOf(node).some(t => t.hasAttribute(ATTR_COLLAPSED));

  function setNodeState(node, attr, value) {
    for (const tab of tabsOf(node)) {
      setState(tab, attr, value);
    }
  }

  function childrenOf(node) {
    return treeNodes().filter(n => n !== node && nodeHasId(node, parentIdOf(n)));
  }

  function isDescendantOf(node, ancestor, ids = idMap()) {
    const seen = new Set();
    let current = node;
    while (current && !seen.has(current)) {
      seen.add(current);
      const parentId = parentIdOf(current);
      if (!parentId) {
        return false;
      }
      if (nodeHasId(ancestor, parentId)) {
        return true;
      }
      current = ids.get(parentId);
    }
    return false;
  }

  // All descendant nodes by parent links, in tab order.
  function descendantsOf(node) {
    const ids = idMap();
    return treeNodes().filter(n => n !== node && isDescendantOf(n, node, ids));
  }

  function nodeById(id) {
    return id ? idMap().get(id) ?? null : null;
  }

  // Run tab moves we initiate without them looking like foreign moves.
  let selfMoving = 0;
  function moveOurselves(fn) {
    selfMoving++;
    try {
      fn();
    } finally {
      selfMoving--;
    }
  }

  // ── Rendering ──────────────────────────────────────────────────────────
  //
  // Pure function of tab order + parent ids: walk each space's nodes in order
  // with a stack of open ancestors. A node is only nested if its parent is on
  // the stack, i.e. the parent sits directly above its subtree. Rendering
  // never rewrites parent ids, so a transient reorder can't destroy the tree.
  //
  // Visuals go on the node's element (the tab, or the split's group, which
  // Zen indents by the same --zen-folder-indent). The twisty and badge go on
  // the node's first tab.

  const rendered = new WeakMap(); // node -> { depth, parent }
  const depthOf = node => (node ? rendered.get(node)?.depth ?? 0 : 0);
  const hiddenCounts = new Map(); // collapsed node -> hidden descendants (per render)

  function render() {
    if (!ready) {
      return; // Nothing is claimed before the session restore is done.
    }
    const stacks = new Map(); // section -> ancestor stack
    const treeTabs = new Set();
    for (const node of treeNodes()) {
      for (const tab of tabsOf(node)) {
        treeTabs.add(tab);
        claim(tab);
      }
      syncNodeState(node);
      const section = sectionOf(node);
      let stack = stacks.get(section);
      if (!stack) {
        stacks.set(section, (stack = []));
      }
      const parentId = parentIdOf(node);
      if (!parentId) {
        stack.length = 0;
      }
      while (stack.length && !nodeHasId(stack.at(-1), parentId)) {
        stack.pop();
      }
      const depth = stack.length;
      const parent = stack.at(-1) ?? null;
      const hidden = stack.some(isCollapsed);
      rendered.set(node, { depth, parent });

      if (depth) {
        node.style.setProperty("--zen-folder-indent", `${depth * INDENT_PX}px`);
        node.style.setProperty("--ztt-depth", depth);
        node.setAttribute(ATTR_INDENTED, "true");
        leadTab(parent).setAttribute(ATTR_HAS_CHILDREN, "true");
      } else {
        clearVisuals(node);
      }
      node.toggleAttribute(ATTR_NESTED, depth > 0);
      node.toggleAttribute(ATTR_HIDDEN, hidden);
      leadTab(node).removeAttribute(ATTR_HAS_CHILDREN); // Re-set by its first child, if any.
      for (const tab of tabsOf(node)) {
        if (isSplit(node)) {
          clearVisuals(tab); // The group carries indent, guides and hiding.
        }
        ensureTwisty(tab);
      }
      for (const ancestor of stack) {
        if (isCollapsed(ancestor)) {
          hiddenCounts.set(ancestor, (hiddenCounts.get(ancestor) ?? 0) + 1);
        }
      }
      stack.push(node);
    }
    for (const tab of allTabs()) {
      if (!treeTabs.has(tab)) {
        clearRender(tab);
      }
      const badge = tab.querySelector(".ztt-count");
      if (badge) {
        const node = nodeOf(tab);
        badge.value = leadTab(node) === tab ? hiddenCounts.get(node) ?? "" : "";
      }
    }
    for (const group of gBrowser.tabGroups) {
      if (!isSplit(group) || !isTreeNode(group)) {
        clearVisuals(group); // E.g. a split that moved into a folder.
      }
    }
    hiddenCounts.clear();
  }

  // All tabs of a node share its parent and collapsed state, and stay in
  // SessionStore. (Tabs that just joined a split pick the split's state up.)
  function syncNodeState(node) {
    const parentId = parentIdOf(node);
    const collapsed = isCollapsed(node) ? "true" : null;
    for (const tab of tabsOf(node)) {
      if ((tab.getAttribute(ATTR_PARENT) ?? null) !== parentId) {
        setState(tab, ATTR_PARENT, parentId);
      }
      if ((tab.getAttribute(ATTR_COLLAPSED) ?? null) !== collapsed) {
        setState(tab, ATTR_COLLAPSED, collapsed);
      }
      for (const attr of PERSISTED) {
        persist(tab, attr);
      }
    }
  }

  // Only undoes what we set: Zen indents its own folders with the same
  // property, and those must be left alone.
  function clearVisuals(el) {
    if (el.hasAttribute(ATTR_INDENTED)) {
      el.style.removeProperty("--zen-folder-indent");
      el.removeAttribute(ATTR_INDENTED);
    }
    el.style.removeProperty("--ztt-depth");
    el.removeAttribute(ATTR_NESTED);
    el.removeAttribute(ATTR_HIDDEN);
  }

  function clearRender(tab) {
    clearVisuals(tab);
    tab.removeAttribute(ATTR_HAS_CHILDREN);
    rendered.delete(tab);
  }

  let renderQueued = false;
  function scheduleRender() {
    if (!renderQueued) {
      renderQueued = true;
      requestAnimationFrame(() => {
        renderQueued = false;
        if (!signal.aborted) {
          render();
        }
      });
    }
  }

  // The twisty and the hidden-count badge sit in the favicon's stack, on top
  // of the icon, so they never take horizontal space: only depth moves a tab.
  function ensureTwisty(tab) {
    const stack = tab.querySelector(".tab-icon-stack");
    if (!stack || stack.querySelector(".ztt-twisty")) {
      return;
    }
    const twisty = document.createXULElement("image");
    twisty.className = "ztt-twisty";
    const badge = document.createXULElement("label");
    badge.className = "ztt-count";
    stack.append(twisty, badge);
  }

  function toggleCollapsed(node, collapsed = !isCollapsed(node)) {
    setNodeState(node, ATTR_COLLAPSED, collapsed ? "true" : null);
    if (collapsed && isDescendantOf(nodeOf(gBrowser.selectedTab), node)) {
      gBrowser.selectedTab = leadTab(node); // Don't leave focus on a tab we just hid.
    }
    scheduleRender();
  }

  // ── Placement ──────────────────────────────────────────────────────────
  //
  // A slot is a gap between two tree nodes. Valid depths for a node put there
  // run from `minDepth` (shallower would cut `next` off from its parent) to
  // `maxDepth` (child of `prev`). Collapsed nodes can't be dropped into.

  function depthRange(prev, next) {
    const prevCollapsed = prev && isCollapsed(prev) && leadTab(prev).hasAttribute(ATTR_HAS_CHILDREN);
    const maxDepth = prev ? depthOf(prev) + (prevCollapsed ? 0 : 1) : 0;
    const minDepth = next ? Math.min(depthOf(next), maxDepth) : 0;
    return { minDepth, maxDepth };
  }

  // The node a node at `depth` hangs under, walking up from `prev`.
  function parentAt(prev, depth) {
    let parent = prev;
    while (parent && depthOf(parent) > depth - 1) {
      parent = rendered.get(parent)?.parent ?? null;
    }
    return depth > 0 ? parent : null;
  }

  // The tree nodes right before/after `node`'s position, ignoring `exclude`.
  function neighbours(node, exclude) {
    const nodes = treeNodes(sectionOf(node), exclude);
    const first = firstIndex(node);
    const last = lastIndex(node);
    return {
      prev: nodes.findLast(n => lastIndex(n) < first) ?? null,
      next: nodes.find(n => firstIndex(n) > last) ?? null,
    };
  }

  // Something other than us moved `node` (Zen, keyboard shortcut, a drop we
  // didn't preview). Keep its parent if that's still valid there, otherwise
  // adopt the natural level of the slot, and bring its subtree along.
  function repair(node, subtree = descendantsOf(node)) {
    const carried = new Set([node, ...subtree]);
    const { prev, next } = neighbours(node, carried);
    const { minDepth, maxDepth } = depthRange(prev, next);
    const parent = nodeById(parentIdOf(node));
    const parentDepth = parent ? depthOf(parent) + 1 : 0;
    const parentStillAbove = !parent || prev === parent || chainOf(prev).includes(parent);
    if (!parentStillAbove || parentDepth < minDepth || parentDepth > maxDepth) {
      const newParent = parentAt(prev, minDepth);
      setNodeState(node, ATTR_PARENT, newParent ? nodeId(newParent) : null);
      log("repair", { minDepth, maxDepth });
    }
    carrySubtree(node, subtree);
    scheduleRender();
  }

  // Pin or unpin nodes. For a split, Zen pins/unpins the whole split when its
  // first tab is, keeping it together.
  function setPinned(nodes, pinned) {
    for (const node of nodes) {
      const lead = leadTab(node);
      if (lead.pinned !== pinned) {
        pinned ? gBrowser.pinTab(lead) : gBrowser.unpinTab(lead);
      }
    }
  }

  // Put `subtree` right after `node`, in node's section (pinning/unpinning
  // descendants that are on the other side), keeping its shape.
  function carrySubtree(node, subtree) {
    const items = subtree.filter(n => n !== node && isTreeNode(n) && spaceOf(n) === spaceOf(node));
    const pinned = leadTab(node).pinned;
    if (items.some(n => leadTab(n).pinned !== pinned)) {
      moveOurselves(() => setPinned(items, pinned));
    }
    let expected = lastIndex(node) + 1;
    const inPlace = items.every(n => {
      const ok = firstIndex(n) === expected;
      expected = lastIndex(n) + 1;
      return ok;
    });
    if (items.length && !inPlace) {
      moveOurselves(() => gBrowser.moveTabsAfter(items, node));
    }
  }

  function chainOf(node) {
    const chain = [];
    for (let n = node && rendered.get(node)?.parent; n; n = rendered.get(n)?.parent) {
      chain.push(n);
    }
    return chain;
  }

  // ── Closing ────────────────────────────────────────────────────────────

  // A tab is closing (or leaving the tree). If its node lives on (a split
  // with other tabs), children re-link to a remaining tab. Otherwise they
  // move up one level: adopted by its parent (or become roots), keeping
  // their own subtrees.
  function onTabLeaving(tab) {
    const node = nodeOf(tab);
    const children = childrenOf(node).filter(child => tabsOf(child).some(t =>
      t.getAttribute(ATTR_PARENT) === tab.getAttribute(ATTR_ID)
    ));
    if (!children.length) {
      return;
    }
    const remaining = tabsOf(node).filter(t => t !== tab && !t.closing);
    const newParentId = remaining.length ? ensureId(remaining[0]) : parentIdOf(node);
    for (const child of children) {
      setNodeState(child, ATTR_PARENT, newParentId);
    }
  }

  // ── Dragging ───────────────────────────────────────────────────────────
  //
  // While a tree tab is dragged over the normal tabs, we own the preview: the
  // gap comes from the pointer's height (upper/lower half of the tab under
  // it), the level from how far the pointer moved sideways since pickup, and
  // we draw our own drop line there (Zen's is hidden meanwhile). Nothing here
  // depends on Zen's drag timing, so the level can be picked however the
  // pointer got there. On drop we place the tab (and its subtree) exactly
  // where the preview showed, after Zen's own drop is done.
  //
  // Zen's drag-onto-a-tab split view still works: hovering the middle of a
  // tab for a moment shows Zen's split preview, and while it's up we step
  // aside so the drop makes a split. Between tabs, the tree preview applies.
  // (Set zen-tree-tabs.block-tab-split to switch drag-to-split off during
  // tree drags instead.)

  const SPLIT_PREF = "zen.splitView.enable-drag-over-split";
  let splitDefault = null; // Original default while we've overridden it.

  function suppressTabSplit() {
    if (
      splitDefault !== null ||
      !pref("block-tab-split", false) ||
      Services.prefs.prefHasUserValue(SPLIT_PREF)
    ) {
      return;
    }
    const defaults = Services.prefs.getDefaultBranch("");
    splitDefault = defaults.getBoolPref(SPLIT_PREF, true);
    defaults.setBoolPref(SPLIT_PREF, false); // Default branch: never saved to disk.
  }

  function restoreTabSplit() {
    if (splitDefault !== null) {
      Services.prefs.getDefaultBranch("").setBoolPref(SPLIT_PREF, splitDefault);
      splitDefault = null;
    }
  }

  let drag = null; // State of the current tree-tab drag, if any.
  let pendingDrop = false;
  // Set once the session is restored and the first render is done. Before
  // that, tab events come from Zen/Firefox rebuilding the session, not from
  // you, and must not rewrite the tree.
  let ready = false;

  // Moves, pins and folder changes only rewrite the tree when they follow
  // your own input (click, key, menu, drop); Zen also moves/pins tabs on its
  // own (startup, sync, space changes), and those must leave the tree alone.
  let lastInput = 0;
  const byUser = () => ready && Date.now() - lastInput < 1500;

  const TAB_DROP_TYPE = "application/x-moz-tabbrowser-tab";

  // Why a tab can't be tree-dragged, for the debug log.
  function notTreeReason(tab) {
    if (!tab) return "no tab found";
    if (tab.closing) return "closing";
    if (tab.group && !(isSplit(tab.group) && !tab.group.group)) return "in a group/folder";
    if (tab.hasAttribute("zen-essential")) return "essential";
    if (tab.hasAttribute("zen-glance-tab")) return "glance";
    if (tab.hasAttribute("zen-empty-tab")) return "empty tab";
    return null;
  }

  // The drag can start on the tab's title text (a text node), inside a
  // shadow root, on a split's frame, etc., so search the whole event path for
  // the first tab or split.
  function tabFromEvent(event) {
    const hit = event.composedPath?.().find(n => n.classList?.contains("tabbrowser-tab") || isSplit(n));
    return isSplit(hit) ? leadTab(hit) : hit ?? null;
  }

  function on_dragstart(event) {
    endPreview();
    drag = null;
    fallbackTried = null;
    beginDrag(tabFromEvent(event), event.screenX, "dragstart");
  }

  function beginDrag(tab, startX, source) {
    if (tab?.group && !gBrowser.isTab(tab)) {
      tab = leadTab(tab.group); // A split's label element, from the drag data.
    }
    const reason = notTreeReason(tab);
    const node = reason ? null : nodeOf(tab);
    // Several selected tabs are fine only if they're this one split.
    const strays = node ? gBrowser.selectedTabs.filter(t => nodeOf(t) !== node).length : 0;
    if (reason || strays) {
      log(`${source}: not a tree drag`, reason ?? `${gBrowser.selectedTabs.length} tabs selected`);
      return false;
    }
    const subtree = descendantsOf(node);
    const rect = bounds(node);
    const depth = depthOf(node);
    drag = {
      node,
      subtree,
      carried: new Set([node, ...subtree]),
      depth,
      // Left edge of a depth-0 tab and the strip's right edge.
      left: rect.left - depth * INDENT_PX,
      right: rect.right,
      startX,
      slot: null,
      pointer: null,
    };
    suppressTabSplit();
    log(`${source}: tree drag`, { depth, subtree: subtree.length });
    return true;
  }

  // Firefox records the dragged tab (and where the drag began) in the drag
  // data, so if dragstart was missed or ambiguous, pick the drag up here.
  let fallbackTried = null;
  function adoptDrag(event) {
    const tab = event.dataTransfer?.mozGetDataAt(TAB_DROP_TYPE, 0);
    if (!tab || tab === fallbackTried || tab.documentGlobal !== window) {
      return false;
    }
    fallbackTried = tab; // One attempt per drag, not one per dragover.
    return beginDrag(tab, tab._dragData?.screenX ?? event.screenX, "dragover");
  }

  function on_dragover(event) {
    if (!drag && !adoptDrag(event)) {
      return;
    }
    drag.pointer = { x: event.clientX, y: event.clientY, screenX: event.screenX, target: event.target };
    updatePreview();
    if (drag.slot) {
      // Make sure the drop happens even where Firefox wouldn't accept it
      // (e.g. right over the dragged tab), or the chosen level is lost.
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
    }
  }

  function updatePreview() {
    const space = gZenWorkspaces.activeWorkspaceElement;
    const p = drag.pointer;
    if (!p || !space?.tabsContainer || !space.pinnedTabsContainer) {
      return clearSlot("no pointer/space");
    }
    if (spaceOf(drag.node) !== gZenWorkspaces.activeWorkspace) {
      return clearSlot("other space");
    }
    if (document.querySelector("zen-split-fake-tab")) {
      return clearSlot("split preview"); // Zen will make a split on drop.
    }
    if (p.target?.closest?.("zen-folder")) {
      return clearSlot("over a folder"); // Dropping into folders is Zen's.
    }
    // Either tree of the space: the pinned tabs, or the normal tabs (plus the
    // empty space below them). Dropping into the other one pins/unpins the
    // tab and its subtree. Elsewhere (essentials, the page) Zen decides.
    const normalArea = bounds(space.tabsContainer);
    const pinnedArea = bounds(space.pinnedTabsContainer);
    if (p.x < normalArea.left - 8 || p.x > normalArea.right + 8) {
      return clearSlot("outside sidebar");
    }
    let pinned;
    if (pinnedArea.height && p.y >= pinnedArea.top - 6 && p.y < pinnedArea.bottom) {
      pinned = true;
    } else if (p.y >= Math.min(normalArea.top, pinnedArea.bottom) - 6 && p.y <= Math.max(normalArea.bottom, bounds(space).bottom)) {
      pinned = false;
    } else {
      return clearSlot("outside the tab lists");
    }
    const container = pinned ? space.pinnedTabsContainer : space.tabsContainer;
    const tabsArea = pinned ? pinnedArea : normalArea;
    const section = `${spaceOf(drag.node)}${pinned ? "|pinned" : ""}`;

    // The gap: before the first visible node whose middle is below the pointer.
    const visible = treeNodes(section, drag.carried).filter(
      n => !n.hasAttribute(ATTR_HIDDEN)
    );
    let prevVisible = null;
    let next = null;
    let lineY = tabsArea.top;
    for (const n of visible) {
      const r = bounds(n);
      if (r.top + r.height / 2 <= p.y) {
        prevVisible = n;
        lineY = r.top + r.height;
      } else {
        next = n;
        if (!prevVisible) {
          lineY = r.top;
        }
        break;
      }
    }
    // A Zen folder sitting in this gap (pinned tabs) belongs to Zen: our
    // line would be drawn on the wrong side of it.
    const gapTop = prevVisible ? bounds(prevVisible).bottom - 1 : -Infinity;
    const gapBottom = next ? bounds(next).top + 1 : Infinity;
    for (const folder of container.querySelectorAll("zen-folder")) {
      const r = bounds(folder);
      if (r.height && r.top >= gapTop && r.bottom <= gapBottom) {
        return clearSlot("beside a folder");
      }
    }
    // After a collapsed tab means after its hidden subtree.
    const hiddenTail = prevVisible && isCollapsed(prevVisible)
      ? descendantsOf(prevVisible).filter(n => !drag.carried.has(n)).at(-1)
      : null;
    const anchor = hiddenTail ?? prevVisible;
    if (!anchor && !next) {
      return clearSlot(pinned ? "no other pinned tabs" : "no other tabs");
    }

    const { minDepth, maxDepth } = depthRange(prevVisible, next);
    // Independent of the path the pointer took: only where it is now, relative
    // to where the tab was picked up, counts.
    const shift = Math.round((p.screenX - drag.startX) / DRAG_LEVEL_PX);
    const depth = Math.max(minDepth, Math.min(maxDepth, drag.depth + shift));
    const parent = parentAt(prevVisible, depth);
    const changed = drag.slot?.anchor !== anchor || drag.slot?.next !== next || drag.slot?.depth !== depth;
    drag.slot = { anchor, next, parent, depth, pinned };
    drag.clearReason = null;
    if (changed) {
      log("slot", { pinned, depth, minDepth, maxDepth, shift, parent: parent ? leadTab(parent).label : null });
    }

    const left = drag.left + depth * INDENT_PX;
    const line = dropLine();
    line.style.left = `${left + 6}px`;
    line.style.width = `${Math.max(drag.right - left - 10, 8)}px`;
    line.style.top = `${Math.round(lineY) - 1}px`;
    document.documentElement.setAttribute("ztt-tree-drop", "true");
    highlightParent(parent, space);
  }

  function dropLine() {
    let line = document.getElementById("ztt-drop-line");
    if (!line) {
      line = document.createElement("div");
      line.id = "ztt-drop-line";
      gNavToolbox.appendChild(line);
    }
    return line;
  }

  // Highlight the future parent tab, or for a top-level drop (no parent) the
  // header of the space the tab lands in. Called with no arguments to clear.
  function highlightParent(parent, space = null) {
    const target = parent ?? space?.indicator ?? null;
    for (const el of document.querySelectorAll(`[${ATTR_DROP_PARENT}]`)) {
      if (el !== target) {
        el.removeAttribute(ATTR_DROP_PARENT);
      }
    }
    target?.setAttribute(ATTR_DROP_PARENT, "true");
  }

  // No tree slot right now (pointer elsewhere): hand the visuals back to Zen.
  function clearSlot(reason) {
    if (drag) {
      if (reason && drag.clearReason !== reason) {
        log("no slot:", reason);
      }
      drag.clearReason = reason;
      drag.slot = null;
    }
    document.documentElement.removeAttribute("ztt-tree-drop");
    document.getElementById("ztt-drop-line")?.remove();
    highlightParent(null);
  }

  function endPreview() {
    clearSlot();
    restoreTabSplit();
  }

  function on_drop(event) {
    if (!drag) {
      return;
    }
    drag.pointer = { x: event.clientX, y: event.clientY, screenX: event.screenX, target: event.target };
    updatePreview();
    const { node, subtree, slot } = drag;
    drag = null;
    pendingDrop = true;
    endPreview();
    log("drop", slot ? { depth: slot.depth, parent: !!slot.parent } : "no slot");
    // Let Zen finish its own drop (move, space switch, split) first.
    setTimeout(() => {
      pendingDrop = false;
      applyDrop(node, subtree, slot);
    }, 0);
  }

  function on_dragend() {
    setTimeout(() => {
      drag = null;
      fallbackTried = null;
      endPreview();
    }, 0);
  }

  function applyDrop(dropped, subtree, slot) {
    // Zen may have changed what the dragged thing is (made a split, moved
    // it into a folder, pinned it), so work from its current node.
    const node = nodeOf(leadTab(dropped));
    if (!isTreeNode(node) || !node.isConnected) {
      return;
    }
    if (isSplit(node) && node !== dropped) {
      // Dropped onto a tab to make a split. The split sits where the target
      // tab was, so it takes the target's place in the tree, and the dragged
      // tab's children follow it there.
      const others = tabsOf(node).filter(t => !tabsOf(dropped).includes(t));
      const parentId = others.map(t => t.getAttribute(ATTR_PARENT)).find(id => id && !nodeHasId(node, id)) ?? null;
      setNodeState(node, ATTR_PARENT, parentId);
      log("split made", { parent: !!parentId });
      carrySubtree(node, descendantsOf(node));
      scheduleRender();
      return;
    }
    if (!slot || !slot.anchor?.isConnected && !slot.next?.isConnected) {
      repair(node, subtree); // Dropped somewhere we didn't preview.
      return;
    }
    const items = [node, ...subtree.filter(n => n !== node && isTreeNode(n) && spaceOf(n) === spaceOf(node))];
    moveOurselves(() => {
      setPinned(items, slot.pinned); // Before moving: Zen won't mix pinned and normal.
      if (slot.anchor) {
        gBrowser.moveTabsAfter(items, slot.anchor);
      } else {
        gBrowser.moveTabsBefore(items, slot.next);
      }
    });
    setNodeState(node, ATTR_PARENT, slot.parent ? nodeId(slot.parent) : null);
    scheduleRender();
  }

  // ── Events ─────────────────────────────────────────────────────────────

  const restoring = new WeakSet();
  const implicitChildren = new WeakSet();

  // Where tabs without an opener (Ctrl+T, the new-tab button) go, relative
  // to the tab that was active: "sibling" (right below it and its subtree, at
  // its level), "child" (its last child) or "end" (top level, Zen's default).
  function newTabPosition() {
    const value = Services.prefs.getStringPref("zen-tree-tabs.newtab-position", "");
    if (["sibling", "child", "end"].includes(value)) {
      return value;
    }
    return pref("newtab-as-child", true) ? "sibling" : "end"; // Older setting.
  }

  function on_TabOpen(event) {
    const tab = event.target;
    if (!ready) {
      return; // Session restore: the tab's saved values are its tree state.
    }
    if (event.detail?.fromExternal) {
      scheduleRender();
      return; // External links have no parent in this tab tree.
    }
    // Links (and window.open) have an opener: the new tab is its last child.
    // Otherwise, place it relative to the active tab per newTabPosition().
    let base = tab.openerTab;
    let mode = "child";
    if (!base) {
      mode = newTabPosition();
      base = mode === "end" ? null : gBrowser.selectedTab;
      if (base) {
        implicitChildren.add(tab);
      }
    }
    log("TabOpen", { opener: !!tab.openerTab, mode });
    if (!isTreeTab(tab) || !isTreeTab(base) || sectionOf(tab) !== sectionOf(base) || tab === base) {
      scheduleRender();
      return;
    }
    // A tab opened from inside a split relates to the whole split.
    const baseNode = nodeOf(base);
    const parentId = mode === "child" ? ensureId(base) : parentIdOf(baseNode);
    // Either way it goes right after the base's whole subtree: as its last
    // child, or as the next sibling (directly below the base would cut the
    // base off from its own children). Deferred so Zen's own TabOpen handling
    // (space assignment) and a session restore of this tab ("undo close tab",
    // which hands it its saved values right after creating it) run first.
    queueMicrotask(() => {
      if (savedValue(tab, ATTR_ID)) {
        claim(tab); // A restored tab: its saved place wins over our guess.
        scheduleRender();
        return;
      }
      if (restoring.has(tab) || !isTreeTab(tab) || !isTreeTab(base) || splitOf(tab)) {
        scheduleRender();
        return;
      }
      setState(tab, ATTR_PARENT, parentId);
      const subtree = descendantsOf(baseNode).filter(n => n !== tab);
      const anchor = subtree.at(-1) ?? baseNode;
      if (allTabs().indexOf(tab) !== lastIndex(anchor) + 1) {
        moveOurselves(() => gBrowser.moveTabAfter(tab, anchor));
      }
      if (mode === "child" && isCollapsed(baseNode) && tab.selected) {
        setNodeState(baseNode, ATTR_COLLAPSED, null);
      }
      scheduleRender();
    });
  }

  function on_TabClose(event) {
    if (ready) {
      onTabLeaving(event.target);
    }
    scheduleRender();
  }

  function on_TabMove(event) {
    const tab = event.target;
    if (byUser() && !selfMoving && !drag && !pendingDrop && isTreeTab(tab)) {
      repair(nodeOf(tab));
    }
    scheduleRender();
  }

  function on_TabSelect(event) {
    if (!ready) {
      return;
    }
    on_SpaceMaybeChanged();
    // Selecting a hidden tab (Ctrl+Tab, search, a link) expands its ancestors.
    const ids = idMap();
    const seen = new Set();
    let parent = ids.get(parentIdOf(nodeOf(event.target)));
    let changed = false;
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      if (isCollapsed(parent)) {
        setNodeState(parent, ATTR_COLLAPSED, null);
        changed = true;
      }
      parent = ids.get(parentIdOf(parent));
    }
    if (changed) {
      scheduleRender();
    }
  }

  // Joining a Zen folder takes a tab out of the tree: its children stay
  // where they are (moved up a level). Joining a split keeps its position.
  function on_TabGrouped(event) {
    const tab = event.target;
    if (byUser() && tab.group && !isSplit(tab.group)) {
      onTabLeaving(tab);
      setState(tab, ATTR_PARENT, null);
    }
    scheduleRender();
  }

  // Pinning/unpinning a tab moves it, with its whole subtree, to the top
  // level of the other section's tree. (Drops are handled by applyDrop, and
  // our own pin/unpin calls by whoever made them.) If Zen instead made it an
  // essential or put it in a folder, the children stay and move up a level.
  const sectionMoves = new WeakSet(); // Nodes already handled this round.
  function on_TabPinChanged(event) {
    scheduleRender();
    if (selfMoving || drag || pendingDrop || !byUser()) {
      return;
    }
    const tab = event.target;
    const node = nodeOf(tab);
    if (sectionMoves.has(node)) {
      return; // A split fires this once per tab.
    }
    sectionMoves.add(node);
    const subtree = descendantsOf(node);
    const oldParentId = parentIdOf(node);
    setNodeState(node, ATTR_PARENT, null);
    // Let Zen finish (essentials, folders and splits are sorted out after
    // the pin itself).
    setTimeout(() => {
      sectionMoves.delete(node);
      const now = nodeOf(tab);
      if (isTreeNode(now)) {
        carrySubtree(now, subtree);
      } else {
        for (const child of subtree.filter(n => nodeHasId(node, parentIdOf(n)))) {
          setNodeState(child, ATTR_PARENT, oldParentId);
        }
      }
      log("section change", { pinned: tab.pinned, carried: subtree.length });
      scheduleRender();
    }, 0);
  }

  // A tab's content restored ("undo close tab", or an unloaded tab loading):
  // its saved values win. Never deletes saved values.
  function on_SSTabRestoring(event) {
    const tab = event.target;
    restoring.add(tab);
    if (implicitChildren.has(tab) && !savedValue(tab, ATTR_PARENT)) {
      tab.removeAttribute(ATTR_PARENT); // A guess for a "new tab" it isn't.
    }
    claim(tab, { force: true });
    scheduleRender();
  }

  // Re-read saved values. Safe at any time: every change made through the
  // mod is saved right away, so saved values match what we have.
  function reclaim(tabs = allTabs(), why = "") {
    if (!ready) {
      return;
    }
    for (const tab of tabs) {
      claim(tab, { force: true });
    }
    log("reclaim", why, treeStats());
    scheduleRender();
  }

  // Debug: per space/section, how many tabs have a saved parent, and how
  // many render nested.
  function treeStats() {
    if (!pref("debug", false)) {
      return "";
    }
    const stats = {};
    for (const tab of allTabs()) {
      if (!isTreeTab(tab)) {
        continue;
      }
      const name = gZenWorkspaces.getWorkspaceFromId(spaceOf(tab))?.name ?? "?";
      const key = `${name}${tab.pinned ? " (pinned)" : ""}`;
      const entry = (stats[key] ??= { tabs: 0, savedParent: 0, nested: 0 });
      entry.tabs++;
      entry.savedParent += !!savedValue(tab, ATTR_PARENT);
      entry.nested += depthOf(nodeOf(tab)) > 0;
    }
    return stats;
  }

  // A whole window's session was (re)applied, possibly onto existing tabs.
  const on_SSWindowRestored = () => reclaim(allTabs(), "window restored");

  // Zen sets up the spaces' tabs in its own step after the session restore
  // (AfterWorkspacesSessionRestore), and switching spaces can bring tabs in
  // that weren't settled yet: re-read the space being shown.
  let shownSpace = null;
  function on_SpaceMaybeChanged() {
    const space = gZenWorkspaces.activeWorkspace;
    if (ready && space && space !== shownSpace) {
      shownSpace = space;
      reclaim(allTabs().filter(t => spaceOf(t) === space), "space shown");
    }
  }

  const tabEvents = {
    TabOpen: on_TabOpen,
    TabClose: on_TabClose,
    TabSelect: on_TabSelect,
    TabPinned: on_TabPinChanged,
    TabMove: on_TabMove,
    SSTabRestoring: on_SSTabRestoring,
    TabUnpinned: on_TabPinChanged,
    TabGrouped: on_TabGrouped,
    TabUngrouped: scheduleRender,
  };
  for (const [type, handler] of Object.entries(tabEvents)) {
    listen(gBrowser.tabContainer, type, handler);
  }
  listen(window, "ZenWorkspacesUIUpdate", scheduleRender);
  listen(window, "SSWindowRestored", on_SSWindowRestored);
  listen(window, "AfterWorkspacesSessionRestore", () => reclaim(allTabs(), "spaces restored"));
  listen(window, "ZenWorkspacesUIUpdate", on_SpaceMaybeChanged);
  for (const type of ["mousedown", "keydown", "command", "drop", "contextmenu"]) {
    listen(window, type, event => {
      if (event.isTrusted) {
        lastInput = Date.now();
      }
    }, true);
  }
  // Capture on the window: tabs can be dropped onto space containers, the
  // empty area below the tabs, etc., not only onto the tab strip.
  listen(window, "dragstart", on_dragstart, true);
  listen(window, "dragover", on_dragover, true);
  listen(window, "drop", on_drop, true);
  listen(window, "dragend", on_dragend, true);

  // Capture phase so the twisty click never reaches the tab's own handlers
  // (which would select the tab or start a drag).
  for (const type of ["mousedown", "mouseup", "click"]) {
    listen(
      gBrowser.tabContainer,
      type,
      event => {
        const twisty = event.target.closest?.(".ztt-twisty");
        if (!twisty || event.button !== 0) {
          return;
        }
        const tab = twisty.closest(".tabbrowser-tab");
        if (!tab?.hasAttribute(ATTR_HAS_CHILDREN)) {
          return;
        }
        event.stopPropagation();
        event.preventDefault();
        if (type === "click") {
          toggleCollapsed(nodeOf(tab));
        }
      },
      true
    );
  }

  // Ctrl+Alt+Shift+R: reload this script (and its CSS) without restarting.
  listen(
    window,
    "keydown",
    event => {
      if (event.ctrlKey && event.altKey && event.shiftKey && event.code === "KeyR") {
        event.preventDefault();
        reload();
      }
    },
    true
  );

  // ── Styles ─────────────────────────────────────────────────────────────

  // Loaded from disk as a data: URI so edits apply on reload, never cached.
  let styleURI = null;
  async function loadStyles() {
    const file = chromeFile(STYLE_FILE);
    try {
      const css = await IOUtils.readUTF8(file.path);
      if (signal.aborted) {
        return;
      }
      styleURI = "data:text/css;charset=utf-8," + encodeURIComponent(css);
      window.windowUtils.loadSheetUsingURIString(styleURI, window.windowUtils.AUTHOR_SHEET);
    } catch (e) {
      console.error("[zen-tree-tabs] couldn't load styles from", file.path, e);
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  function destroy() {
    lifetime.abort();
    drag = null;
    endPreview();
    if (styleURI) {
      window.windowUtils.removeSheetUsingURIString(styleURI, window.windowUtils.AUTHOR_SHEET);
      styleURI = null;
    }
    delete window.ZenTreeTabs;
  }

  // The new copy tears this instance down itself once it starts, so if it
  // fails to load (syntax error, bad path) the running version keeps working.
  // Must be a chrome: URL; the subscript loader refuses file: URLs here.
  // The unique query keeps any cache from handing back the old file.
  function reload() {
    const url = `${SCRIPT_URL}?${Date.now()}`;
    try {
      Services.scriptloader.loadSubScriptWithOptions(url, { target: window, ignoreCache: true });
    } catch (e) {
      console.error("[zen-tree-tabs] reload failed, keeping the running version:", e);
    }
  }

  // Console/recovery helper: make `parentTab` the parent of `tab`'s node
  // (null = top level).
  function setParent(tab, parentTab) {
    setNodeState(nodeOf(tab), ATTR_PARENT, parentTab ? nodeId(nodeOf(parentTab)) : null);
    scheduleRender();
  }

  window.ZenTreeTabs = { destroy, reload, render, toggleCollapsed, childrenOf, setParent, rendered };

  for (const old of gBrowser.tabContainer.querySelectorAll(".tab-content > .ztt-twisty")) {
    old.remove();
  }
  document.documentElement.style.setProperty("--ztt-indent", `${INDENT_PX}px`);
  await loadStyles();
  // Startup: the session's tabs (and their saved tree) arrive with the
  // session restore, so only take over once it's done.
  await SessionStore.promiseAllWindowsRestored;
  if (signal.aborted) {
    return;
  }
  for (const tab of allTabs()) {
    claim(tab, { force: true });
  }
  ready = true;
  render();
  shownSpace = gZenWorkspaces.activeWorkspace;
  log("startup", treeStats());
  // Catch anything Zen settles late (spaces, sync).
  for (const delay of [1000, 5000]) {
    setTimeout(() => !signal.aborted && reclaim(allTabs(), `startup +${delay}ms`), delay);
  }

  // Always printed, so it's obvious which version of the file is running.
  try {
    const { lastModified } = await IOUtils.stat(chromeFile(SCRIPT_FILE).path);
    console.log(`[zen-tree-tabs] loaded, script saved ${new Date(lastModified).toLocaleString()}`);
  } catch (e) {
    console.log("[zen-tree-tabs] loaded");
  }
})();
